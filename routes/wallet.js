
const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { z } = require("zod");
const Razorpay = require("razorpay");
const { getIndiaDayKey } = require("../utils/indiaDate");
const {
    ensureDailyCounter,
    reserveDailyLimit,
    getDailyUsage
} = require("../services/dailyLimit");
const { rateLimit, byUser } = require("../middleware/rateLimit");
const {
    User,
    Wallet,
    Transaction,
    LedgerEntry,
    IdempotencyRecord,
    PaymentOrder,
    BankAccount,
    DailyTransferLimit
} = require("../db");

const authMiddleware = require("../middleware/auth");
const { verifyPaymentPin, sendPinFailure } = require("../services/paymentPin");

const router = express.Router();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Transfers and withdrawals share ONE money rate limit: 10 per minute per user.
const moneyLimit = rateLimit({ name: "money", max: 10, windowSeconds: 60, keyFrom: byUser });


function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

// --------------------------------------------------
// ADD MONEY: CREATE RAZORPAY ORDER
// --------------------------------------------------

router.post("/add-money/order", authMiddleware, async (req, res) => {
    try {
        const amountSchema = z.number().int().min(1000).max(1000000);
        const result = amountSchema.safeParse(req.body?.amount);

        if (!result.success) {
            return res.status(400).json({
                error: "Amount must be a whole number of paise between 1000 and 1000000."
            });
        }

        const razorpayOrder = await razorpay.orders.create({
            amount: result.data,
            currency: "INR",
            receipt: `kp_${Date.now()}`
        });

        await PaymentOrder.create({
            userId: req.userId,
            gatewayOrderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            status: "CREATED"
        });

        return res.status(201).json({
            orderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            keyId: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error("Create Razorpay order error:", error.message);

        return res.status(500).json({
            error: "Unable to create payment order. Please try again."
        });
    }
});

// --------------------------------------------------
// ADD MONEY: VERIFY PAYMENT
// --------------------------------------------------

router.post("/add-money/verify", authMiddleware, async (req, res) => {
    const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
    } = req.body || {};

    if (
        typeof razorpay_order_id !== "string" ||
        typeof razorpay_payment_id !== "string" ||
        typeof razorpay_signature !== "string" ||
        !/^order_[A-Za-z0-9]+$/.test(razorpay_order_id) ||
        !/^pay_[A-Za-z0-9]+$/.test(razorpay_payment_id) ||
        !/^[a-f0-9]{64}$/i.test(razorpay_signature)
    ) {
        return res.status(400).json({
            error: "Invalid payment verification details"
        });
    }

    let session;

    try {
        const paymentOrder = await PaymentOrder.findOne({
            gatewayOrderId: razorpay_order_id,
            userId: req.userId
        });

        if (!paymentOrder) {
            return res.status(404).json({
                error: "Payment order not found"
            });
        }

        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "hex");
        const receivedBuffer = Buffer.from(razorpay_signature, "hex");

        if (
            expectedBuffer.length !== receivedBuffer.length ||
            !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
        ) {
            return res.status(400).json({
                error: "Payment signature verification failed"
            });
        }

        const payment = await razorpay.payments.fetch(
            razorpay_payment_id
        );

        if (
            payment.order_id !== paymentOrder.gatewayOrderId ||
            payment.amount !== paymentOrder.amount ||
            payment.currency !== paymentOrder.currency
        ) {
            return res.status(400).json({
                error: "Payment details do not match the order"
            });
        }

        if (payment.status !== "captured") {
            return res.status(409).json({
                error: "Payment is not captured yet. Wallet was not credited."
            });
        }

        session = await mongoose.startSession();

        let responseData;

        await session.withTransaction(async () => {
            const currentOrder = await PaymentOrder.findOne({
                _id: paymentOrder._id,
                userId: req.userId
            }).session(session);

            if (!currentOrder) {
                throw createHttpError(404, "Payment order not found");
            }

            if (currentOrder.status === "PAID") {
                if (
                    currentOrder.gatewayPaymentId === razorpay_payment_id
                ) {
                    responseData = {
                        message: "Payment already verified",
                        transactionId: currentOrder.transactionId,
                        amount: currentOrder.amount,
                        currency: currentOrder.currency
                    };
                    return;
                }

                throw createHttpError(
                    409,
                    "This order has already been paid"
                );
            }

            if (currentOrder.status !== "CREATED") {
                throw createHttpError(
                    409,
                    "This payment order cannot be processed"
                );
            }

            const claimedOrder = await PaymentOrder.findOneAndUpdate(
                {
                    _id: currentOrder._id,
                    status: "CREATED"
                },
                {
                    $set: {
                        status: "PAID",
                        gatewayPaymentId: razorpay_payment_id,
                        paidVia: "CALLBACK"
                    }
                },
                {
                    returnDocument: "after",
                    session
                }
            );

            if (!claimedOrder) {
                throw createHttpError(
                    409,
                    "Payment order is already being processed"
                );
            }

            const wallet = await Wallet.findOneAndUpdate(
                { userId: req.userId },
                { $inc: { balance: claimedOrder.amount } },
                {
                    returnDocument: "after",
                    session
                }
            );

            if (!wallet) {
                throw new Error("Wallet not found");
            }

            const [transaction] = await Transaction.create([{
                type: "TOPUP",
                fromUserId: null,
                toUserId: req.userId,
                amount: claimedOrder.amount,
                note: "Razorpay wallet top-up",
                status: "SUCCESS"
            }], { session });

            await LedgerEntry.create([{
                userId: req.userId,
                transactionId: transaction._id,
                direction: "CREDIT",
                amount: claimedOrder.amount,
                balanceAfter: wallet.balance
            }], { session });

            await PaymentOrder.updateOne(
                { _id: claimedOrder._id },
                { $set: { transactionId: transaction._id } },
                { session }
            );

            responseData = {
                message: "Payment verified and wallet credited successfully",
                transactionId: transaction._id,
                amount: claimedOrder.amount,
                currency: claimedOrder.currency,
                walletBalance: wallet.balance
            };
        });

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("Payment verification error:", error.message);

        if (error.status) {
            return res.status(error.status).json({
                error: error.message
            });
        }

        return res.status(500).json({
            error: "Payment verification failed. Check payment status before retrying."
        });
    } finally {
        if (session) {
            await session.endSession();
        }
    }
});

// --------------------------------------------------
// TRANSFER VALIDATION
// --------------------------------------------------

const transferSchema = z.object({
    to: z.string().trim().toLowerCase().email(),
    amount: z.number().int().min(100).max(1000000),
    note: z.string().trim().max(50).optional(),
    pin: z.string().regex(/^\d{4,6}$/, "Enter a valid payment PIN")
});

// --------------------------------------------------
// TRANSFER MONEY WITH PAYMENT PIN AND DAILY LIMIT
// --------------------------------------------------

router.post("/transfer", authMiddleware, moneyLimit, async (req, res) => {
    const key = req.get("Idempotency-Key");

    if (
        typeof key !== "string" ||
        !key.trim() ||
        key.length > 200
    ) {
        return res.status(400).json({
            error: "A valid Idempotency-Key header is required"
        });
    }

    const result = transferSchema.safeParse(req.body);

    if (!result.success) {
        const issue = result.error.issues[0];

        return res.status(400).json({
            error: `${issue.path[0] || "body"}: ${issue.message}`
        });
    }

    let pinResult;

    try {
        pinResult = await verifyPaymentPin(
            req.userId,
            result.data.pin
        );
    } catch (error) {
        console.error("Payment PIN verification error:", error.message);

        return res.status(500).json({
            error: "Payment PIN verification failed. Please try again."
        });
    }

    if (sendPinFailure(res, pinResult)) return;

    const { to, amount, note } = result.data;
    const cleanNote = note || "Wallet transfer";

    // Do not include the PIN in the idempotency request hash.
    const requestHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({
            to,
            amount,
            note: cleanNote
        }))
        .digest("hex");

    let record;

    try {
        // Reserve the idempotency key before any money movement.
        try {
            [record] = await IdempotencyRecord.create([{
                userId: req.userId,
                key: key.trim(),
                requestHash,
                status: "IN_PROGRESS"
            }]);
        } catch (error) {
            if (error.code !== 11000) {
                throw error;
            }

            const existing = await IdempotencyRecord.findOne({
                userId: req.userId,
                key: key.trim()
            });

            if (!existing) {
                throw error;
            }

            if (existing.requestHash !== requestHash) {
                return res.status(422).json({
                    error: "Idempotency key was already used with a different request"
                });
            }

            if (existing.status === "DONE" && existing.response) {
                return res
                    .status(existing.response.httpStatus)
                    .json(existing.response.body);
            }

            return res.status(409).json({
                error: "A request with this idempotency key is in progress"
            });
        }

        const sender = await User.findById(req.userId);

        if (!sender) {
            throw createHttpError(404, "Sender not found");
        }

        const receiver = await User.findOne({ username: to });

        if (!receiver) {
            throw createHttpError(404, "Recipient user not found");
        }

        if (sender._id.equals(receiver._id)) {
            throw createHttpError(
                400,
                "You cannot transfer money to yourself"
            );
        }

        // Make sure today's counter exists (outside the transaction).
        await ensureDailyCounter(sender._id);

        const session = await mongoose.startSession();
        let responseData;

        try {
            await session.withTransaction(async () => {
                // Daily limit: add to today's counter only if it still fits.
                // It lives in this transaction, so a failure below rolls it back.
                await reserveDailyLimit(sender._id, amount, session);

                // Debit the sender only if their balance is sufficient.
                const senderWallet = await Wallet.findOneAndUpdate(
                    {
                        userId: sender._id,
                        balance: { $gte: amount }
                    },
                    {
                        $inc: { balance: -amount }
                    },
                    {
                        returnDocument: "after",
                        session
                    }
                );

                if (!senderWallet) {
                    throw createHttpError(
                        400,
                        "Insufficient balance"
                    );
                }

                const receiverWallet = await Wallet.findOneAndUpdate(
                    { userId: receiver._id },
                    {
                        $inc: { balance: amount }
                    },
                    {
                        returnDocument: "after",
                        session
                    }
                );

                if (!receiverWallet) {
                    throw createHttpError(
                        404,
                        "Recipient wallet not found"
                    );
                }

                const [transaction] = await Transaction.create([{
                    type: "TRANSFER",
                    fromUserId: sender._id,
                    toUserId: receiver._id,
                    amount,
                    note: cleanNote,
                    status: "SUCCESS"
                }], { session });

                await LedgerEntry.create([{
                    userId: sender._id,
                    transactionId: transaction._id,
                    direction: "DEBIT",
                    amount,
                    balanceAfter: senderWallet.balance
                }], { session });

                await LedgerEntry.create([{
                    userId: receiver._id,
                    transactionId: transaction._id,
                    direction: "CREDIT",
                    amount,
                    balanceAfter: receiverWallet.balance
                }], { session });

                responseData = {
                    message: "Transfer successful",
                    transactionId: transaction._id,
                    from: sender.username,
                    to: receiver.username,
                    amount,
                    senderBalance: senderWallet.balance,
                    receiverBalance: receiverWallet.balance,
                    note: cleanNote
                };

                // Save the success response in the same transaction.
                const updated = await IdempotencyRecord.updateOne(
                    {
                        _id: record._id,
                        status: "IN_PROGRESS"
                    },
                    {
                        $set: {
                            status: "DONE",
                            response: {
                                httpStatus: 200,
                                body: responseData
                            }
                        }
                    },
                    { session }
                );

                if (updated.modifiedCount !== 1) {
                    throw new Error(
                        "Could not save idempotency response"
                    );
                }
            });
        } finally {
            await session.endSession();
        }

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("Transfer error:", error.message);

        // Save expected business errors so the same idempotency key
        // receives the same response on retry.
        if (
            record &&
            [400, 404, 429].includes(error.status)
        ) {
            const body = {
                error: error.message,
                message: error.message,
                ...(error.extra || {})
            };

            try {
                await IdempotencyRecord.updateOne(
                    {
                        _id: record._id,
                        status: "IN_PROGRESS"
                    },
                    {
                        $set: {
                            status: "DONE",
                            response: {
                                httpStatus: error.status,
                                body
                            }
                        }
                    }
                );

                return res.status(error.status).json(body);
            } catch (saveError) {
                console.error(
                    "Could not save error response:",
                    saveError.message
                );
            }
        }

        // If this was a transient or unexpected error, release the
        // idempotency key so the request can be retried.
        if (record) {
            try {
                await IdempotencyRecord.deleteOne({
                    _id: record._id,
                    status: "IN_PROGRESS"
                });
            } catch (cleanupError) {
                console.error(
                    "Cleanup error:",
                    cleanupError.message
                );
            }
        }

        return res.status(500).json({
            error: "Transfer failed"
        });
    }
});

// --------------------------------------------------
// TRANSACTION HISTORY
// --------------------------------------------------

router.get("/limits", authMiddleware, async (req, res) => {
    try {
        return res.status(200).json(await getDailyUsage(req.userId));
    } catch (error) {
        console.error("Limits error:", error.message);
        return res.status(500).json({ error: "Could not load limits" });
    }
});

router.get("/transactions", authMiddleware, async (req, res) => {
    try {
        const page = Number(req.query.page || 1);
        const limit = Number(req.query.limit || 10);

        if (
            !Number.isInteger(page) ||
            !Number.isInteger(limit) ||
            page < 1 ||
            limit < 1 ||
            limit > 50
        ) {
            return res.status(400).json({
                error: "Page must be positive and limit must be between 1 and 50"
            });
        }

        const filter = {
            $or: [
                { fromUserId: req.userId },
                { toUserId: req.userId }
            ]
        };

        const total = await Transaction.countDocuments(filter);

        const transactions = await Transaction.find(filter)
            .populate("fromUserId", "username firstName lastName")
            .populate("toUserId", "username firstName lastName")
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);

        const formattedTransactions = transactions.map(transaction => {
            const item = transaction.toObject();

            switch (item.type) {
                case "WITHDRAWAL":
                    item.withWhom = "Withdrawal to bank";
                    break;

                case "REVERSAL":
                    item.withWhom = "Refund of failed withdrawal";
                    break;

                case "TOPUP":
                case "DEPOSIT":
                    item.withWhom = "Money added to wallet";
                    break;

                case "TRANSFER":
                    if (
                        item.fromUserId?._id?.toString() ===
                        req.userId.toString()
                    ) {
                        item.withWhom = item.toUserId
                            ? `Transfer to ${item.toUserId.username}`
                            : "Wallet transfer";
                    } else {
                        item.withWhom = item.fromUserId
                            ? `Transfer from ${item.fromUserId.username}`
                            : "Wallet transfer";
                    }
                    break;

                default:
                    item.withWhom = item.note || item.type;
            }

            return item;
        });

        return res.status(200).json({
            message: "Transaction history retrieved successfully",
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            },
            transactions: formattedTransactions
        });
    } catch (error) {
        console.error("Transaction history error:", error.message);

        return res.status(500).json({
            error: "Failed to retrieve transaction history"
        });
    }
});

// --------------------------------------------------
// WALLET BALANCE
// --------------------------------------------------

router.get("/balance", authMiddleware, async (req, res) => {
    try {
        const wallet = await Wallet.findOne({
            userId: req.userId
        });

        if (!wallet) {
            return res.status(404).json({
                error: "Wallet not found"
            });
        }

        return res.status(200).json({
            message: "Wallet balance retrieved successfully",
            balance: wallet.balance,
            currency: "INR",
            balanceInRupees: wallet.balance / 100
        });
    } catch (error) {
        console.error("Wallet balance error:", error.message);

        return res.status(500).json({
            error: "Failed to retrieve wallet balance"
        });
    }
});

// --------------------------------------------------
// RAZORPAY ORDER STATUS
// --------------------------------------------------

router.get("/add-money/orders/:orderId", authMiddleware, async (req, res) => {
    try {
        const order = await PaymentOrder.findOne({
            _id: req.params.orderId,
            userId: req.userId
        }).select(
            "gatewayOrderId amount currency status gatewayPaymentId paidVia transactionId createdAt updatedAt"
        );

        if (!order) {
            return res.status(404).json({
                error: "Payment order not found"
            });
        }

        const wallet = await Wallet.findOne({
            userId: req.userId
        }).select("balance");

        return res.status(200).json({
            message: "Payment order status retrieved successfully",
            order: {
                id: order._id,
                orderId: order.gatewayOrderId,
                amount: order.amount,
                currency: order.currency,
                status: order.status,
                paymentId: order.gatewayPaymentId,
                paidVia: order.paidVia,
                transactionId: order.transactionId,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt
            },
            walletBalance: wallet ? wallet.balance : null
        });
    } catch (error) {
        console.error("Payment order status error:", error.message);

        return res.status(500).json({
            error: "Failed to retrieve payment order status"
        });
    }
});

// --------------------------------------------------
// BANK ACCOUNTS
// --------------------------------------------------

const bankAccountSchema = z.object({
    holderName: z.string().trim().min(2).max(60),
    accountNumber: z.string().regex(
        /^\d{9,18}$/,
        "Account number must contain 9–18 digits"
    ),
    ifsc: z.string().trim().toUpperCase().regex(
        /^[A-Z]{4}0[A-Z0-9]{6}$/,
        "Invalid IFSC code"
    )
});

function maskAccountNumber(last4) {
    return `XXXXXX${last4}`;
}

router.post("/bank-accounts", authMiddleware, async (req, res) => {
    const result = bankAccountSchema.safeParse(req.body || {});

    if (!result.success) {
        return res.status(400).json({
            error: result.error.issues[0].message
        });
    }

    const { holderName, accountNumber, ifsc } = result.data;

    try {
        const existing = await BankAccount.findOne({
            userId: req.userId,
            accountNumber
        });

        if (existing) {
            return res.status(409).json({
                error: "This bank account is already registered"
            });
        }

        const account = await BankAccount.create({
            userId: req.userId,
            holderName,
            accountNumber,
            ifsc,
            last4: accountNumber.slice(-4)
        });

        return res.status(201).json({
            message: "Bank account registered successfully",
            bankAccount: {
                id: account._id,
                holderName: account.holderName,
                accountNumber: maskAccountNumber(account.last4),
                ifsc: account.ifsc,
                createdAt: account.createdAt
            }
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({
                error: "This bank account is already registered"
            });
        }

        console.error("Register bank account error:", error.message);

        return res.status(500).json({
            error: "Failed to register bank account"
        });
    }
});

router.get("/bank-accounts", authMiddleware, async (req, res) => {
    try {
        const accounts = await BankAccount.find({
            userId: req.userId
        })
            .select("holderName last4 ifsc createdAt")
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({
            bankAccounts: accounts.map(account => ({
                id: account._id,
                holderName: account.holderName,
                accountNumber: maskAccountNumber(account.last4),
                ifsc: account.ifsc,
                createdAt: account.createdAt
            }))
        });
    } catch (error) {
        console.error("List bank accounts error:", error.message);

        return res.status(500).json({
            error: "Failed to retrieve bank accounts"
        });
    }
});

// --------------------------------------------------
// WALLET RECONCILIATION
// --------------------------------------------------

router.get("/reconciliation", authMiddleware, async (req, res) => {
    try {
        const wallet = await Wallet.findOne({
            userId: req.userId
        }).select("balance");

        if (!wallet) {
            return res.status(404).json({
                error: "Wallet not found"
            });
        }

        const entries = await LedgerEntry.find({
            userId: req.userId
        }).select("direction amount");

        let credits = 0;
        let debits = 0;

        for (const entry of entries) {
            if (entry.direction === "CREDIT") {
                credits += entry.amount;
            } else if (entry.direction === "DEBIT") {
                debits += entry.amount;
            }
        }

        const ledgerBalance = credits - debits;
        const difference = wallet.balance - ledgerBalance;

        return res.status(200).json({
            message: "Wallet reconciliation completed",
            walletBalance: wallet.balance,
            totalCredits: credits,
            totalDebits: debits,
            ledgerBalance,
            difference,
            moneyIsConserved: difference === 0,
            ledgerEntries: entries.length,
            currency: "INR",
            amountsInPaise: true
        });
    } catch (error) {
        console.error("Reconciliation error:", error.message);

        return res.status(500).json({
            error: "Wallet reconciliation failed"
        });
    }
});

module.exports = router;