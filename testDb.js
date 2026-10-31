
require("dotenv").config();

const mongoose = require("mongoose");

async function connectTestDB() {
    const uri = process.env.MONGO_URL;

    if (!uri) {
        throw new Error("MONGO_URL is missing from .env");
    }

    const databaseName = new URL(uri).pathname.replace(/^\/+/, "");

    let testUri;

    if (databaseName === "kaasupay_test") {
        // Already using the isolated test database.
        testUri = uri;
    } else if (databaseName === "kaasupay") {
        // Convert the development database to the test database.
        testUri = uri.replace(
            /\/kaasupay(?=\?|$)/,
            "/kaasupay_test"
        );
    } else {
        throw new Error(
            `Unsafe database name: ${databaseName}. No connection was made.`
        );
    }

    await mongoose.connect(testUri);

    console.log("Connected to isolated kaasupay_test database");
}

module.exports = { connectTestDB, mongoose };
