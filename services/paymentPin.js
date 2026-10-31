const bcrypt = require("bcryptjs");
const { User } = require("../db");

const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_MS = 15 * 60 * 1000;

// ---------- PIN format and strength ----------
const PIN_FORMAT = /^(\d{4}|\d{6})$/;

const COMMON_PINS = new Set([
    "1234", "4321", "1122", "1212", "2580", "0852", "1004", "2000",
    "2001", "1010", "6969", "1313", "2222", "5555", "7777", "9999",
    "123456", "654321", "123123", "112233", "121212", "111222"
]);

function isEasyPin(pin) {
    if (/^(\d)\1+$/.test(pin)) return true;          // 1111, 000000
    if (COMMON_PINS.has(pin)) return true;
    const digits = [...pin].map(Number);
    const up = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
    const down = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
    return up || down;                               // 2345, 9876
}

// Returns an error message, or null when the PIN is acceptable.
function pinProblem(pin) {
    if (typeof pin !== "string" || !PIN_FORMAT.test(pin)) {
        return "PIN must be 4 or 6 digits";
    }
    if (isEasyPin(pin)) return "PIN is too easy to guess";
    return null;
}

// ---------- the lock ----------
// Reserve a try FIRST (one atomic update), compare the PIN second.
// Requests that cannot reserve a try never reach bcrypt, so ten guesses
// sent at the same moment still get only three real checks.
async function verifyPaymentPin(userId, pin) {
    const now = new Date();

    // 1. A lock that has run out is cleared; the user gets fresh tries.
    await User.updateOne(
        { _id: userId, pinLockedUntil: { $lte: now } },
        { $set: { pinFailedAttempts: 0, pinLockedUntil: null } }
    );

    const user = await User.findById(userId)
        .select("+paymentPinHash pinLockedUntil");

    if (!user || !user.paymentPinHash) {
        return { ok: false, status: "PIN_NOT_SET" };
    }

    if (user.pinLockedUntil && user.pinLockedUntil > now) {
        return lockedResult(user.pinLockedUntil);
    }

    // 2. Reserve one try. When this is the third try, the lock is set in
    //    the same step, so every request arriving after it sees the lock.
    const lockUntil = new Date(Date.now() + LOCKOUT_MS);
    const reserved = await User.findOneAndUpdate(
        {
            _id: userId,
            paymentPinHash: { $ne: null },
            pinFailedAttempts: { $lt: MAX_FAILED_ATTEMPTS },
            pinLockedUntil: null
        },
        [
            {
                $set: {
                    pinFailedAttempts: {
                        $add: [{ $ifNull: ["$pinFailedAttempts", 0] }, 1]
                    }
                }
            },
            {
                $set: {
                    pinLockedUntil: {
                        $cond: [
                            { $gte: ["$pinFailedAttempts", MAX_FAILED_ATTEMPTS] },
                            lockUntil,
                            "$pinLockedUntil"
                        ]
                    }
                }
            }
        ],
        { 
            updatePipeline: true,
            returnDocument: "after" }
    ).select("pinFailedAttempts pinLockedUntil");

    if (!reserved) {
        // Someone else used the last try (or locked it) a moment ago.
        const latest = await User.findById(userId).select("pinLockedUntil");
        if (latest?.pinLockedUntil && latest.pinLockedUntil > new Date()) {
            return lockedResult(latest.pinLockedUntil);
        }
        return { ok: false, status: "PIN_RETRY" };
    }

    // 3. Now compare.
    const matches = await bcrypt.compare(pin, user.paymentPinHash);

    if (matches) {
        await User.updateOne(
            { _id: userId },
            { $set: { pinFailedAttempts: 0, pinLockedUntil: null } }
        );
        return { ok: true, status: "PIN_VERIFIED" };
    }

    if (reserved.pinFailedAttempts >= MAX_FAILED_ATTEMPTS) {
        return lockedResult(reserved.pinLockedUntil || lockUntil);
    }

    return {
        ok: false,
        status: "INVALID_PIN",
        attemptsRemaining: MAX_FAILED_ATTEMPTS - reserved.pinFailedAttempts
    };
}

function lockedResult(until) {
    return {
        ok: false,
        status: "PIN_LOCKED",
        retryAfterSeconds: Math.max(
            1,
            Math.ceil((new Date(until).getTime() - Date.now()) / 1000)
        )
    };
}

// Turns a failed result into the HTTP reply. Returns true when it replied.
function sendPinFailure(res, r) {
    if (r.ok) return false;

    if (r.status === "PIN_NOT_SET") {
        res.status(400).json({
            error: "Set your payment PIN first",
            message: "Set your payment PIN first"
        });
    } else if (r.status === "PIN_LOCKED") {
        res.set("Retry-After", String(r.retryAfterSeconds));
        res.status(423).json({
            error: "PIN locked. Try again later",
            message: "PIN locked. Try again later",
            retryAfterSeconds: r.retryAfterSeconds
        });
    } else if (r.status === "PIN_RETRY") {
        res.status(409).json({
            error: "PIN check conflicted with another request. Try again.",
            message: "PIN check conflicted with another request. Try again."
        });
    } else {
        const n = r.attemptsRemaining;
        const text = `Wrong PIN. ${n} ${n === 1 ? "try" : "tries"} left`;
        res.status(403).json({
            error: text,
            message: text,
            triesLeft: n,
            attemptsRemaining: n
        });
    }
    return true;
}

module.exports = {
    verifyPaymentPin,
    sendPinFailure,
    pinProblem,
    isEasyPin,
    PIN_FORMAT,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_MS
};
