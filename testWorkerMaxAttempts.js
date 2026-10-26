require("dotenv").config();

const originalUri = process.env.MONGO_URL;
if (!originalUri) throw new Error("MONGO_URL is missing");

const testUri = originalUri.replace(/\/kaasupay(?=\?|$)/, "/kaasupay_test");
if (testUri === originalUri) {
    throw new Error("Could not safely select kaasupay_test. No test was run.");
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
            throw new Error("Wrong database. Stopping test.");
        }

        const existingJobs = await OutboxEvent.countDocuments();
        if (existingJobs !== 0) {
            throw new Error(
                `Expected an empty test outbox, found ${existingJobs} jobs. No test records created.`
            );
        }

        const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

        user = await User.create({
            username: `max-attempt-test-${tag}`,
            firstName: "MaxAttempt",
            lastName: "Test",
            passwordHash: "test-only-not-a-real-password-hash"
        });

        await Wallet.create({
            userId: user._id,
            balance: 50000
        });

        bankAccount = await BankAccount.create({
            userId: user._id,
            holderName: "Max Attempt Test",
            accountNumber: "123456789012",
            ifsc: "SBIN0001234",
            last4: "9012"
        });

        withdrawal = await Withdrawal.create({
            userId: user._id,
            bankAccountId: bankAccount._id,
            amount: 10000,
            reference: `max-attempt-test-${tag}`,
            status: "PROCESSING"
        });

        job = await OutboxEvent.create({
            type: "PAYOUT_REQUESTED",
            withdrawalId: withdrawal._id,
            status: "NEW",
            attempts: 4,
            nextAttemptAt: new Date(Date.now() - 1000)
        });

        console.log("Verified database:", mongoose.connection.name);
        console.log("Starting stored attempt count:", job.attempts);

        await processNextWithdrawal();

        const savedWithdrawal = await Withdrawal.findById(withdrawal._id);
        const savedJob = await OutboxEvent.findById(job._id);
        const savedWallet = await Wallet.findOne({ userId: user._id });

        console.log("Final withdrawal status:", savedWithdrawal.status);
        console.log("Final outbox status:", savedJob.status);
        console.log("Final attempt count:", savedJob.attempts);
        console.log("Lock released:", savedJob.lockedAt === null);
        console.log("Failure reason:", savedJob.lastError);
        console.log("Wallet balance in paise:", savedWallet.balance);

        const passed =
            savedWithdrawal.status === "NEEDS_REVIEW" &&
            savedJob.status === "STUCK" &&
            savedJob.attempts === 5 &&
            savedJob.lockedAt === null &&
            String(savedJob.lastError).includes("Maximum attempts reached") &&
            savedWallet.balance === 50000;

        if (!passed) {
            throw new Error("Maximum-attempt test did not match expectations.");
        }

        console.log(
            "PASS: fifth attempt moved the withdrawal to NEEDS_REVIEW; wallet balance was unchanged."
        );
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
