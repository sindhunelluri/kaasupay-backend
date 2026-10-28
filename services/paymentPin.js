
const bcrypt = require("bcryptjs");
const { User } = require("../db");

const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_MS = 15 * 60 * 1000;

async function verifyPaymentPin(userId, pin) {
    const user = await User.findById(userId)
        .select("+paymentPinHash pinFailedAttempts pinLockedUntil");

    if (!user || !user.paymentPinHash) {
        return { ok: false, status: "PIN_NOT_SET" };
    }

    const now = new Date();

    if (user.pinLockedUntil && user.pinLockedUntil > now) {
        return {
            ok: false,
            status: "PIN_LOCKED",
            retryAfterSeconds: Math.ceil(
                (user.pinLockedUntil.getTime() - now.getTime()) / 1000
            )
        };
    }

    const matches = await bcrypt.compare(pin, user.paymentPinHash);

    if (matches) {
        // Reset only if the stored PIN is unchanged and no active
        // lockout has been applied by a concurrent request.
        const reset = await User.updateOne(
            {
                _id: userId,
                paymentPinHash: user.paymentPinHash,
                $or: [
                    { pinLockedUntil: null },
                    { pinLockedUntil: { $exists: false } },
                    { pinLockedUntil: { $lte: now } }
                ]
            },
            {
                $set: {
                    pinFailedAttempts: 0,
                    pinLockedUntil: null
                }
            }
        );

        if (reset.matchedCount === 0) {
            const latest = await User.findById(userId)
                .select("pinLockedUntil");

            if (latest?.pinLockedUntil && latest.pinLockedUntil > new Date()) {
                return {
                    ok: false,
                    status: "PIN_LOCKED",
                    retryAfterSeconds: Math.ceil(
                        (latest.pinLockedUntil.getTime() - Date.now()) / 1000
                    )
                };
            }

            return { ok: false, status: "PIN_RETRY" };
        }

        return { ok: true, status: "PIN_VERIFIED" };
    }

    // Atomically increment failed attempts. Concurrent wrong attempts
    // cannot all overwrite the same counter value.
    const lockUntil = new Date(Date.now() + LOCKOUT_MS);

    await User.updateOne(
        {
            _id: userId,
            paymentPinHash: user.paymentPinHash,
            $or: [
                { pinLockedUntil: null },
                { pinLockedUntil: { $exists: false } },
                { pinLockedUntil: { $lte: now } }
            ]
        },
        [
            {
                $set: {
                    pinFailedAttempts: {
                        $add: [{ $ifNull: ["$pinFailedAttempts", 0] }, 1]
                    },
                    pinLockedUntil: {
                        $cond: [
                            {
                                $gte: [
                                    {
                                        $add: [
                                            { $ifNull: ["$pinFailedAttempts", 0] },
                                            1
                                        ]
                                    },
                                    MAX_FAILED_ATTEMPTS
                                ]
                            },
                            lockUntil,
                            "$pinLockedUntil"
                        ]
                    }
                }
            }
        ],
        { updatePipeline: true }
    );

    const latest = await User.findById(userId)
        .select("pinFailedAttempts pinLockedUntil");

    if (latest?.pinLockedUntil && latest.pinLockedUntil > new Date()) {
        return {
            ok: false,
            status: "PIN_LOCKED",
            retryAfterSeconds: Math.ceil(
                (latest.pinLockedUntil.getTime() - Date.now()) / 1000
            )
        };
    }

    return {
        ok: false,
        status: "INVALID_PIN",
        attemptsRemaining: Math.max(
            0,
            MAX_FAILED_ATTEMPTS - (latest?.pinFailedAttempts ?? 0)
        )
    };
}

module.exports = { verifyPaymentPin };
