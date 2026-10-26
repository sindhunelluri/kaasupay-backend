const express = require("express");
const { z } = require("zod");
const bankBreaker = require("../bankCircuitBreaker");

// OLD: Direct fake-bank import (kept for reference)
// const { transferToBank } = require("../fakeBank");

const router = express.Router();

const payoutSchema = z.object({
    amount: z.number().int().positive(),
    mode: z.enum(["normal", "slow", "fail"]).optional()
});

// Creates a POST API endpoint
router.post("/demo", async (req, res) => {
    // Validates the incoming request
    const result = payoutSchema.safeParse(req.body);

    if (!result.success) {
        return res.status(400).json({
            error: "Amount must be a positive integer and mode must be normal, slow, or fail"
        });
    }

    // Normal mode is the default when no mode is supplied.
    const { amount, mode = "normal" } = result.data;

    try {
        // NEW: Opossum manages the timeout and circuit-breaker state.
        const bankResponse = await bankBreaker.fire({
            amount,
            mode
        });

        return res.status(200).json({
            message: "Demo bank payout completed",
            ...bankResponse
        });

        /*
        OLD IMPLEMENTATION — KEPT FOR REFERENCE

        const bankResponse = await Promise.race([
            transferToBank({
                amount,
                mode
            }),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error("Bank request timed out"));
                }, 3000);
            })
        ]);

        return res.status(200).json({
            message: "Demo bank payout completed",
            ...bankResponse
        });
        */
    } catch (error) {
        console.error("Demo bank error:", error.message);

        // Handles timeout errors
        if (
            error.code === "ETIMEDOUT" ||
            error.message === "Bank request timed out" ||
            error.message.startsWith("Timed out")
        ) {
            return res.status(504).json({
                error: "Bank request timed out",
                message: "The bank did not respond within 3 seconds"
            });
        }

        // Handles bank failures or an open circuit
        return res.status(503).json({
            error: "Demo bank is unavailable"
        });
    }
});

module.exports = router;
