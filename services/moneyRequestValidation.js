const { z } = require("zod");

const createRequestSchema = z.object({
    to: z.string().trim().toLowerCase().email(),
    amount: z.number().int().min(100).max(1000000),
    note: z.string().trim().max(100).optional().default("")
});

const payRequestSchema = z.object({
    pin: z.string().regex(
        /^\d{4,6}$/,
        "Enter a valid payment PIN"
    )
});

module.exports = {
    createRequestSchema,
    payRequestSchema
};