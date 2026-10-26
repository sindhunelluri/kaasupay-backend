const jwt = require("jsonwebtoken");

const { JWT_SECRET } = require("../config");

function authMiddleware(req, res, next) {
    // Get Authorization header
    const authHeader = req.headers.authorization;

    // Check whether header exists and starts with "Bearer "
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Please sign in first"
        });
    }

    // Extract token
    const token = authHeader.split(" ")[1];

    try {
        // Verify token
        const decoded = jwt.verify(token, JWT_SECRET);

        // Store user ID for the next route
        req.userId = decoded.userId;

        // Continue to the protected route
        next();

    } catch (error) {
        return res.status(401).json({
            error: "Your session is invalid or has expired. Please sign in again."
        });
    }
}

module.exports = authMiddleware;