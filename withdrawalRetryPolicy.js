const MAX_ATTEMPTS = 5;

function shouldMoveToReview(attempts) {
    return Number.isInteger(attempts) && attempts >= MAX_ATTEMPTS;
}

function getRetryDecision(attempts) {
    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new TypeError("attempts must be a positive integer");
    }

    return shouldMoveToReview(attempts)
        ? "NEEDS_REVIEW"
        : "RETRY";
}

function retryDelayMs(attempts, randomValue = Math.random()) {
    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new TypeError("attempts must be a positive integer");
    }

    if (typeof randomValue !== "number" ||
        randomValue < 0 || randomValue >= 1) {
        throw new RangeError("randomValue must be between 0 and 1");
    }

    const baseMs = Math.min(2000 * (2 ** (attempts - 1)), 30_000);
    return baseMs + Math.floor(randomValue * 1000);
}

module.exports = {
    MAX_ATTEMPTS,
    shouldMoveToReview,
    getRetryDecision,
    retryDelayMs
};
