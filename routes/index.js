//Connects routes

const express = require("express");
const userRouter = require("./user");
const adminRouter = require("./admin");
const router = express.Router();
const walletRouter = require("./wallet");
const withdrawalsRouter = require("./withdrawals");
const payoutRouter = require("./payout");
const webhookRouter = require("./webhook");

// Every URL starting with /api/v1/user
// will go to routes/user.js
router.use("/user", userRouter);
router.use("/admin", adminRouter);
router.use("/payout", payoutRouter);
router.use("/webhooks", webhookRouter);
router.use("/wallet", walletRouter);
router.use("/wallet/withdraw", withdrawalsRouter);

// router.use("/wallet", walletRouter);

module.exports = router;