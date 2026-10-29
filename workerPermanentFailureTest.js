require("dotenv").config();

const mongoose = require("mongoose");
const crypto = require("crypto");

const EXPECTED_DB = "kaasupay_worker_fail_test";
const AMOUNT = 10000; // ₹100 in paise
const START_BALANCE = 20000; // ₹200, representing balance after withdrawal debit
const EXPECTED_BALANCE = START_BALANCE + AMOUNT; // ₹300

async function run() {
    const originalUri = process.env.MONGO_URL;
    if (!originalUri) throw new Error("MONGO_URL is missing.");

    const testUri = originalUri.replace(
        /\/kaasupay(?:_test)?(?=\?|$)/,
        "/" + EXPECTED_DB
    );

    if (testUri === originalUri) {
        throw new Error("Could not safely select the isolated test database.");
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
            throw new Error(
                "WRONG DATABASE: " + mongoose.connection.name +
                ". Refusing to continue."
            );
        }

        console.log("Verified database:", mongoose.connection.name);

        const models = [
            ["users", User],
            ["wallets", Wallet],
            ["bankaccounts", BankAccount],
            ["withdrawals", Withdrawal],
            ["outboxevents", OutboxEvent],
            ["transactions", Transaction],
            ["ledgerentries", LedgerEntry],
        ];

        for (const [name, Model] of models) {
            const count = await Model.countDocuments();
            console.log(name + ": " + count);
            if (count !== 0) {
                throw new Error(
                    "Collection " + name +
                    " is not empty. Stopping without creating test data."
                );
            }
        }

        const bankResponse = await fetch("http://localhost:4000/");
        const bankInfo = await bankResponse.json();

        if (bankInfo.mode !== "FAILED") {
            throw new Error(
                "Fake bank is not in FAILED mode. Current mode: " +
                bankInfo.mode
            );
        }

        console.log("Verified fake bank mode: FAILED");

        const unique = Date.now() + "_" +
            crypto.randomBytes(4).toString("hex");
        const reference = "wd_worker_fail_" + unique;

        const user = await User.create({
            username: "worker_fail_" + unique,
            firstName: "Worker",
            lastName: "FailureTest",
            passwordHash: "TEST_ONLY_NOT_A_REAL_PASSWORD_HASH"
        });

        const wallet = await Wallet.create({
            userId: user._id,
            balance: START_BALANCE
        });

        const bankAccount = await BankAccount.create({
            userId: user._id,
            holderName: "Worker FailureTest",
            accountNumber: "123456789012",
            ifsc: "TEST0000123",
            last4: "9012"
        });

        const withdrawal = await Withdrawal.create({
            userId: user._id,
            bankAccountId: bankAccount._id,
            amount: AMOUNT,
            reference,
            status: "PENDING"
        });

        const job = await OutboxEvent.create({
            type: "PAYOUT_REQUESTED",
            withdrawalId: withdrawal._id,
            status: "NEW",
            attempts: 0,
            nextAttemptAt: new Date()
        });

        console.log("Synthetic withdrawal created.");
        console.log("Reference:", reference);
        console.log("Starting wallet balance:", START_BALANCE, "paise");
        console.log("Withdrawal amount:", AMOUNT, "paise");

        // Process exactly one job; do not start the infinite worker loop.
        await processNextWithdrawal();

        const finalWithdrawal = await Withdrawal.findById(withdrawal._id);
        const finalJob = await OutboxEvent.findById(job._id);
        const finalWallet = await Wallet.findOne({ userId: user._id });

        const reversals = await Transaction.find({
            type: "REVERSAL",
            toUserId: user._id,
            amount: AMOUNT,
            note: "Refund of failed withdrawal"
        });

        const reversalIds = reversals.map(t => t._id);
        const credits = await LedgerEntry.find({
            userId: user._id,
            transactionId: { $in: reversalIds },
            direction: "CREDIT",
            amount: AMOUNT,
            balanceAfter: EXPECTED_BALANCE
        });

        console.log("\n--- PERMANENT-REFUSAL TEST RESULTS ---");
        console.log("Database:", mongoose.connection.name);
        console.log("Withdrawal status:", finalWithdrawal?.status);
        console.log("Failure reason:", finalWithdrawal?.failureReason);
        console.log("Bank reference:", finalWithdrawal?.bankRef);
        console.log("Outbox status:", finalJob?.status);
        console.log("Attempts:", finalJob?.attempts);
        console.log("Outbox last error:", finalJob?.lastError);
        console.log("Wallet balance (paise):", finalWallet?.balance);
        console.log("Reversal transactions:", reversals.length);
        console.log("Matching credit ledger entries:", credits.length);

        const passed =
            finalWithdrawal?.status === "REVERSED" &&
            finalWithdrawal?.failureReason ===
                "Simulated permanent bank refusal" &&
            finalWithdrawal?.bankRef == null &&
            finalJob?.status === "DONE" &&
            finalJob?.attempts === 1 &&
            finalJob?.lockedAt == null &&
            finalJob?.lastError ===
                "Simulated permanent bank refusal" &&
            finalWallet?.balance === EXPECTED_BALANCE &&
            reversals.length === 1 &&
            credits.length === 1;

        if (!passed) {
            throw new Error(
                "TEST DID NOT PASS. Preserve all records for inspection; do not rerun."
            );
        }

        console.log(
            "\nPASS: Permanent refusal reversed the withdrawal exactly once."
        );
    } finally {
        await mongoose.disconnect();
        console.log("MongoDB disconnected.");
    }
}

run().catch(error => {
    console.error("TEST STOPPED:", error.message);
    process.exitCode = 1;
});
