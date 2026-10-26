const MAX_ATTEMPTS = 5;

function shouldMoveToReview(attempts) {
    return attempts >= MAX_ATTEMPTS;
}

for (let attempts = 1; attempts <= 6; attempts++) {
    console.log(
        `Attempts: ${attempts} -> ${
            shouldMoveToReview(attempts)
                ? "NEEDS_REVIEW"
                : "RETRY"
        }`
    );
}

console.log("\nExpected: attempts 1-4 retry; attempt 5 or later needs review.");
