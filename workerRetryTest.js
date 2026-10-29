
require("dotenv").config();

const mongoose = require("mongoose");
const crypto = require("crypto");

const EXPECTED_DB = "kaasupay_worker_retry_test";
const AMOUNT = 10000; // ₹100 in paise
const START_BALANCE = 20000; // Balance after the withdrawal debit

async function run() {
    const originalUri = process.env.MONGO_URL;
    if (!originalUri) throw new Error("MONGO_URL is missing.");

    const testUri = originalUri.replace(
        /\/kaasupay(?:_test)?(?=\?|$)/,
        "/" + EXPECTED_DB
    );

    if (testUri === originalUri) {
        throw new Error("Could not safely select the isolated retry-test database.");
    }

    process.env.MONGO_URL = testUri;
    process.env.BANK_URL = "http://localhost:4000";

    const {
        connectDB,
        User,
        Wallet,
        BankAccount,
        Withdrawal,
        OutboxEvent,
        Transaction,
        LedgerEntry
    } = require("./db");

    // Set environment variables before loading the worker.
    const { processNextWithdrawal } = require("./worker");

    await connectDB();

    try {
        if (mongoose.connection.name !== EXPECTED_DB) {
            throw new Error("Wrong database; refusing to continue.");
        }

        console.log("Verified database:", mongoose.connection.name);

        const collections = [
            "users",
            "wallets",
            "bankaccounts",
            "withdrawals",
            "outboxevents",
            "transactions",
            "ledgerentries"
        ];

        for (const name of collections) {
            const count = await mongoose.connection.db
                .collection(name)
                .countDocuments();

            console.log(`${name}: ${count}`);

            if (count !== 0) {
                throw new Error(
                    `Collection ${name} is not empty. No test data created.`
                );
            }
        }

        // Confirm the fake bank is responding in PROCESSING mode.
        const response = await fetch("http://localhost:4000/");
        if (!response.ok) throw new Error("Fake bank health check failed.");

        const health = await response.json();

        if (health.mode !== "PROCESSING") {
            throw new Error(
                `Expected PROCESSING mode; received ${health.mode}. No test data created.`
            );
        }

        console.log("Verified fake bank mode:", health.mode);

        const user = await User.create({
            username: `retry_test_${crypto.randomBytes(6).toString("hex")}`,
            firstName: "Worker",
            lastName: "RetryTest",
            passwordHash: "TEST_ONLY_NOT_A_REAL_PASSWORD_HASH"
        });

        await Wallet.create({
            userId: user._id,
            balance: START_BALANCE
        });

        const bankAccount = await BankAccount.create({
            userId: user._id,
            holderName: "Worker RetryTest",
            accountNumber: "123456789012",
            ifsc: "SBIN0001234",
            last4: "9012"
        });

        const reference =
            `wd_retry_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

        const withdrawal = await Withdrawal.create({
            userId: user._id,
            bankAccountId: bankAccount._id,
            amount: AMOUNT,
            reference,
            status: "PROCESSING"
        });

        const job = await OutboxEvent.create({
            type: "PAYOUT_REQUESTED",
            withdrawalId: withdrawal._id,
            status: "NEW",
            attempts: 0,
            nextAttemptAt: new Date(),
            lockedAt: null,
            lastError: null
        });

        console.log("Synthetic withdrawal created.");
        console.log("Reference:", reference);
        console.log("Starting wallet balance:", START_BALANCE, "paise");
        console.log("Withdrawal amount:", AMOUNT, "paise");

        // Process exactly one job; do not start the worker loop.
        await processNextWithdrawal();

        const finalWithdrawal = await Withdrawal.findById(withdrawal._id);
        const finalJob = await OutboxEvent.findById(job._id);
        const finalWallet = await Wallet.findOne({ userId: user._id });

        const reversalTransactions = await Transaction.countDocuments({
            type: "REVERSAL",
            toUserId: user._id,
            amount: AMOUNT
        });

        const creditEntries = await LedgerEntry.countDocuments({
            userId: user._id,
            direction: "CREDIT",
            amount: AMOUNT
        });

        console.log("\n--- RETRY TEST RESULTS ---");
        console.log("Database:", mongoose.connection.name);
        console.log("Withdrawal status:", finalWithdrawal?.status);
        console.log("Outbox status:", finalJob?.status);
        console.log("Attempts:", finalJob?.attempts);
        console.log("Next attempt:", finalJob?.nextAttemptAt);
        console.log("Last error:", finalJob?.lastError);
        console.log("Wallet balance (paise):", finalWallet?.balance);
        console.log("Reversal transactions:", reversalTransactions);
        console.log("Matching credit ledger entries:", creditEntries);

        const passed =
            finalWithdrawal?.status === "PROCESSING" &&
            finalJob?.status === "NEW" &&
            finalJob?.attempts === 1 &&
            finalJob?.lockedAt == null &&
            finalJob?.nextAttemptAt instanceof Date &&
            finalJob.nextAttemptAt > new Date() &&
            finalWallet?.balance === START_BALANCE &&
            reversalTransactions === 0 &&
            creditEntries === 0;

        if (!passed) {
            throw new Error(
                "TEST DID NOT PASS. Preserve all records for inspection; do not rerun."
            );
        }

        console.log(
            "\nPASS: Temporary bank response scheduled a retry without refunding the wallet."
        );
    } finally {
        await mongoose.disconnect();
        console.log("MongoDB disconnected.");
    }
}

run().catch(error => {
    console.error("RETRY TEST ERROR:", error.message);
    process.exitCode = 1;
});
