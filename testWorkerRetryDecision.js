const test = require("node:test");
const assert = require("node:assert/strict");
const { getRetryDecision } = require("./withdrawalRetryPolicy");

test("temporary processing at attempt 1 schedules retry", () => {
    assert.equal(getRetryDecision(1), "RETRY");
});

test("temporary processing at attempt 3 still schedules retry", () => {
    assert.equal(getRetryDecision(3), "RETRY");
});

test("temporary processing at attempt 4 still schedules retry", () => {
    assert.equal(getRetryDecision(4), "RETRY");
});

test("attempt 5 reaches the review threshold", () => {
    assert.equal(getRetryDecision(5), "NEEDS_REVIEW");
});
