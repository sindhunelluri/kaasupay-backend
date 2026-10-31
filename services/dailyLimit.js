const { DailyTransferLimit } = require("../db");
const { getIndiaDayKey } = require("../utils/indiaDate");
const config = require("../config");

// Falls back to ₹10,000 if an old config.js (without the new value) is still in use.
const DAILY_SEND_LIMIT = Number.isInteger(config.DAILY_SEND_LIMIT)
    ? config.DAILY_SEND_LIMIT
    : 1_000_000;

// Midnight in India (as a real moment) after the given India day key.
function nextIndiaMidnight(dayKey = getIndiaDayKey()) {
    const [y, m, d] = dayKey.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - 330 * 60 * 1000);
}

// Call BEFORE session.withTransaction. Creating an empty counter does not
// use any of the limit, and a duplicate-key clash only means it already exists.
async function ensureDailyCounter(userId, dayKey = getIndiaDayKey()) {
    try {
        await DailyTransferLimit.updateOne(
            { userId, dayKey },
            { $setOnInsert: { userId, dayKey, totalAmount: 0 } },
            { upsert: true }
        );
    } catch (error) {
        if (error.code !== 11000) throw error;
    }
}

// Call INSIDE the transaction. Adds the amount only if it still fits.
// If the transaction later rolls back, this change rolls back with it.
async function reserveDailyLimit(userId, amount, session, dayKey = getIndiaDayKey()) {
    const counter = await DailyTransferLimit.findOneAndUpdate(
        { userId, dayKey, totalAmount: { $lte: DAILY_SEND_LIMIT - amount } },
        { $inc: { totalAmount: amount } },
        { returnDocument: "after", session }
    );

    if (!counter) {
        const current = await DailyTransferLimit.findOne({ userId, dayKey }).session(session);
        const used = current ? current.totalAmount : 0;
        const error = new Error("Daily limit reached");
        error.status = 400;
        error.extra = { leftToday: Math.max(0, DAILY_SEND_LIMIT - used) };
        throw error;
    }
    return counter;
}

async function getDailyUsage(userId) {
    const dayKey = getIndiaDayKey();
    const counter = await DailyTransferLimit.findOne({ userId, dayKey }).lean();
    const usedToday = counter ? counter.totalAmount : 0;
    return {
        dailyLimit: DAILY_SEND_LIMIT,
        usedToday,
        leftToday: Math.max(0, DAILY_SEND_LIMIT - usedToday),
        resetsAt: nextIndiaMidnight(dayKey).toISOString()
    };
}

module.exports = { ensureDailyCounter, reserveDailyLimit, getDailyUsage, nextIndiaMidnight };