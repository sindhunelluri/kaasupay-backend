const mongoose = require("mongoose");

const {
    Wallet,
    Withdrawal,
    Transaction,
    LedgerEntry,
    OutboxEvent
} = require("../db");

/**
 * Reverse a withdrawal only after a permanent payout failure
 * has been definitively confirmed by the bank.
 *
 * The withdrawal, original transaction, wallet refund, ledger
 * entry, and outbox update are handled atomically.
 */
async function reverseWithdrawal(withdrawalId, reason) {
    const session = await mongoose.startSession();

    try {
        let result;

        await session.withTransaction(async () => {
            const withdrawal = await Withdrawal.findOneAndUpdate(
                {
                    _id: withdrawalId,
                    status: {
                        $in: ["PENDING", "PROCESSING"]
                    }
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

            // Never issue a refund if the original transaction
            // cannot be identified and updated.
            if (!withdrawal.transactionId) {
                throw new Error(
                    "Withdrawal has no linked transaction; manual review required"
                );
            }

            const transactionUpdate = await Transaction.updateOne(
                {
                    _id: withdrawal.transactionId,
                    type: "WITHDRAWAL",
                    status: {
                        $in: ["PENDING", "PROCESSING"]
                    }
                },
                {
                    $set: {
                        status: "REVERSED"
                    }
                },
                {
                    session
                }
            );

            if (transactionUpdate.matchedCount !== 1) {
                throw new Error(
                    "Original withdrawal transaction is missing or not in a reversible state"
                );
            }

            const wallet = await Wallet.findOneAndUpdate(
                {
                    userId: withdrawal.userId
                },
                {
                    $inc: {
                        balance: withdrawal.amount
                    }
                },
                {
                    returnDocument: "after",
                    session
                }
            );

            if (!wallet) {
                throw new Error("Wallet not found during refund");
            }

            const [refundTransaction] = await Transaction.create(
                [
                    {
                        type: "REVERSAL",
                        fromUserId: null,
                        toUserId: withdrawal.userId,
                        amount: withdrawal.amount,
                        note: "Refund of failed withdrawal",
                        status: "SUCCESS"
                    }
                ],
                {
                    session
                }
            );

            await LedgerEntry.create(
                [
                    {
                        userId: withdrawal.userId,
                        transactionId: refundTransaction._id,
                        direction: "CREDIT",
                        amount: withdrawal.amount,
                        balanceAfter: wallet.balance
                    }
                ],
                {
                    session
                }
            );

            await OutboxEvent.updateOne(
                {
                    withdrawalId: withdrawal._id,
                    status: {
                        $in: ["NEW", "PROCESSING"]
                    }
                },
                {
                    $set: {
                        status: "DONE",
                        lockedAt: null,
                        lastError: reason
                    }
                },
                {
                    session
                }
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

module.exports = {
    reverseWithdrawal
};