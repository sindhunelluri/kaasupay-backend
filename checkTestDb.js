const { connectTestDB, mongoose } = require("./testDb");

async function main() {
    await connectTestDB();

    const testConnection = mongoose.connection;

    const collections = [
        "bankaccounts",
        "withdrawals",
        "outboxevents"
    ];

    console.log("Test database:", testConnection.name);
    console.log("Collections to be used by isolated tests:");

    for (const name of collections) {
        console.log(`- ${name}`);
    }

    await mongoose.disconnect();
}

main().catch(async error => {
    console.error("Test connection check failed:", error.message);
    await mongoose.disconnect();
    process.exitCode = 1;
});
