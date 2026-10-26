require("dotenv").config();

const originalUri = process.env.MONGO_URL;

if (!originalUri) {
    throw new Error("MONGO_URL is missing from .env");
}

const testUri = originalUri.replace(
    /\/kaasupay(?=\?|$)/,
    "/kaasupay_test"
);

if (testUri === originalUri) {
    throw new Error("Could not safely select kaasupay_test. No database connection made.");
}

process.env.MONGO_URL = testUri;

const mongoose = require("mongoose");
const { connectDB } = require("./db");
const worker = require("./worker");

async function main() {
    await connectDB();

    if (mongoose.connection.name !== "kaasupay_test") {
        throw new Error(
            `Safety check failed: connected to ${mongoose.connection.name}`
        );
    }

    console.log("Safety check passed: connected to kaasupay_test");
    console.log("Worker function available:", typeof worker.processNextWithdrawal);
    console.log("No withdrawal processing was started.");

    await mongoose.disconnect();
}

main().catch(async error => {
    console.error("Test runner failed:", error.message);

    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }

    process.exitCode = 1;
});
