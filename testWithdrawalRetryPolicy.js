const test = require("node:test");
const assert = require("node:assert/strict");

const {
    MAX_ATTEMPTS,
    shouldMoveToReview,
    getRetryDecision
} = require("./withdrawalRetryPolicy");

test("attempts 1 through 4 should retry", () => {
    for (let attempts = 1; attempts < MAX_ATTEMPTS; attempts++) {
        assert.equal(getRetryDecision(attempts), "RETRY");
    }
});

test("attempt 5 and above should require review", () => {
    assert.equal(getRetryDecision(5), "NEEDS_REVIEW");
    assert.equal(getRetryDecision(6), "NEEDS_REVIEW");
});

test("review threshold is exactly five attempts", () => {
    assert.equal(shouldMoveToReview(4), false);
    assert.equal(shouldMoveToReview(5), true);
});

test("invalid attempt counts are rejected", () => {
    assert.throws(() => getRetryDecision(0), TypeError);
    assert.throws(() => getRetryDecision(-1), TypeError);
    assert.throws(() => getRetryDecision(1.5), TypeError);
});
