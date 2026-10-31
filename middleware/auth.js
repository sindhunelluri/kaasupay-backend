const jwt = require("jsonwebtoken");

const { JWT_SECRET } = require("../config");
const { User } = require("../db");

const SESSION_ENDED = "Session ended. Please sign in again";

async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Please sign in first" });
    }

    const token = authHeader.split(" ")[1];

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return res.status(401).json({
            error: "Your session is invalid or has expired. Please sign in again."
        });
    }

    try {
        // One small read: only the tokenVersion field.
        const user = await User.findById(decoded.userId)
            .select("tokenVersion")
            .lean();

        const currentVersion = user ? (user.tokenVersion ?? 0) : null;

        // Missing user, or a token from before "log out of all devices"
        // (tokens made before Day 6 have no tv, so they are refused too).
        if (!user || decoded.tv !== currentVersion) {
            return res.status(401).json({
                error: SESSION_ENDED,
                message: SESSION_ENDED
            });
        }

        req.userId = decoded.userId;
        next();
    } catch (error) {
        console.error("Auth check failed:", error.message);
        return res.status(500).json({ error: "Could not check your session" });
    }
}

module.exports = authMiddleware;
