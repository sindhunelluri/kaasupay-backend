const CircuitBreaker = require("opossum");
const { transferToBank } = require("./fakeBank");

const options = {
    timeout: 3000, //Stop waiting after 3 seconds.
    errorThresholdPercentage: 50, //Open the breaker when the failure percentage reaches 50%.
    resetTimeout: 10000, //Wait 10 seconds before allowing a recovery test.
    volumeThreshold: 2 //Require at least two requests before the failure percentage can open the breaker.
};

const bankBreaker = new CircuitBreaker(transferToBank, options);

// Log failures detected by Opossum.
bankBreaker.on("failure", (error) => {
    console.log("BREAKER FAILURE:", error?.message);
});

bankBreaker.on("timeout", () => {
    console.log("BREAKER TIMEOUT");
});

//OPEN The bank has failed repeatedly. New calls are blocked.
bankBreaker.on("open", () => {
    console.log("CIRCUIT OPEN: Bank requests are blocked");
});

//HALF-OPEN After 10 seconds, Opossum allows a recovery test.
bankBreaker.on("halfOpen", () => {
    console.log("CIRCUIT HALF-OPEN: Testing bank recovery");
});
//CLOSED — Normal operation Requests are allowed to reach the fake bank.
bankBreaker.on("close", () => {
    console.log("CIRCUIT CLOSED: Bank is available again");
});

module.exports = bankBreaker;
