
require("dotenv").config();

const mongoose = require("mongoose");
const { connectDB, Withdrawal, OutboxEvent } = require("./db");

async function checkWithdrawals() {
    try {
        await connectDB();

        const references = [
            "wd_6ae1dbc125b64ff569f17277",
            "wd_6ae1c0e57cbe903e3db5c84"
        ];

        const withdrawals = await Withdrawal.find({
            reference: { $in: references }
        }).lean();

        console.log("\nWITHDRAWALS:");
        console.log(JSON.stringify(
            withdrawals.map(w => ({
                reference: w.reference,
                status: w.status,
                bankRef: w.bankRef,
                withdrawalId: String(w._id)
            })),
            null, 2
        ));

        const ids = withdrawals.map(w => w._id);

        const jobs = await OutboxEvent.find({
            withdrawalId: { $in: ids }
        }).lean();

        console.log("\nOUTBOX JOBS:");
        console.log(JSON.stringify(
            jobs.map(j => ({
                withdrawalId: String(j.withdrawalId),
                type: j.type,
                status: j.status,
                attempts: j.attempts,
                nextAttemptAt: j.nextAttemptAt,
                lastError: j.lastError,
                lockedAt: j.lockedAt
            })),
            null, 2
        ));
    } finally {
        await mongoose.disconnect();
    }
}

checkWithdrawals().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
