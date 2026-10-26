const test = require("node:test");
const assert = require("node:assert/strict");
const { retryDelayMs } = require("./withdrawalRetryPolicy");

test("attempt 1 delay is 2000-2999 ms", () => {
    assert.equal(retryDelayMs(1, 0), 2000);
    assert.equal(retryDelayMs(1, 0.999), 2999);
});

test("attempt 2 delay is 4000-4999 ms", () => {
    assert.equal(retryDelayMs(2, 0), 4000);
    assert.equal(retryDelayMs(2, 0.999), 4999);
});

test("attempt 3 delay is 8000-8999 ms", () => {
    assert.equal(retryDelayMs(3, 0), 8000);
    assert.equal(retryDelayMs(3, 0.999), 8999);
});

test("delay is capped at 30000-30999 ms", () => {
    assert.equal(retryDelayMs(5, 0), 30000);
    assert.equal(retryDelayMs(10, 0.999), 30999);
});

test("invalid attempt numbers are rejected", () => {
    assert.throws(() => retryDelayMs(0, 0), TypeError);
    assert.throws(() => retryDelayMs(1.5, 0), TypeError);
});

test("invalid random values are rejected", () => {
    assert.throws(() => retryDelayMs(1, -0.1), RangeError);
    assert.throws(() => retryDelayMs(1, 1), RangeError);
});
