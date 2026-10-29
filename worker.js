require("dotenv").config();

const mongoose = require("mongoose");

const {
    connectDB,
    BankAccount,
    Withdrawal,
    OutboxEvent,
    Transaction
} = require("./db");

const { reverseWithdrawal } = require("./services/money");

const BANK_URL = process.env.BANK_URL || "http://localhost:4000";
const POLL_INTERVAL_MS = 1000;
const LOCK_TIMEOUT_MS = 60_000;

let stopping = false;

/**
 * Synchronize the original withdrawal transaction.
 */
async function syncWithdrawalTransaction(withdrawal) {
    if (!withdrawal.transactionId) {
        return false;
    }

    const result = await Transaction.updateOne(
        {
            _id: withdrawal.transactionId,
            type: "WITHDRAWAL"
        },
        {
            $set: {
                status: withdrawal.status
            }
        }
    );

    return result.matchedCount === 1;
}

/**
 * Complete database bookkeeping after the bank has confirmed
 * success. Never reverse a payout that the bank confirmed.
 */
async function completeConfirmedPayout(
    job,
    withdrawal,
    bankRef
) {
    withdrawal.status = "SUCCESS";
    withdrawal.bankRef = bankRef;
    withdrawal.failureReason = null;
    await withdrawal.save();

    const synced = await Transaction.updateOne(
        {
            _id: withdrawal.transactionId,
            type: "WITHDRAWAL",
            status: { $in: ["PENDING", "PROCESSING", "SUCCESS"] }
        },
        {
            $set: { status: "SUCCESS" }
        }
    );

    if (synced.matchedCount !== 1) {
        throw new Error(
            "Bank confirmed success, but the withdrawal transaction could not be synchronized"
        );
    }

    job.status = "DONE";
    job.lockedAt = null;
    job.lastError = null;
    await job.save();
}

/**
 * A payout with an uncertain result must not be refunded
 * or automatically submitted again.
 */
async function finishForReview(job, withdrawal, reason) {
    job.status = "STUCK";
    job.lockedAt = null;
    job.lastError = reason;
    await job.save();

    if (
        withdrawal.status !== "SUCCESS" &&
        withdrawal.status !== "REVERSED"
    ) {
        withdrawal.status = "NEEDS_REVIEW";
        withdrawal.failureReason = reason;
        await withdrawal.save();

        if (withdrawal.transactionId) {
            const synced = await syncWithdrawalTransaction(withdrawal);

            if (!synced) {
                console.error(
                    `[REVIEW] Could not synchronize transaction for withdrawal ${withdrawal._id}`
                );
            }
        }
    }

    console.error(
        `[REVIEW] Withdrawal ${withdrawal._id}; reference=${withdrawal.reference}; reason=${reason}`
    );
}

async function scheduleReview(job, withdrawal, reason) {
    await finishForReview(
        job,
        withdrawal,
        `Payout outcome uncertain; manual review required: ${reason}`
    );
}

async function processNextWithdrawal() {
    // A stale payout may have reached the bank. Never resubmit it
    // automatically because the previous outcome is uncertain.
    const staleJob = await OutboxEvent.findOne({
        type: "PAYOUT_REQUESTED",
        status: "PROCESSING",
        lockedAt: {
            $lte: new Date(Date.now() - LOCK_TIMEOUT_MS)
        }
    }).sort({ lockedAt: 1 });

    if (staleJob) {
        const withdrawal = await Withdrawal.findById(
            staleJob.withdrawalId
        );

        if (!withdrawal) {
            staleJob.status = "STUCK";
            staleJob.lockedAt = null;
            staleJob.lastError =
                "Withdrawal record not found during stale-lock recovery";
            await staleJob.save();
            return true;
        }

        if (withdrawal.status === "SUCCESS") {
            // Repair the transaction if the withdrawal was saved as
            // successful but the worker stopped before syncing it.
            const synced = await syncWithdrawalTransaction(withdrawal);

            if (!synced) {
                await finishForReview(
                    staleJob,
                    withdrawal,
                    "Withdrawal is SUCCESS but its transaction needs manual reconciliation"
                );
                return true;
            }

            staleJob.status = "DONE";
            staleJob.lockedAt = null;
            staleJob.lastError = null;
            await staleJob.save();
            return true;
        }

        if (withdrawal.status === "REVERSED") {
            staleJob.status = "DONE";
            staleJob.lockedAt = null;
            await staleJob.save();
            return true;
        }

        await finishForReview(
            staleJob,
            withdrawal,
            withdrawal.failureReason ||
                "Stale processing lock; payout outcome uncertain"
        );

        return true;
    }

    const job = await OutboxEvent.findOneAndUpdate(
        {
            type: "PAYOUT_REQUESTED",
            status: "NEW",
            nextAttemptAt: { $lte: new Date() }
        },
        {
            $set: {
                status: "PROCESSING",
                lockedAt: new Date()
            },
            $inc: { attempts: 1 }
        },
        {
            sort: {
                nextAttemptAt: 1,
                createdAt: 1
            },
            returnDocument: "after"
        }
    );

    if (!job) {
        return false;
    }

    const withdrawal = await Withdrawal.findById(job.withdrawalId);

    if (!withdrawal) {
        job.status = "STUCK";
        job.lockedAt = null;
        job.lastError = "Withdrawal record not found";
        await job.save();
        return true;
    }

    if (withdrawal.status === "SUCCESS") {
        const synced = await syncWithdrawalTransaction(withdrawal);

        if (!synced) {
            await finishForReview(
                job,
                withdrawal,
                "Successful withdrawal has no valid linked transaction"
            );
            return true;
        }

        job.status = "DONE";
        job.lockedAt = null;
        job.lastError = null;
        await job.save();
        return true;
    }

    if (withdrawal.status === "REVERSED") {
        job.status = "DONE";
        job.lockedAt = null;
        await job.save();
        return true;
    }

    if (withdrawal.status === "NEEDS_REVIEW") {
        await finishForReview(
            job,
            withdrawal,
            withdrawal.failureReason || "Already needs review"
        );
        return true;
    }

    if (!withdrawal.transactionId) {
        await finishForReview(
            job,
            withdrawal,
            "Missing transactionId; manual reconciliation required before payout"
        );
        return true;
    }

    const originalTransaction = await Transaction.findOne({
        _id: withdrawal.transactionId,
        type: "WITHDRAWAL"
    });

    if (!originalTransaction) {
        await finishForReview(
            job,
            withdrawal,
            "Linked withdrawal transaction not found; manual reconciliation required"
        );
        return true;
    }

    if (
        originalTransaction.status !== "PENDING" &&
        originalTransaction.status !== "PROCESSING"
    ) {
        await finishForReview(
            job,
            withdrawal,
            `Transaction status mismatch: ${originalTransaction.status}`
        );
        return true;
    }

    const bankAccount = await BankAccount.findOne({
        _id: withdrawal.bankAccountId,
        userId: withdrawal.userId
    });

    if (!bankAccount) {
        await finishForReview(
            job,
            withdrawal,
            "Registered bank account not found"
        );
        return true;
    }

    let bankConfirmedSuccess = false;
    let confirmedBankRef = null;

    try {
        withdrawal.status = "PROCESSING";
        await withdrawal.save();

        originalTransaction.status = "PROCESSING";
        await originalTransaction.save();

        const response = await fetch(`${BANK_URL}/payouts`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({
                reference: withdrawal.reference,
                accountNumber: bankAccount.accountNumber,
                ifsc: bankAccount.ifsc,
                amount: withdrawal.amount
            })
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error(
                "Invalid bank response; payout outcome uncertain"
            );
        }

        if (
            response.ok &&
            result.status === "SUCCESS" &&
            typeof result.bankRef === "string" &&
            result.bankRef.trim()
        ) {
            // Set this before database writes so a later write failure
            // cannot be mistaken for a bank payout failure.
            bankConfirmedSuccess = true;
            confirmedBankRef = result.bankRef.trim();

            await completeConfirmedPayout(
                job,
                withdrawal,
                confirmedBankRef
            );

            console.log(
                `Withdrawal ${withdrawal._id} SUCCESS; bank reference ${confirmedBankRef}`
            );

            return true;
        }

        // Refund only on an explicit permanent bank refusal.
        if (
            response.status >= 400 &&
            response.status < 500 &&
            result.status === "FAILED" &&
            result.permanent === true
        ) {
            await reverseWithdrawal(
                withdrawal._id,
                result.message || "Permanent bank refusal"
            );

            console.log(
                `Withdrawal ${withdrawal._id} reversed after permanent refusal`
            );

            return true;
        }

        await scheduleReview(
            job,
            withdrawal,
            result.message ||
                `Uncertain bank response: HTTP ${response.status}, status ${result.status}`
        );
    } catch (error) {
        if (bankConfirmedSuccess) {
            // The bank has already confirmed payment. Retry only the
            // local bookkeeping; never issue another payout or refund.
            try {
                const latestWithdrawal = await Withdrawal.findById(
                    withdrawal._id
                );

                if (!latestWithdrawal) {
                    throw new Error(
                        "Withdrawal missing after confirmed bank success"
                    );
                }

                await completeConfirmedPayout(
                    job,
                    latestWithdrawal,
                    confirmedBankRef
                );

                console.log(
                    `Recovered database status for confirmed withdrawal ${latestWithdrawal._id}`
                );
            } catch (recoveryError) {
                console.error(
                    `[CRITICAL] Bank confirmed withdrawal ${withdrawal._id}, but database recovery failed: ${recoveryError.message}`
                );

                // Do not mark this as a payout failure or refund it.
                // Leave a durable manual-review marker if possible.
                try {
                    job.status = "STUCK";
                    job.lockedAt = null;
                    job.lastError =
                        `BANK CONFIRMED SUCCESS; database recovery required: ${recoveryError.message}`;
                    await job.save();
                } catch (jobError) {
                    console.error(
                        `[CRITICAL] Could not save review marker for job ${job._id}: ${jobError.message}`
                    );
                }
            }
        } else {
            await scheduleReview(job, withdrawal, error.message);
        }
    }

    return true;
}

async function main() {
    await connectDB();

    console.log("KaasuPay withdrawal worker started");

    while (!stopping) {
        try {
            const processed = await processNextWithdrawal();

            if (!processed) {
                await new Promise(resolve =>
                    setTimeout(resolve, POLL_INTERVAL_MS)
                );
            }
        } catch (error) {
            console.error("Worker error:", error.message);

            await new Promise(resolve =>
                setTimeout(resolve, POLL_INTERVAL_MS)
            );
        }
    }

    await mongoose.disconnect();
    console.log("Worker stopped");
}

process.on("SIGINT", () => {
    stopping = true;
});

process.on("SIGTERM", () => {
    stopping = true;
});

if (require.main === module) {
    main().catch(error => {
        console.error("Worker failed to start:", error.message);
        process.exit(1);
    });
}

module.exports = {
    processNextWithdrawal,
    main
};