// Configuration / secrets

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is missing in .env");
}

// Most money that can leave one wallet in one India day (paise).
// Sends and withdrawals count together. Change it here only.
const DAILY_SEND_LIMIT = 1_000_000; // ₹10,000

module.exports = {
    JWT_SECRET,
    DAILY_SEND_LIMIT
};