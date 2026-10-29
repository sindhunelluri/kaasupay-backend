
require("dotenv").config();

const mongoose = require("mongoose");
const crypto = require("crypto");

const EXPECTED_DB = "kaasupay_worker_review_test";
const START_BALANCE = 20000;
const AMOUNT = 10000;

async function run() {
    const originalUri = process.env.MONGO_URL;
    if (!originalUri) throw new Error("MONGO_URL is missing.");

    const testUri = originalUri.replace(
        /\/kaasupay(?:_test)?(?=\?|$)/,
        "/" + EXPECTED_DB
    );

    if (testUri === originalUri) {
        throw new Error("Could not safely select isolated review-test database.");
    }

    process.env.MONGO_URL = testUri;
    process.env.BANK_URL = "http://localhost:4000";

    const {
        connectDB, User, Wallet, BankAccount,
        Withdrawal, OutboxEvent, Transaction, LedgerEntry
    } = require("./db");

    const { processNextWithdrawal } = require("./worker");

    await connectDB();

    try {
        if (mongoose.connection.name !== EXPECTED_DB) {
            throw new Error("Wrong database; refusing to continue.");
        }

        console.log("Verified database:", mongoose.connection.name);

        const collections = [
            "users", "wallets", "bankaccounts", "withdrawals",
            "outboxevents", "transactions", "ledgerentries",
            "idempotencyrecords", "dailytransferlimits"
        ];

        for (const name of collections) {
            const count = await mongoose.connection.db
                .collection(name).countDocuments();
            console.log(`${name}: ${count}`);

            if (count !== 0) {
                throw new Error(
                    `Collection ${name} is not empty. No test data created.`
                );
            }
        }

        const healthResponse = await fetch("http://localhost:4000/");
        if (!healthResponse.ok) throw new Error("Fake bank health check failed.");

        const health = await healthResponse.json();
        if (health.mode !== "PROCESSING") {
            throw new Error(
                `Expected PROCESSING mode; got ${health.mode}. No test data created.`
            );
        }
        console.log("Verified fake bank mode:", health.mode);

        const user = await User.create({
            username: `review_test_${crypto.randomBytes(6).toString("hex")}`,
            firstName: "Worker",
            lastName: "ReviewTest",
            passwordHash: "TEST_ONLY_NOT_A_REAL_PASSWORD_HASH"
        });

        await Wallet.create({ userId: user._id, balance: START_BALANCE });

        const bankAccount = await BankAccount.create({
            userId: user._id,
            holderName: "Worker ReviewTest",
            accountNumber: "123456789012",
            ifsc: "SBIN0001234",
            last4: "9012"
        });

        const reference =
            `wd_review_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

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
            attempts: 4,
            nextAttemptAt: new Date(),
            lockedAt: null,
            lastError: "Four previous uncertain attempts"
        });

        console.log("Synthetic job created for attempt five.");
        console.log("Reference:", reference);

        // Exactly one worker call. Do not start main() or a worker loop.
        await processNextWithdrawal();

        const finalWithdrawal = await Withdrawal.findById(withdrawal._id);
        const finalJob = await OutboxEvent.findById(job._id);
        const finalWallet = await Wallet.findOne({ userId: user._id });

        const reversals = await Transaction.countDocuments({
            type: "REVERSAL",
            toUserId: user._id,
            amount: AMOUNT
        });

        const credits = await LedgerEntry.countDocuments({
            userId: user._id,
            direction: "CREDIT",
            amount: AMOUNT
        });

        console.log("\n--- MAX-ATTEMPT TEST RESULTS ---");
        console.log("Withdrawal status:", finalWithdrawal?.status);
        console.log("Failure reason:", finalWithdrawal?.failureReason);
        console.log("Outbox status:", finalJob?.status);
        console.log("Attempts:", finalJob?.attempts);
        console.log("Lock cleared:", finalJob?.lockedAt == null);
        console.log("Wallet balance (paise):", finalWallet?.balance);
        console.log("Reversal transactions:", reversals);
        console.log("Matching credit ledger entries:", credits);

        const passed =
            finalWithdrawal?.status === "NEEDS_REVIEW" &&
            finalJob?.status === "STUCK" &&
            finalJob?.attempts === 5 &&
            finalJob?.lockedAt == null &&
            typeof finalWithdrawal?.failureReason === "string" &&
            finalWithdrawal.failureReason.includes("Maximum attempts reached") &&
            finalWallet?.balance === START_BALANCE &&
            reversals === 0 &&
            credits === 0;

        if (!passed) {
            throw new Error(
                "TEST DID NOT PASS. Preserve records for inspection; do not rerun."
            );
        }

        console.log("\nPASS: Fifth uncertain attempt moved the withdrawal to review without a refund.");
    } finally {
        await mongoose.disconnect();
        console.log("MongoDB disconnected.");
    }
}

run().catch(error => {
    console.error("REVIEW TEST ERROR:", error.message);
    process.exitCode = 1;
});
