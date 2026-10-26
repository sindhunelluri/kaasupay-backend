
require("dotenv").config();
const mongoose = require("mongoose");

async function checkTransactions() {
    let session;

    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log("Connected to MongoDB Atlas.");

        session = await mongoose.startSession();

        await session.withTransaction(async () => {
            // A harmless read inside a transaction.
            await mongoose.connection.db
                .collection("users")
                .findOne({}, { session });

            console.log("Transaction callback executed.");
        });

        console.log("Transaction completed successfully.");
    } catch (error) {
        console.error("Transaction test failed:", error.message);
    } finally {
        if (session) await session.endSession();
        await mongoose.disconnect();
    }
}

checkTransactions();
