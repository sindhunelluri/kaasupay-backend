const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const {
    Wallet,
    PaymentOrder,
    Transaction,
    LedgerEntry
} = require("../db");

const router = express.Router();

// Razorpay sends payment notifications to this endpoint
router.post("/razorpay", async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.get("x-razorpay-signature");

    try {
        // 1. Check configuration and request body
        if (!webhookSecret) {
            console.error("RAZORPAY_WEBHOOK_SECRET is missing");
            return res.status(500).json({
                error: "Webhook is not configured"
            });
        }

        if (!Buffer.isBuffer(req.body) || !signature) {
            return res.status(400).json({
                error: "Invalid webhook request"
            });
        }

        // 2. Verify that the notification genuinely came from Razorpay
        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(req.body)
            .digest("hex");

        const received = Buffer.from(signature, "hex");
        const expected = Buffer.from(expectedSignature, "hex");

        if (
            received.length !== expected.length ||
            !crypto.timingSafeEqual(received, expected)
        ) {
            return res.status(400).json({
                error: "Invalid webhook signature"
            });
        }

        // 3. Read the verified notification
        const event = JSON.parse(req.body.toString("utf8"));

        // We only process captured payments in this handler
        if (event.event !== "payment.captured") {
            return res.status(200).json({
                message: "Event received; no action required"
            });
        }

        const payment = event.payload?.payment?.entity;

        if (
            !payment ||
            !payment.id ||
            !payment.order_id ||
            payment.status !== "captured"
        ) {
            return res.status(400).json({
                error: "Invalid captured-payment event"
            });
        }

        // 4. Find the matching order created by KaasuPay
        const order = await PaymentOrder.findOne({
            gatewayOrderId: payment.order_id
        });

        if (!order) {
            return res.status(404).json({
                error: "Payment order not found"
            });
        }

        // 5. Confirm the payment details match the stored order
        if (
            order.amount !== payment.amount ||
            order.currency !== payment.currency
        ) {
            return res.status(400).json({
                error: "Payment details do not match the order"
            });
        }

        const session = await mongoose.startSession();

        let result;

        try {
            // 6. Update the order, wallet, transaction and ledger atomically
            await session.withTransaction(async () => {
                const currentOrder = await PaymentOrder.findOne({
                    gatewayOrderId: payment.order_id
                }).session(session);

                if (!currentOrder) {
                    throw new Error("Payment order not found");
                }

                // Prevent duplicate wallet credits
                if (currentOrder.status === "PAID") {
                    result = {
                        alreadyProcessed: true,
                        samePayment:
                            currentOrder.gatewayPaymentId === payment.id
                    };
                    return;
                }

                if (currentOrder.status !== "CREATED") {
                    throw new Error("Payment order is not payable");
                }

                const wallet = await Wallet.findOne({
                    userId: currentOrder.userId
                }).session(session);

                if (!wallet) {
                    throw new Error("Wallet not found");
                }

                // Mark the order as paid
                currentOrder.status = "PAID";
                currentOrder.gatewayPaymentId = payment.id;
                currentOrder.paidVia = "WEBHOOK";

                // Credit the wallet (amount is in paise)
                wallet.balance += currentOrder.amount;
                await wallet.save({ session });

                // Record the top-up transaction
                const transactions = await Transaction.create(
                    [{
                        type: "TOPUP",
                        fromUserId: null,
                        toUserId: currentOrder.userId,
                        amount: currentOrder.amount,
                        note: "Razorpay wallet top-up",
                        status: "SUCCESS"
                    }],
                    { session }
                );

                const transaction = transactions[0];

                // Record the wallet credit in the ledger
                await LedgerEntry.create(
                    [{
                        userId: currentOrder.userId,
                        transactionId: transaction._id,
                        direction: "CREDIT",
                        amount: currentOrder.amount,
                        balanceAfter: wallet.balance
                    }],
                    { session }
                );

                // Link the transaction to the payment order
                currentOrder.transactionId = transaction._id;
                await currentOrder.save({ session });

                result = {
                    alreadyProcessed: false,
                    amount: currentOrder.amount
                };
            });
        } finally {
            await session.endSession();
        }

        if (result?.alreadyProcessed) {
            if (!result.samePayment) {
                console.error(
                    "Paid order received a different payment ID:",
                    payment.order_id
                );
            }

            // Acknowledge the event without crediting the wallet again
            return res.status(200).json({
                message: "Payment event already processed"
            });
        }

        return res.status(200).json({
            message: "Payment captured and wallet credited",
            amount: result.amount
        });

    } catch (error) {
        console.error("Razorpay webhook error:", error.message);

        return res.status(500).json({
            error: "Unable to process payment webhook"
        });
    }
});

module.exports = router;