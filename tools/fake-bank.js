
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = 4000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "processed-payouts.json");

// Change using FAKE_BANK_MODE: SUCCESS, FAILED, or PROCESSING.
const TEST_MODE = process.env.FAKE_BANK_MODE || "SUCCESS";

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadPayouts() {
    try {
        const content = fs.readFileSync(DATA_FILE, "utf8");
        const parsed = JSON.parse(content);

        if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
        ) {
            throw new Error("Payout data must be a JSON object");
        }

        return parsed;
    } catch (error) {
        if (error.code === "ENOENT") {
            return {};
        }

        throw error;
    }
}

const processedPayouts = loadPayouts();

function savePayout(reference, result) {
    // Write a temporary file first to avoid leaving a partial JSON file.
    const temporaryFile = `${DATA_FILE}.tmp`;

    processedPayouts[reference] = result;

    try {
        fs.writeFileSync(
            temporaryFile,
            JSON.stringify(processedPayouts, null, 2),
            "utf8"
        );

        fs.renameSync(temporaryFile, DATA_FILE);
    } catch (error) {
        delete processedPayouts[reference];
        throw error;
    }
}

app.post("/payouts", (req, res) => {
    const { reference, accountNumber, ifsc, amount } = req.body || {};

    if (
        typeof reference !== "string" ||
        !reference.trim() ||
        typeof accountNumber !== "string" ||
        !/^\d{9,18}$/.test(accountNumber) ||
        typeof ifsc !== "string" ||
        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) ||
        !Number.isSafeInteger(amount) ||
        amount < 10000
    ) {
        return res.status(400).json({
            status: "FAILED",
            permanent: true,
            message: "Invalid payout details"
        });
    }

    // A previously processed reference always gets its original result.
    if (processedPayouts[reference]) {
        return res.json(processedPayouts[reference]);
    }

    if (TEST_MODE === "FAILED") {
        const result = {
            status: "FAILED",
            permanent: true,
            message: "Simulated permanent bank refusal"
        };

        savePayout(reference, result);
        console.log(`Fake bank permanently refused: ${reference}`);
        return res.status(422).json(result);
    }

    if (TEST_MODE === "PROCESSING") {
        // Do not persist this temporary result.
        console.log(`Fake bank still processing: ${reference}`);
        return res.json({
            status: "PROCESSING",
            message: "Simulated temporary processing"
        });
    }

    const result = {
        status: "SUCCESS",
        bankRef: `FAKEBANK_${reference}`
    };

    savePayout(reference, result);

    console.log(
        `Fake payout successful: ${reference}, amount ${amount} paise`
    );

    return res.json(result);
});

app.get("/", (req, res) => {
    res.json({
        message: "KaasuPay fake bank is running",
        mode: TEST_MODE
    });
});

app.listen(PORT, () => {
    console.log(`Fake bank running on http://localhost:${PORT}`);
    console.log(`Fake bank mode: ${TEST_MODE}`);
});
