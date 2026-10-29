require("dotenv").config();

const mongoose = require("mongoose");

(async () => {
    const originalUri = process.env.MONGO_URL;
    if (!originalUri) throw new Error("MONGO_URL is missing");

    const testUri = originalUri.replace(
        /\/kaasupay(?:_test)?(?=\?|$)/,
        "/kaasupay_worker_test"
    );

    if (testUri === originalUri) {
        throw new Error("Cannot select isolated test database safely");
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
        PaymentOrder,
        Transaction,
        LedgerEntry
    } = require("./db");

    const { processNextWithdrawal } = require("./worker");

    try {
        await connectDB();

        if (mongoose.connection.name !== "kaasupay_worker_test") {
            throw new Error("Wrong database; refusing to continue");
        }

        const models = [
            User, Wallet, BankAccount, Withdrawal,
            OutboxEvent, PaymentOrder, Transaction, LedgerEntry
        ];

        for (const Model of models) {
            const count = await Model.countDocuments();
            console.log(`${Model.collection.name}: ${count}`);

            if (count !== 0) {
                throw new Error(
                    `${Model.collection.name} is not empty. No test was started.`
                );
            }
        }

        console.log("\nSafety checks passed. Creating one synthetic test withdrawal.");

        const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const reference = `wd_worker_test_${suffix}`;

        const user = await User.create({
            username: `worker_test_${suffix}`,
            firstName: "Worker",
            lastName: "Test",
            passwordHash: "test-only-not-a-real-password-hash"
        });

        await Wallet.create({
            userId: user._id,
            balance: 30000
        });

        const bankAccount = await BankAccount.create({
            userId: user._id,
            holderName: "Worker Test User",
            accountNumber: "123456789012",
            ifsc: "TEST0000123",
            last4: "9012"
        });

        const withdrawal = await Withdrawal.create({
            userId: user._id,
            bankAccountId: bankAccount._id,
            amount: 10000,
            reference,
            status: "PENDING"
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

        console.log("Test reference:", reference);
        console.log("Synthetic withdrawal created:", withdrawal._id.toString());
        console.log("Calling worker once...");

        await processNextWithdrawal();

        const finalWithdrawal = await Withdrawal.findById(withdrawal._id).lean();
        const finalJob = await OutboxEvent.findById(job._id).lean();
        const finalWallet = await Wallet.findOne({ userId: user._id }).lean();

        console.log("\n--- WORKER TEST RESULTS ---");
        console.log("Database:", mongoose.connection.name);
        console.log("Withdrawal status:", finalWithdrawal?.status);
        console.log("Bank reference:", finalWithdrawal?.bankRef);
        console.log("Outbox status:", finalJob?.status);
        console.log("Attempts:", finalJob?.attempts);
        console.log("Last error:", finalJob?.lastError);
        console.log("Wallet balance (paise):", finalWallet?.balance);

        const passed =
            finalWithdrawal?.status === "SUCCESS" &&
            typeof finalWithdrawal?.bankRef === "string" &&
            finalWithdrawal.bankRef.startsWith("FAKEBANK_") &&
            finalJob?.status === "DONE" &&
            finalJob?.attempts === 1 &&
            finalWallet?.balance === 30000;

        console.log(passed
            ? "\nPASS: One-shot worker processing succeeded."
            : "\nNOT PASSED: Review the results above before retrying.");

        if (!passed) process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        console.log("MongoDB disconnected.");
    }
})().catch(error => {
    console.error("Worker test stopped:", error.message);
    process.exitCode = 1;
});
