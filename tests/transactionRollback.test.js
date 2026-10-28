const test = require("node:test");
const assert = require("node:assert/strict");
require("dotenv").config();

const { connectTestDB, mongoose } = require("../testDb");

test("MongoDB transaction rolls back a partial write", async (t) => {
    await connectTestDB();

    t.after(async () => {
        await mongoose.disconnect();
    });

    assert.equal(mongoose.connection.name, "kaasupay_test");

    const collectionName = "integration_rollback_test";
    const collection = mongoose.connection.collection(collectionName);
    const marker = `rollback-${Date.now()}-${Math.random()}`;

    const session = await mongoose.startSession();

    try {
        await assert.rejects(
            session.withTransaction(async () => {
                await collection.insertOne(
                    { marker, value: "temporary" },
                    { session }
                );

                throw new Error("Intentional rollback test");
            }),
            /Intentional rollback test/
        );

        const found = await collection.findOne({ marker });

        assert.equal(found, null);
    } finally {
        await session.endSession();
        await collection.deleteOne({ marker });
    }
});