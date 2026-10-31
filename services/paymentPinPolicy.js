const WEAK_PINS = new Set([
    "0000",
    "1111",
    "1234",
    "123456",
    "654321",
    "1212",
    "2580",
    "4321",
]);

function isWeakPaymentPin(pin) {
    const repeatedDigits = /^(\d)\1+$/.test(pin);

    return WEAK_PINS.has(pin) || repeatedDigits;
}

module.exports = { isWeakPaymentPin };