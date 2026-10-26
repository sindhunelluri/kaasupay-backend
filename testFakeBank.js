const { transferToBank } = require("./fakeBank");

async function main() {
    console.time("Bank response");

    const result = await transferToBank({
        amount: 500,
        mode: "slow"
    });

    console.timeEnd("Bank response");
    console.log(result);
}

main().catch(console.error);
