
require("dotenv").config();

const express = require("express");
const rootRouter = require("./routes/index");
const cors = require("cors");

const app = express();

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
    ]
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
