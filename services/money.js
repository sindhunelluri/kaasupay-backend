
const mongoose = require("mongoose");
const {
    Wallet,
    Withdrawal,
    Transaction,
    LedgerEntry,
    OutboxEvent
} = require("../db");

/**
 * Refund a withdrawal only after the bank has definitively
 * confirmed that the payout failed permanently.
 *
 * All wallet and ledger changes happen in one MongoDB transaction.
 */
async function reverseWithdrawal(withdrawalId, reason) {
    const session = await mongoose.startSession();

    try {
        let result;

        await session.withTransaction(async () => {
            // Claim the reversal once. Concurrent attempts cannot
            // reverse the same withdrawal twice.
            const withdrawal = await Withdrawal.findOneAndUpdate(
                {
                    _id: withdrawalId,
                    status: { $in: ["PENDING", "PROCESSING"] }
                },
                {
                    $set: {
                        status: "REVERSED",
                        failureReason: reason
                    }
                },
                {
                    new: true,
                    session
                }
            );

            if (!withdrawal) {
                const current = await Withdrawal.findById(
                    withdrawalId
                ).session(session);

                if (!current) {
                    throw new Error("Withdrawal not found");
                }

                // A previous successful reversal is safe to repeat.
                if (current.status === "REVERSED") {
                    result = {
                        alreadyReversed: true,
                        withdrawalId: current._id
                    };
                    return;
                }

                throw new Error(
                    `Withdrawal cannot be reversed from status ${current.status}`
                );
            }

            const wallet = await Wallet.findOneAndUpdate(
                { userId: withdrawal.userId },
                { $inc: { balance: withdrawal.amount } },
                {
                    returnDocument: "after",
                    session
                }
            );

            if (!wallet) {
                throw new Error("Wallet not found during refund");
            }

            const [transaction] = await Transaction.create(
                [{
                    type: "REVERSAL",
                    fromUserId: null,
                    toUserId: withdrawal.userId,
                    amount: withdrawal.amount,
                    note: "Refund of failed withdrawal",
                    status: "SUCCESS"
                }],
                { session }
            );

            await LedgerEntry.create(
                [{
                    userId: withdrawal.userId,
                    transactionId: transaction._id,
                    direction: "CREDIT",
                    amount: withdrawal.amount,
                    balanceAfter: wallet.balance
                }],
                { session }
            );

            // Complete the associated job in the same transaction.
            await OutboxEvent.updateOne(
                {
                    withdrawalId: withdrawal._id,
                    status: { $in: ["NEW", "PROCESSING"] }
                },
                {
                    $set: {
                        status: "DONE",
                        lockedAt: null,
                        lastError: reason
                    }
                },
                { session }
            );

            result = {
                alreadyReversed: false,
                withdrawalId: withdrawal._id,
                refundAmount: withdrawal.amount,
                walletBalance: wallet.balance
            };
        });

        return result;
    } finally {
        await session.endSession();
    }
}

module.exports = { reverseWithdrawal };
