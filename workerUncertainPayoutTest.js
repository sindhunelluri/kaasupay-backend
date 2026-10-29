require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const mongoose = require("mongoose");

const EXPECTED_DB = "kaasupay_uncertain_payout_test";
const BANK_URL = "http://127.0.0.1:4000";
const payoutFile = path.join(__dirname, "tools", "data", "processed-payouts.json");

const collections = [
  "users", "wallets", "bankaccounts", "withdrawals",
  "outboxevents", "paymentorders", "transactions",
  "ledgerentries", "idempotencyrecords", "dailytransferlimits"
];

async function run() {
  const uri = new URL(process.env.MONGO_URL);
  uri.pathname = `/${EXPECTED_DB}`;
  process.env.MONGO_URL = uri.toString();
  process.env.BANK_URL = BANK_URL;

  // Verify the fake bank before importing or invoking the worker.
  const bankResponse = await fetch(BANK_URL + "/", {
    signal: AbortSignal.timeout(3000)
  });
  assert.equal(bankResponse.ok, true, "Fake bank is not healthy");
  const bankInfo = await bankResponse.json();
  assert.equal(bankInfo.mode, "PROCESSING", "Fake bank is not in PROCESSING mode");

  const payoutFileHash = () =>
    crypto.createHash("sha256").update(fs.readFileSync(payoutFile)).digest("hex");

  const hashBefore = payoutFileHash();

  const db = require("./db");
  const { processNextWithdrawal } = require("./worker");

  try {
    await db.connectDB();

    assert.equal(mongoose.connection.name, EXPECTED_DB,
      "Wrong database; refusing to continue");

    for (const name of collections) {
      const count = await mongoose.connection.db
        .collection(name).countDocuments();

      console.log(`${name}: ${count}`);
      assert.equal(count, 0,
        `${name} is not empty; no test records should be created`);
    }

    console.log("\nSafety checks passed. Creating synthetic test data.");

    const suffix = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const reference = `uncertain_payout_test_${suffix}`;

    const user = await db.User.create({
      username: `uncertain_test_${suffix}`,
      firstName: "Synthetic",
      lastName: "Test",
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
      reference,
      status: "PENDING"
    });

    const job = await db.OutboxEvent.create({
      type: "PAYOUT_REQUESTED",
      withdrawalId: withdrawal._id,
      status: "NEW",
      attempts: 0,
      nextAttemptAt: new Date(),
      lockedAt: null
    });

    console.log("Synthetic reference:", reference);
    console.log("Calling processNextWithdrawal() once...");
    await processNextWithdrawal();

    const finalWithdrawal = await db.Withdrawal.findById(withdrawal._id).lean();
    const finalJob = await db.OutboxEvent.findById(job._id).lean();
    const finalWallet = await db.Wallet.findById(wallet._id).lean();

    console.log("\n--- RESULTS ---");
    console.log("Database:", mongoose.connection.name);
    console.log("Withdrawal status:", finalWithdrawal.status);
    console.log("Outbox status:", finalJob.status);
    console.log("Job lock:", finalJob.lockedAt);
    console.log("Attempts:", finalJob.attempts);
    console.log("Wallet balance (paise):", finalWallet.balance);
    console.log("Failure reason:", finalWithdrawal.failureReason);

    assert.equal(finalWithdrawal.status, "NEEDS_REVIEW");
    assert.equal(finalJob.status, "STUCK");
    assert.equal(finalJob.lockedAt, null);
    assert.equal(finalJob.attempts, 1);
    assert.equal(finalWallet.balance, 20000);
    assert.equal(payoutFileHash(), hashBefore,
      "Fake bank payout file changed during the test");

    console.log("\nPASS: uncertain response moved to manual review.");
    console.log("Wallet balance stayed unchanged; fake-bank file stayed unchanged.");
  } finally {
    await mongoose.disconnect();
    console.log("MongoDB disconnected.");
  }
}

run().catch(error => {
  console.error("TEST STOPPED/FAILED:", error.message);
  mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
