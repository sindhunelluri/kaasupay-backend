
const test = require("node:test");
const assert = require("node:assert/strict");

const { connectTestDB, mongoose } = require("../testDb");
const { DailyTransferLimit } = require("../db");

test("DailyTransferLimit saves and updates a daily total", async (t) => {
    await connectTestDB();

    t.after(async () => {
        await mongoose.disconnect();
    });

    assert.equal(mongoose.connection.name, "kaasupay_test");

    const userId = new mongoose.Types.ObjectId();
    const dayKey = `test-${Date.now()}`;

    try {
        const record = await DailyTransferLimit.create({
            userId,
            dayKey,
            totalAmount: 500_000
        });

        assert.equal(record.totalAmount, 500_000);

        const updated = await DailyTransferLimit.findOneAndUpdate(
            { userId, dayKey },
            { $inc: { totalAmount: 100_000 } },
            { returnDocument: "after" }
        );

        assert.equal(updated.totalAmount, 600_000);

        console.log("Verified: ₹5,000 + ₹1,000 = ₹6,000");
    } finally {
        await DailyTransferLimit.deleteOne({ userId, dayKey });
    }
});
