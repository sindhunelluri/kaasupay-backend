const test = require("node:test");
const assert = require("node:assert/strict");

const { isWeakPaymentPin } = require("../services/paymentPinPolicy");

test("rejects common weak PINs", () => {
    const weakPins = [
        "0000",
        "1111",
        "1234",
        "123456",
        "654321",
        "1212",
        "2580",
        "4321",
    ];

    for (const pin of weakPins) {
        assert.equal(isWeakPaymentPin(pin), true, `${pin} should be rejected`);
    }
});

test("rejects repeated digits", () => {
    assert.equal(isWeakPaymentPin("2222"), true);
    assert.equal(isWeakPaymentPin("999999"), true);
});

test("accepts non-common PINs", () => {
    assert.equal(isWeakPaymentPin("4826"), false);
    assert.equal(isWeakPaymentPin("739152"), false);
});