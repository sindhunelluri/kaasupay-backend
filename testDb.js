require("dotenv").config();

const mongoose = require("mongoose");

async function connectTestDB() {
    const uri = process.env.MONGO_URL;

    if (!uri) {
        throw new Error("MONGO_URL is missing from .env");
    }

    const testUri = uri.replace(
        /\/kaasupay(?=\?|$)/,
        "/kaasupay_test"
    );

    if (testUri === uri) {
        throw new Error(
            "Could not identify the kaasupay database in MONGO_URL. No connection was made."
        );
    }

    await mongoose.connect(testUri);
    console.log("Connected to isolated kaasupay_test database");
}

module.exports = { connectTestDB, mongoose };
