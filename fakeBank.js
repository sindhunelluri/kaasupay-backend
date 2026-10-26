//sleep() simulates a bank that takes time to respond
const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

//mode = "normal" makes the bank respond immediately by default
async function transferToBank({ amount, mode = "normal" }) {
    //mode === "slow" makes the bank wait five seconds
    if (mode === "slow") {
        await sleep(5000);

        return {
            status: "SUCCESS",
            amount,
            bankReference: `BANK-${Date.now()}`
        };
    }
//mode === "fail" simulates a bank error
    if (mode === "fail") {
        throw new Error("Fake bank is unavailable");
    }

    return {
        status: "SUCCESS",
        amount,
        bankReference: `BANK-${Date.now()}` //bankReference is a fake reference for demonstration purposes only
    };
}

module.exports = { transferToBank };
