
const test = require("node:test");
const assert = require("node:assert/strict");

const DAILY_LIMIT = 1_000_000; // â‚¹10,000 in paise
const { getIndiaDayKey } = require("../utils/indiaDate");

function canTransfer(currentTotal, amount) {
    return currentTotal + amount <= DAILY_LIMIT;
}

test("allows a transfer within the daily limit", () => {
    assert.equal(canTransfer(0, 500_000), true);
});

test("allows a transfer that reaches exactly â‚¹10,000", () => {
    assert.equal(canTransfer(900_000, 100_000), true);
});

test("rejects a transfer that exceeds the daily limit", () => {
    assert.equal(canTransfer(900_000, 100_001), false);
});

test("rejects another transfer after the limit is reached", () => {
    assert.equal(canTransfer(1_000_000, 100), false);
});

test("allows a transfer when the daily total is zero", () => {
    assert.equal(canTransfer(0, 100), true);
});




test("uses the Indian calendar date for the daily limit", () => {
    assert.equal(
        getIndiaDayKey(
            new Date("2026-10-26T18:45:00.000Z")
        ),
        "2026-10-27"
    );
});

test("handles a date that is still the previous day in India", () => {
    assert.equal(
        getIndiaDayKey(
            new Date("2026-10-26T17:00:00.000Z")
        ),
        "2026-10-26"
    );
});
