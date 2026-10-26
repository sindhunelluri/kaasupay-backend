const { transferToBank } = require("./fakeBank");

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

function callBankWithTimeout(amount, mode) {
    return Promise.race([
        transferToBank({ amount, mode }),
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error("Bank request timed out"));
            }, 3000);
        })
    ]);
}

async function transferWithRetry({ amount, mode = "normal" }) {
    const delays = [1000, 2000, 4000];  //defines the retry waits in milliseconds.

    //for runs the initial attempt and allows up to three retries.
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            console.log(`Bank attempt ${attempt + 1}`);

            return await callBankWithTimeout(amount, mode); //gives each bank attempt a 3-second limit.
        } catch (error) {
            console.log(`Attempt ${attempt + 1} failed: ${error.message}`);

            if (attempt === delays.length) {
                throw error;
            }

            console.log(`Retrying in ${delays[attempt] / 1000} second(s)...`);
            await sleep(delays[attempt]);
        }
    }
}

module.exports = { transferWithRetry };
