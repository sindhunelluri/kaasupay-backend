
const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { z } = require("zod");

const {
    Wallet,
    BankAccount,
    Withdrawal,
    Transaction,
    LedgerEntry,
    IdempotencyRecord,
    OutboxEvent
} = require("../db");

const authMiddleware = require("../middleware/auth");
const { verifyPaymentPin } = require("../services/paymentPin");
const router = express.Router();
const WITHDRAWALS_PAUSED = false; // Set to true to pause withdrawals temporarily

const withdrawSchema = z.object({
    bankAccountId: z.string().regex(/^[a-f\d]{24}$/i),
    amount: z.number().int().min(10000).max(2500000),
    pin: z.string().regex(/^\d{4,6}$/)
});

// POST /api/v1/wallet/withdraw
router.post("/", authMiddleware, async (req, res) => {
    if (WITHDRAWALS_PAUSED) {
        return res.status(503).json({
            error: "Withdrawals are temporarily paused. Please try again later."
        });
}
    const key = req.get("Idempotency-Key");

    if (!key || !key.trim() || key.length > 200) {
        return res.status(400).json({
            error: "A valid Idempotency-Key header is required"
        });
    }

    const result = withdrawSchema.safeParse(req.body || {});

    if (!result.success) {
        return res.status(400).json({
            error: result.error.issues[0].message
        });
    }

    const { bankAccountId, amount, pin } = result.data;

// Verify the payment PIN before processing the withdrawal.

let pinResult;

try {
    pinResult = await verifyPaymentPin(req.userId, pin);
} catch (error) {
    console.error("Withdrawal PIN verification error:", error.message);

    return res.status(500).json({
        error: "Could not verify payment PIN"
    });
}

if (!pinResult.ok) {
    if (pinResult.status === "PIN_NOT_SET") {
        return res.status(400).json({
            error: "Set your payment PIN first"
        });
    }

    if (pinResult.status === "PIN_LOCKED") {
        return res.status(423).json({
            error: "Payment PIN is temporarily locked",
            retryAfterSeconds: pinResult.retryAfterSeconds
        });
    }

    if (pinResult.status === "PIN_RETRY") {
        return res.status(409).json({
            error: "PIN verification conflicted with another request. Try again."
        });
    }

    return res.status(401).json({
        error: "Incorrect payment PIN",
        attemptsRemaining: pinResult.attemptsRemaining
    });
}

const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ bankAccountId, amount }))
    .digest("hex");

let record;

    try {
        try {
            [record] = await IdempotencyRecord.create([{
                userId: req.userId,
                key,
                requestHash,
                status: "IN_PROGRESS"
            }]);
        } catch (error) {
            if (error.code !== 11000) throw error;

            const existing = await IdempotencyRecord.findOne({
                userId: req.userId,
                key
            });

            if (!existing) throw error;

            if (existing.requestHash !== requestHash) {
                return res.status(422).json({
                    error: "Idempotency key was used with a different request"
                });
            }

            if (existing.status === "DONE") {
                return res
                    .status(existing.response.httpStatus)
                    .json(existing.response.body);
            }

            return res.status(409).json({
                error: "A request with this idempotency key is in progress"
            });
        }

        const bankAccount = await BankAccount.findOne({
            _id: bankAccountId,
            userId: req.userId
        });

        if (!bankAccount) {
            const error = new Error("Bank account not found");
            error.status = 404;
            throw error;
        }

        const session = await mongoose.startSession();
        let responseData;

        try {
            await session.withTransaction(async () => {
                // Atomically debit only when sufficient funds exist.
                const wallet = await Wallet.findOneAndUpdate(
                    {
                        userId: req.userId,
                        balance: { $gte: amount }
                    },
                    { $inc: { balance: -amount } },
                    { returnDocument: "after", session }
                );

                if (!wallet) {
                    const error = new Error("Insufficient wallet balance");
                    error.status = 400;
                    throw error;
                }

                const [withdrawal] = await Withdrawal.create([{
                    userId: req.userId,
                    bankAccountId: bankAccount._id,
                    amount,
                    reference: `wd_${new mongoose.Types.ObjectId()}`,
                    status: "PENDING"
                }], { session });

                const [transaction] = await Transaction.create([{
                    type: "WITHDRAWAL",
                    fromUserId: req.userId,
                    toUserId: null,
                    amount,
                    note: "Withdrawal to bank",
                    status: "SUCCESS"
                }], { session });

                await LedgerEntry.create([{
                    userId: req.userId,
                    transactionId: transaction._id,
                    direction: "DEBIT",
                    amount,
                    balanceAfter: wallet.balance
                }], { session });

                await OutboxEvent.create([{
                    type: "PAYOUT_REQUESTED",
                    withdrawalId: withdrawal._id,
                    status: "NEW",
                    attempts: 0,
                    nextAttemptAt: new Date()
                }], { session });

                responseData = {
                    message: "Withdrawal accepted for processing",
                    withdrawal: {
                        id: withdrawal._id,
                        reference: withdrawal.reference,
                        amount: withdrawal.amount,
                        status: withdrawal.status
                    },
                    walletBalance: wallet.balance
                };

                const updated = await IdempotencyRecord.updateOne(
                    { _id: record._id, status: "IN_PROGRESS" },
                    {
                        $set: {
                            status: "DONE",
                            response: {
                                httpStatus: 202,
                                body: responseData
                            }
                        }
                    },
                    { session }
                );

                if (updated.modifiedCount !== 1) {
                    throw new Error("Could not save idempotency response");
                }
            });
        } finally {
            await session.endSession();
        }

        return res.status(202).json(responseData);
    } catch (error) {
        console.error("Withdrawal request error:", error.message);

        if (record && [400, 404].includes(error.status)) {
            const body = { error: error.message };

            try {
                await IdempotencyRecord.updateOne(
                    { _id: record._id, status: "IN_PROGRESS" },
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
                    "Could not save withdrawal response:",
                    saveError.message
                );
            }
        }

        if (record) {
            await IdempotencyRecord.deleteOne({
                _id: record._id,
                status: "IN_PROGRESS"
            }).catch(cleanupError => {
                console.error("Idempotency cleanup error:", cleanupError.message);
            });
        }

        return res.status(500).json({
            error: "Withdrawal request failed"
        });
    }
});


/**
 * GET /api/v1/wallet/withdraw
 * Return the signed-in user's 20 most recent withdrawals.
 */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({
            userId: req.userId
        })
            .sort({ createdAt: -1 })
            .limit(20)
            .select(
                "reference amount status bankRef failureReason createdAt updatedAt"
            )
            .lean();

        return res.json({
            withdrawals
        });
    } catch (error) {
        console.error("Withdrawal history error:", error.message);

        return res.status(500).json({
            error: "Could not retrieve withdrawal history"
        });
    }
});

/**
 * GET /api/v1/wallet/withdraw/:id
 * Return one withdrawal only if it belongs to the signed-in user.
 */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({
                error: "Withdrawal not found"
            });
        }

        const withdrawal = await Withdrawal.findOne({
            _id: req.params.id,
            userId: req.userId
        })
            .select(
                "reference amount status bankRef failureReason createdAt updatedAt"
            )
            .lean();

        if (!withdrawal) {
            return res.status(404).json({
                error: "Withdrawal not found"
            });
        }

        return res.json({
            withdrawal
        });
    } catch (error) {
        console.error("Withdrawal details error:", error.message);

        return res.status(500).json({
            error: "Could not retrieve withdrawal details"
        });
    }
});


module.exports = router;
