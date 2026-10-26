const bankBreaker = require("./bankCircuitBreaker");

async function testBank(mode) {
    try {
        const result = await bankBreaker.fire({
            amount: 500,
            mode
        });

        console.log("Bank response:", result);
    } catch (error) {
        console.log("Request rejected:", error.message);
    }
}

async function main() {
    console.log("\n--- Test 1: Bank is failing ---");

    await testBank("fail");
    await testBank("fail");

    console.log("\n--- Test 2: Try another request ---");

    await testBank("fail");

    console.log("\n--- Test 3: Bank is healthy ---");

    await new Promise(resolve => setTimeout(resolve, 11000));
    await testBank("normal");
}

main().catch(console.error);



/* OUTPUT:
--- Test 1: Bank is failing ---
Request rejected: Fake bank is unavailable
CIRCUIT OPEN: Bank requests are blocked
Request rejected: Fake bank is unavailable

--- Test 2: Try another request ---
Request rejected: Breaker is open

--- Test 3: Bank is healthy ---
CIRCUIT HALF-OPEN: Testing bank recovery
CIRCUIT CLOSED: Bank is available again
Bank response: { status: 'SUCCESS', amount: 500, bankReference: 'BANK-1792082712512' }
*/