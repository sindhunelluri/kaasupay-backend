require("dotenv").config();

const originalUri = process.env.MONGO_URL;

if (!originalUri) throw new Error("MONGO_URL is missing");

const testUri = originalUri.replace(
    /\/kaasupay(?=\?|$)/,
    "/kaasupay_test"
);

if (testUri === originalUri) {
    throw new Error("Could not safely select kaasupay_test");
}

process.env.MONGO_URL = testUri;

const mongoose = require("mongoose");
const {
    connectDB,
    User,
    Wallet,
    BankAccount,
    Withdrawal,
    OutboxEvent
} = require("./db");
const { processNextWithdrawal } = require("./worker");

async function main() {
    let user;
    let bankAccount;
    let withdrawal;
    let job;

    try {
        await connectDB();

        if (mongoose.connection.name !== "kaasupay_test") {
            throw new Error("Wrong database; stopping test");
        }

        const existingJobs = await OutboxEvent.countDocuments();
        if (existingJobs !== 0) {
            throw new Error(
                `Expected an empty test outbox, found ${existingJobs} jobs. No test records created.`
            );
        }

        const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

        user = await User.create({
            username: `worker-test-${tag}`,
            firstName: "Worker",
            lastName: "Test",
            passwordHash: "test-only-not-a-real-password-hash"
        });

        await Wallet.create({
            userId: user._id,
            balance: 50000
        });

        bankAccount = await BankAccount.create({
            userId: user._id,
            holderName: "Worker Test",
            accountNumber: "123456789012",
            ifsc: "SBIN0001234",
            last4: "9012"
        });

        withdrawal = await Withdrawal.create({
            userId: user._id,
            bankAccountId: bankAccount._id,
            amount: 10000,
            reference: `worker-processing-test-${tag}`,
            status: "PENDING"
        });

        job = await OutboxEvent.create({
            type: "PAYOUT_REQUESTED",
            withdrawalId: withdrawal._id,
            status: "NEW",
            attempts: 0,
            nextAttemptAt: new Date(Date.now() - 1000)
        });

        console.log("Test database verified:", mongoose.connection.name);
        console.log("Calling worker once for:", withdrawal.reference);

        await processNextWithdrawal();

        const savedWithdrawal = await Withdrawal.findById(withdrawal._id);
        const savedJob = await OutboxEvent.findById(job._id);

        console.log("Withdrawal status:", savedWithdrawal.status);
        console.log("Outbox status:", savedJob.status);
        console.log("Attempts:", savedJob.attempts);
        console.log(
            "Retry scheduled in future:",
            savedJob.nextAttemptAt > new Date()
        );
        console.log("Failure reason:", savedJob.lastError);

        if (
            savedWithdrawal.status !== "PROCESSING" ||
            savedJob.status !== "NEW" ||
            savedJob.attempts !== 1 ||
            !(savedJob.nextAttemptAt > new Date())
        ) {
            throw new Error("Retry behavior did not match expectations");
        }

        console.log("PASS: uncertain PROCESSING response scheduled a retry.");
    } finally {
        if (mongoose.connection.readyState === 1) {
            if (job) await OutboxEvent.deleteOne({ _id: job._id });
            if (withdrawal) await Withdrawal.deleteOne({ _id: withdrawal._id });
            if (bankAccount) await BankAccount.deleteOne({ _id: bankAccount._id });
            if (user) {
                await Wallet.deleteOne({ userId: user._id });
                await User.deleteOne({ _id: user._id });
            }

            await mongoose.disconnect();
            console.log("Test records cleaned up.");
        }
    }
}

main().catch(error => {
    console.error("TEST FAILED:", error.message);
    process.exitCode = 1;
});
