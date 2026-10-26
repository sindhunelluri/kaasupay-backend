require("dotenv").config();

const mongoose = require("mongoose");

async function main() {
    const originalUri = process.env.MONGO_URL;

    if (!originalUri) {
        throw new Error("MONGO_URL is missing");
    }

    const testUri = originalUri.replace(
        /\/kaasupay(?=\?|$)/,
        "/kaasupay_test"
    );

    if (testUri === originalUri) {
        throw new Error("Could not safely select kaasupay_test");
    }

    await mongoose.connect(testUri);

    if (mongoose.connection.name !== "kaasupay_test") {
        throw new Error("Connected to an unexpected database");
    }

    const withdrawals = await mongoose.connection
        .collection("withdrawals")
        .countDocuments();

    const jobs = await mongoose.connection
        .collection("outboxevents")
        .countDocuments();

    console.log("Database:", mongoose.connection.name);
    console.log("Existing withdrawals:", withdrawals);
    console.log("Existing outbox jobs:", jobs);

    await mongoose.disconnect();
}

main().catch(async error => {
    console.error("Check failed:", error.message);
    await mongoose.disconnect();
    process.exitCode = 1;
});
