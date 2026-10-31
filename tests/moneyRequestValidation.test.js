const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createRequestSchema,
    payRequestSchema
} = require("../services/moneyRequestValidation");

// CREATE REQUEST VALIDATION

test("accepts valid money request details", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 1000,
        note: "Lunch payment"
    });

    assert.equal(result.success, true);
});

test("converts email to lowercase and trims spaces", () => {
    const result = createRequestSchema.safeParse({
        to: " PAYER@EXAMPLE.COM ",
        amount: 1000
    });

    assert.equal(result.success, true);
    assert.equal(result.data.to, "payer@example.com");
});

test("rejects invalid email", () => {
    const result = createRequestSchema.safeParse({
        to: "invalid-email",
        amount: 1000
    });

    assert.equal(result.success, false);
});

test("rejects amount below 100 paise", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 99
    });

    assert.equal(result.success, false);
});

test("accepts minimum amount of 100 paise", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 100
    });

    assert.equal(result.success, true);
});

test("accepts maximum amount of 1000000 paise", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 1000000
    });

    assert.equal(result.success, true);
});

test("rejects amount above 1000000 paise", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 1000001
    });

    assert.equal(result.success, false);
});

test("rejects decimal amounts", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 100.5
    });

    assert.equal(result.success, false);
});

test("rejects negative amounts", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: -100
    });

    assert.equal(result.success, false);
});

test("rejects non-numeric amounts", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: "1000"
    });

    assert.equal(result.success, false);
});

test("defaults missing note to empty string", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 1000
    });

    assert.equal(result.success, true);
    assert.equal(result.data.note, "");
});

test("rejects notes longer than 100 characters", () => {
    const result = createRequestSchema.safeParse({
        to: "payer@example.com",
        amount: 1000,
        note: "A".repeat(101)
    });

    assert.equal(result.success, false);
});

// PAYMENT PIN VALIDATION

test("accepts a valid 4-digit PIN", () => {
    const result = payRequestSchema.safeParse({
        pin: "1234"
    });

    assert.equal(result.success, true);
});

test("accepts a valid 6-digit PIN", () => {
    const result = payRequestSchema.safeParse({
        pin: "123456"
    });

    assert.equal(result.success, true);
});

test("rejects a 3-digit PIN", () => {
    const result = payRequestSchema.safeParse({
        pin: "123"
    });

    assert.equal(result.success, false);
});

test("rejects a PIN containing letters", () => {
    const result = payRequestSchema.safeParse({
        pin: "12AB"
    });

    assert.equal(result.success, false);
});

test("rejects a missing PIN", () => {
    const result = payRequestSchema.safeParse({});

    assert.equal(result.success, false);
});