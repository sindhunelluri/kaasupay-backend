const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");
const { User, Wallet, Transaction, LedgerEntry } = require("../db");

const router = express.Router();

// Validate the deposit request
const depositSchema = z.object({
    to: z.string().trim().toLowerCase().email(),
    amount: z.number().int().min(100).max(10000000),
    note: z.string().trim().max(50).optional()
});

// Protect admin routes using the staff key
function adminMiddleware(req, res, next) {
    const adminKey = process.env.ADMIN_KEY;
    const providedKey = req.get("x-admin-key");

    if (!adminKey) {
        console.error("ADMIN_KEY is missing from environment variables");
        return res.status(500).json({ error: "Admin access is not configured" });
    }

    if (!providedKey || providedKey !== adminKey) {
        return res.status(401).json({ error: "Invalid or missing admin key" });
    }

    next();
}

// POST /api/v1/admin/users/:id/unlock-pin  (staff only)
router.post("/users/:id/unlock-pin", adminMiddleware, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: "Invalid user id" });
    }

    const result = await User.updateOne(
        { _id: req.params.id },
        { $set: { pinFailedAttempts: 0, pinLockedUntil: null } }
    );

    if (result.matchedCount === 0) {
        return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({ message: "PIN unlocked" });
});

// POST /api/v1/admin/deposit
router.post("/deposit", adminMiddleware, async (req, res) => {
    const result = depositSchema.safeParse(req.body);

    if (!result.success) {
        const issue = result.error.issues[0];
        return res.status(400).json({
            error: `${issue.path[0] || "body"}: ${issue.message}`
        });
    }

    const { to, amount, note } = result.data;
    const cleanNote = note || "Bank deposit";

    try {
        const user = await User.findOne({ username: to });

        if (!user) {
            return res.status(404).json({ error: "Recipient user not found" });
        }

        const session = await mongoose.startSession();
        let responseData;

        try {
            await session.withTransaction(async () => {
                // Increase the wallet balance atomically
                const wallet = await Wallet.findOneAndUpdate(
                    { userId: user._id },
                    { $inc: { balance: amount } },
                    { returnDocument: 'after', session }
                );

                if (!wallet) {
                    const error = new Error("Wallet not found for recipient");
                    error.status = 404;
                    throw error;
                }

                // Record the deposit transaction
                const [transaction] = await Transaction.create(
                    [{
                        type: "DEPOSIT",
                        fromUserId: null,
                        toUserId: user._id,
                        amount,
                        note: cleanNote,
                        status: "SUCCESS"
                    }],
                    { session }
                );

                // Record the wallet credit in the ledger
                await LedgerEntry.create(
                    [{
                        userId: user._id,
                        transactionId: transaction._id,
                        direction: "CREDIT",
                        amount,
                        balanceAfter: wallet.balance
                    }],
                    { session }
                );

                responseData = {
                    message: "Deposit successful",
                    transactionId: transaction._id,
                    recipient: user.username,
                    amount,
                    balance: wallet.balance,
                    note: cleanNote
                };
            });
        } finally {
            await session.endSession();
        }

        return res.status(201).json(responseData);
    } catch (error) {
        console.error("Deposit error:", error.message);

        if (error.status === 404) {
            return res.status(404).json({ error: error.message });
        }

        return res.status(500).json({ error: "Deposit failed" });
    }
});



router.get("/reconcile", adminMiddleware, async (req, res) => {
    try {
        // Get all wallets and their owners
        const wallets = await Wallet.find()
            .populate("userId", "username");

        // Calculate total credits and debits for each user
        const ledgerSummary = await LedgerEntry.aggregate([
            {
                $group: {
                    _id: "$userId",
                    totalCredits: {
                        $sum: {
                            $cond: [
                                { $eq: ["$direction", "CREDIT"] },
                                "$amount",
                                0
                            ]
                        }
                    },
                    totalDebits: {
                        $sum: {
                            $cond: [
                                { $eq: ["$direction", "DEBIT"] },
                                "$amount",
                                0
                            ]
                        }
                    }
                }
            }
        ]);

        const ledgerMap = new Map(
            ledgerSummary.map(entry => [
                entry._id.toString(),
                entry
            ])
        );

        const discrepancies = [];

        let totalWalletBalance = 0;
        let totalLedgerNetBalance = 0;

        for (const wallet of wallets) {
            const userId = wallet.userId?._id.toString();
            const username = wallet.userId?.username || "Unknown user";

            const ledger = ledgerMap.get(userId);

            const credits = ledger?.totalCredits || 0;
            const debits = ledger?.totalDebits || 0;
            const ledgerBalance = credits - debits;

            totalWalletBalance += wallet.balance;
            totalLedgerNetBalance += ledgerBalance;

            if (wallet.balance !== ledgerBalance) {
                discrepancies.push({
                    userId,
                    username,
                    walletBalance: wallet.balance,
                    ledgerBalance,
                    difference: wallet.balance - ledgerBalance
                });
            }
        }

        
        // Calculate total bank deposits and Razorpay top-ups
        const creditResult = await Transaction.aggregate([
            { $match: { type: { $in: ["DEPOSIT", "TOPUP"] } } },
            {
                $group: {
                    _id: null,
                    totalCredits: { $sum: "$amount" }
                }
            }
        ]);

        const totalDepositsAndTopUps =
            creditResult[0]?.totalCredits || 0;

        const walletLedgerConsistent = discrepancies.length === 0;
        const creditsConsistent =
            totalLedgerNetBalance === totalDepositsAndTopUps;


        return res.status(200).json({
            message: "Reconciliation completed",
            summary: {
                totalWalletBalance,
                totalLedgerNetBalance,
                totalDepositsAndTopUps,
                walletLedgerConsistent,
                creditsConsistent,
                overallConsistent:
                    walletLedgerConsistent && creditsConsistent
            },
            discrepancies
        });
    } catch (error) {
        console.error("Reconciliation error:", error.message);

        return res.status(500).json({
            error: "Reconciliation failed"
        });
    }
});


module.exports = router;
