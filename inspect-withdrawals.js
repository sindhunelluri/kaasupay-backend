
require("dotenv").config();

const mongoose = require("mongoose");
const {
    connectDB,
    Withdrawal,
    OutboxEvent
} = require("./db");

const references = [
    "wd_6ae1dbc125b64ff569f17277",
    "wd_6ae1c0e57cbe903e3db5c84",
    "wd_6adce30f9208e6e365df80a7"
];

async function inspectWithdrawals() {
    try {
        await connectDB();

        console.log("\nConnected database:", mongoose.connection.name);
        console.log("\n=== WITHDRAWALS ===");

        const withdrawals = await Withdrawal.find({
            reference: { $in: references }
        }).select(
            "_id reference amount status bankRef failureReason createdAt updatedAt"
        ).lean();

        if (withdrawals.length === 0) {
            console.log("No withdrawals found for the supplied references.");
        } else {
            console.table(withdrawals.map(w => ({
                id: String(w._id),
                reference: w.reference,
                amount: w.amount,
                status: w.status,
                bankRef: w.bankRef || null,
                failureReason: w.failureReason || null,
                createdAt: w.createdAt,
                updatedAt: w.updatedAt
            })));
        }

        console.log("\n=== RELATED OUTBOX JOBS ===");

        const withdrawalIds = withdrawals.map(w => w._id);

        const jobs = withdrawalIds.length
            ? await OutboxEvent.find({
                withdrawalId: { $in: withdrawalIds }
            }).select(
                "_id type withdrawalId status attempts nextAttemptAt lockedAt lastError createdAt updatedAt"
            ).lean()
            : [];

        if (jobs.length === 0) {
            console.log("No related outbox jobs found.");
        } else {
            console.table(jobs.map(j => ({
                id: String(j._id),
                type: j.type,
                withdrawalId: String(j.withdrawalId),
                status: j.status,
                attempts: j.attempts,
                nextAttemptAt: j.nextAttemptAt,
                lockedAt: j.lockedAt,
                lastError: j.lastError || null,
                createdAt: j.createdAt,
                updatedAt: j.updatedAt
            })));
        }

        console.log("\n=== RECENT PAYOUT JOBS ===");

        const recentJobs = await OutboxEvent.find({
            type: "PAYOUT_REQUESTED"
        })
            .sort({ createdAt: -1 })
            .limit(10)
            .select(
                "_id type withdrawalId status attempts nextAttemptAt lockedAt lastError createdAt"
            )
            .lean();

        if (recentJobs.length === 0) {
            console.log("No PAYOUT_REQUESTED jobs found.");
        } else {
            console.table(recentJobs.map(j => ({
                id: String(j._id),
                withdrawalId: String(j.withdrawalId),
                status: j.status,
                attempts: j.attempts,
                nextAttemptAt: j.nextAttemptAt,
                lockedAt: j.lockedAt,
                lastError: j.lastError || null,
                createdAt: j.createdAt
            })));
        }
    } catch (error) {
        console.error("Diagnostic failed:", error.message);
    } finally {
        await mongoose.disconnect();
    }
}

inspectWithdrawals();
