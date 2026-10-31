
require("dotenv").config();

const express = require("express");
const rootRouter = require("./routes/index");
const cors = require("cors");

const app = express();

// Behind Render / Railway / NGINX every request looks like it comes from the
// proxy. This makes req.ip the real client IP, so IP rate limits work.
app.set("trust proxy", 1);

app.use(cors({
    origin: [
        "http://localhost:5173",
        "https://kaasupay-frontend.onrender.com"
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "idempotency-key"
    ],
    // lets the frontend read these headers
    exposedHeaders: ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"]
}));

// Preserve raw request body for Razorpay webhook verification.
app.use(
    "/api/v1/webhooks/razorpay",
    express.raw({ type: "application/json" })
);

app.use(express.json());

app.get("/", (req, res) => {
    res.json({ status: "KaasuPay backend is running" });
});

app.use(express.static("public"));
app.use("/api/v1", rootRouter);

module.exports = app;
