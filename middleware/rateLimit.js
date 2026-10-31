const { RateLimitCounter } = require("../db");

/**
 * Middleware factory: fixed window counter kept in MongoDB.
 *
 * rateLimit({
 *   name: "signin-email",          // part of the counter key
 *   max: 5,                        // allowed requests per window
 *   windowSeconds: 60,
 *   keyFrom: (req) => "who"        // return null to skip limiting
 * })
 *
 * The count and the check happen in ONE atomic upsert with $inc.
 * The window start is part of the key, so a new window starts at 0 by itself.
 */
function rateLimit({ name, max, windowSeconds, keyFrom }) {
    return async function rateLimitMiddleware(req, res, next) {
        try {
            const who = keyFrom(req);
            if (!who) return next();

            const nowSec = Math.floor(Date.now() / 1000);
            const windowStart = nowSec - (nowSec % windowSeconds);
            const windowEnd = windowStart + windowSeconds;
            const key = `${name}:${who}:${windowStart}`;

            let doc;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    doc = await RateLimitCounter.findOneAndUpdate(
                        { key },
                        {
                            $inc: { count: 1 },
                            // keep the document a little after the window; TTL cleans it
                            $setOnInsert: { expiresAt: new Date((windowEnd + 60) * 1000) }
                        },
                        { upsert: true, returnDocument: "after" }
                    );
                    break;
                } catch (error) {
                    // Two first requests raced to create the counter. Retry once.
                    if (error.code !== 11000 || attempt === 1) throw error;
                }
            }

            const remaining = Math.max(0, max - doc.count);
            res.set("X-RateLimit-Limit", String(max));
            res.set("X-RateLimit-Remaining", String(remaining));

            if (doc.count > max) {
                const retryAfterSeconds = Math.max(1, windowEnd - nowSec);
                res.set("Retry-After", String(retryAfterSeconds));
                return res.status(429).json({
                    error: "Too many requests. Slow down",
                    message: "Too many requests. Slow down",
                    retryAfterSeconds
                });
            }

            next();
        } catch (error) {
            // If the counter store is down we let the request through rather
            // than take the whole app down. Money routes still have the PIN lock.
            console.error(`Rate limiter "${name}" failed:`, error.message);
            next();
        }
    };
}

const byIp = (req) => req.ip || "unknown";
const byUser = (req) => req.userId || null;
const byEmail = (req) => {
    const u = req.body && req.body.username;
    return typeof u === "string" && u.trim() ? u.trim().toLowerCase() : null;
};

module.exports = { rateLimit, byIp, byUser, byEmail };
