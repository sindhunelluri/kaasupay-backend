const assert = require("node:assert/strict");
require("dotenv").config();

const mongoose = require("mongoose");

async function run() {
    const uri = new URL(process.env.MONGO_URL);
    uri.pathname = "/kaasupay_stale_lock_test";
    process.env.MONGO_URL = uri.toString();

    // Set BANK_URL before importing worker.js because it is read at module load.
    process.env.BANK_URL = "http://127.0.0.1:4000";

    const db = require("./db");
    const { processNextWithdrawal } = require("./worker");

    try {
        await db.connectDB();

        assert.equal(
            mongoose.connection.name,
            "kaasupay_stale_lock_test",
            "Refusing to run against an unexpected database"
        );

        const collectionNames = [
            "users",
            "wallets",
            "bankaccounts",
            "withdrawals",
            "outboxevents",
            "transactions",
            "ledgerentries",
            "idempotencyrecords",
            "dailytransferlimits"
        ];

        for (const name of collectionNames) {
            const count = await mongoose.connection.db
                .collection(name)
                .countDocuments();

            console.log(`${name}: ${count}`);
            assert.equal(
                count,
                0,
                `Refusing to create test records: ${name} is not empty`
            );
        }

        console.log("Isolated database verified. Creating synthetic test data.");

        const user = await db.User.create({
            username: "stale-lock-regression-user",
            firstName: "Stale",
            lastName: "Lock",
            passwordHash: "synthetic-test-only"
        });

        const wallet = await db.Wallet.create({
            userId: user._id,
            balance: 20000
        });

        const bankAccount = await db.BankAccount.create({
            userId: user._id,
            holderName: "Synthetic Test User",
            accountNumber: "123456789012",
            ifsc: "TEST0001234",
            last4: "9012"
        });

        const withdrawal = await db.Withdrawal.create({
            userId: user._id,
            bankAccountId: bankAccount._id,
            amount: 10000,
            reference: "stale-lock-regression-test",
            status: "PROCESSING"
        });

        const oldLock = new Date(Date.now() - 120000);

        const job = await db.OutboxEvent.create({
            type: "PAYOUT_REQUESTED",
            withdrawalId: withdrawal._id,
            status: "PROCESSING",
            attempts: 5,
            lockedAt: oldLock,
            nextAttemptAt: oldLock,
            lastError: "Synthetic stale lock regression test"
        });

        // Exactly one worker iteration. Never call main().
        await processNextWithdrawal();

        const finalJob = await db.OutboxEvent.findById(job._id);
        const finalWithdrawal = await db.Withdrawal.findById(withdrawal._id);
        const finalWallet = await db.Wallet.findById(wallet._id);

        console.log("\nRegression test results:");
        console.log("Database:", mongoose.connection.name);
        console.log("Job status:", finalJob.status);
        console.log("Withdrawal status:", finalWithdrawal.status);
        console.log("Attempts:", finalJob.attempts);
        console.log("Wallet balance (paise):", finalWallet.balance);
        console.log("Job error:", finalJob.lastError);

        assert.equal(finalJob.status, "STUCK");
        assert.equal(finalJob.lockedAt, null);
        assert.equal(finalWithdrawal.status, "NEEDS_REVIEW");
        assert.equal(finalWallet.balance, 20000);

        console.log("\nPASS: exhausted stale job moved to review without a wallet balance change.");
    } finally {
        await mongoose.disconnect();
    }
}

run().catch(error => {
    console.error("TEST FAILED:", error.message);
    process.exitCode = 1;
});
