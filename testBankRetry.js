const { transferWithRetry } = require("./bankRetry");

async function main() {
    try {
        const result = await transferWithRetry({
            amount: 500,
            mode: "slow" //change to "normal" or "slow" to test different scenarios
        });

        console.log("Final result:", result);
    } catch (error) {
        console.log("All attempts failed:", error.message);
    }
}

main();



/* OUTPUT:
mode:"normal"
Bank attempt 1
Final result: { status: 'SUCCESS', amount: 500, bankReference: 'BANK-1792082217211' } */

/* OUTPUT:
mode:"slow"
Bank attempt 1
Attempt 1 failed: Fake bank is unavailable
Retrying in 1 second(s)...
Bank attempt 2
Attempt 2 failed: Fake bank is unavailable
Retrying in 2 second(s)...
Bank attempt 3
Attempt 3 failed: Fake bank is unavailable
Retrying in 4 second(s)...
Bank attempt 4
Attempt 4 failed: Fake bank is unavailable
All attempts failed: Fake bank is unavailable */