const express = require("express");
const mongoose = require("mongoose");
const {
    createRequestSchema,
    payRequestSchema
} = require("../services/moneyRequestValidation");
//const { z } = require("zod");

const {
    User,
    MoneyRequest,
    IdempotencyRecord
} = require("../db");

const {
    verifyPaymentPin,
    sendPinFailure
} = require("../services/paymentPin");

const { transferMoney } = require("../services/transferMoney");
const { ensureDailyCounter } = require("../services/dailyLimit");

const authMiddleware = require("../middleware/auth");
const { rateLimit, byUser } = require("../middleware/rateLimit");
const { REQUEST_EXPIRY_DAYS } = require("../config");
const crypto = require("crypto");

const router = express.Router();

// Request creation: maximum 20 requests per hour per user.
const requestCreateLimit = rateLimit({
    name: "request-create",
    max: 20,
    windowSeconds: 3600,
    keyFrom: byUser
});


// Share the same money-operation limit as wallet transfers.
const moneyLimit = rateLimit({
    name: "money",
    max: 10,
    windowSeconds: 60,
    keyFrom: byUser
});

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------



function formatRequest(request, currentUserId) {
    const isRequester = request.requesterId._id.equals(currentUserId);
    const otherUser = isRequester
        ? request.payerId
        : request.requesterId;

    return {
        id: request._id,
        otherPerson: {
            name: `${otherUser.firstName} ${otherUser.lastName}`,
            username: otherUser.username
        },
        amount: request.amount,
        note: request.note,
        status: request.status,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt
    };
}

// --------------------------------------------------
// CREATE MONEY REQUEST
// --------------------------------------------------

router.post(
    "/",
    authMiddleware,
    requestCreateLimit,
    async (req, res) => {
        try {
            const result = createRequestSchema.safeParse(req.body);

            if (!result.success) {
                const issue = result.error.issues[0];
                return res.status(400).json({
                    error: `${issue.path[0] || "body"}: ${issue.message}`
                });
            }

            const { to, amount, note } = result.data;

            const requester = await User.findById(req.userId);

            if (!requester) {
                return res.status(404).json({
                    error: "Requester not found"
                });
            }

            const payer = await User.findOne({ username: to });

            if (!payer) {
                return res.status(404).json({
                    error: "Requested user not found"
                });
            }

            if (requester._id.equals(payer._id)) {
                return res.status(400).json({
                    error: "You cannot request money from yourself"
                });
            }

            const pendingCount = await MoneyRequest.countDocuments({
                requesterId: requester._id,
                payerId: payer._id,
                status: "PENDING",
                expiresAt: { $gt: new Date() }
            });

            if (pendingCount >= 5) {
                return res.status(409).json({
                    error: "You already have 5 pending requests for this person"
                });
            }

            const expiresAt = new Date(
                Date.now() +
                REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000
            );

            const request = await MoneyRequest.create({
                requesterId: requester._id,
                payerId: payer._id,
                amount,
                note,
                expiresAt
            });

            return res.status(201).json({
                message: "Money request created successfully",
                request: {
                    id: request._id,
                    otherPerson: {
                        name: `${payer.firstName} ${payer.lastName}`,
                        username: payer.username
                    },
                    amount: request.amount,
                    note: request.note,
                    status: request.status,
                    createdAt: request.createdAt,
                    expiresAt: request.expiresAt
                }
            });

        } catch (error) {
            console.error("Create money request error:", error.message);

            return res.status(500).json({
                error: "Could not create money request"
            });
        }
    }
);

// --------------------------------------------------
// LIST INCOMING REQUESTS
// --------------------------------------------------

router.get("/incoming", authMiddleware, async (req, res) => {
    try {
        const status = req.query.status;

        if (
            status &&
            !["PENDING", "PAID", "DECLINED", "CANCELLED", "EXPIRED"].includes(status)
        ) {
            return res.status(400).json({
                error: "Invalid request status"
            });
        }

        const now = new Date();

        await MoneyRequest.updateMany(
            {
                payerId: req.userId,
                status: "PENDING",
                expiresAt: { $lte: now }
            },
            {
                $set: {
                    status: "EXPIRED",
                    decidedAt: now
                }
            }
        );

        const filter = { payerId: req.userId };

        if (status) {
            filter.status = status;
        }

        const requests = await MoneyRequest.find(filter)
            .sort({ createdAt: -1 })
            .limit(20)
            .populate("requesterId", "firstName lastName username")
            .populate("payerId", "firstName lastName username")
            .lean();

        return res.status(200).json({
            requests: requests.map(request =>
                formatRequest(request, req.userId)
            )
        });

    } catch (error) {
        console.error("Incoming requests error:", error.message);

        return res.status(500).json({
            error: "Could not load incoming requests"
        });
    }
});

// --------------------------------------------------
// LIST OUTGOING REQUESTS
// --------------------------------------------------

router.get("/outgoing", authMiddleware, async (req, res) => {
    try {
        const status = req.query.status;

        if (
            status &&
            !["PENDING", "PAID", "DECLINED", "CANCELLED", "EXPIRED"].includes(status)
        ) {
            return res.status(400).json({
                error: "Invalid request status"
            });
        }

        const now = new Date();

        await MoneyRequest.updateMany(
            {
                requesterId: req.userId,
                status: "PENDING",
                expiresAt: { $lte: now }
            },
            {
                $set: {
                    status: "EXPIRED",
                    decidedAt: now
                }
            }
        );

        const filter = { requesterId: req.userId };

        if (status) {
            filter.status = status;
        }

        const requests = await MoneyRequest.find(filter)
            .sort({ createdAt: -1 })
            .limit(20)
            .populate("requesterId", "firstName lastName username")
            .populate("payerId", "firstName lastName username")
            .lean();

        return res.status(200).json({
            requests: requests.map(request =>
                formatRequest(request, req.userId)
            )
        });

    } catch (error) {
        console.error("Outgoing requests error:", error.message);

        return res.status(500).json({
            error: "Could not load outgoing requests"
        });
    }
});

// --------------------------------------------------
// GET REQUEST DETAILS
// --------------------------------------------------

router.get("/:id", authMiddleware, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({
                error: "Money request not found"
            });
        }

        const request = await MoneyRequest.findById(req.params.id)
            .populate("requesterId", "firstName lastName username")
            .populate("payerId", "firstName lastName username")
            .lean();

        if (!request) {
            return res.status(404).json({
                error: "Money request not found"
            });
        }

        const isRequester = request.requesterId._id.equals(req.userId);
        const isPayer = request.payerId._id.equals(req.userId);

        if (!isRequester && !isPayer) {
            return res.status(404).json({
                error: "Money request not found"
            });
        }

        return res.status(200).json({
            request: formatRequest(request, req.userId)
        });

    } catch (error) {
        console.error("Get money request error:", error.message);

        return res.status(500).json({
            error: "Could not load money request"
        });
    }
});

// DECLINE MONEY REQUEST (PAYER ONLY)

router.post("/:id/decline", authMiddleware, async (req, res) => {
    try {
        // Validate request ID
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({
                error: "Money request not found"
            });
        }

        const now = new Date();

        // Atomically change PENDING to DECLINED
        const request = await MoneyRequest.findOneAndUpdate(
            {
                _id: req.params.id,
                payerId: req.userId,
                status: "PENDING",
                expiresAt: { $gt: now }
            },
            {
                $set: {
                    status: "DECLINED",
                    decidedAt: now
                }
            },
            {
                returnDocument: "after"
            }
        );

        if (!request) {
            const existing = await MoneyRequest.findById(req.params.id);

            // Request does not exist or user is not a participant
            if (
                !existing ||
                (
                    !existing.payerId.equals(req.userId) &&
                    !existing.requesterId.equals(req.userId)
                )
            ) {
                return res.status(404).json({
                    error: "Money request not found"
                });
            }

            // Only payer can decline
            if (!existing.payerId.equals(req.userId)) {
                return res.status(403).json({
                    error: "Only the payer can decline this request"
                });
            }

            // Handle expired request
            if (
                existing.status === "PENDING" &&
                existing.expiresAt <= now
            ) {
                await MoneyRequest.updateOne(
                    {
                        _id: existing._id,
                        status: "PENDING",
                        expiresAt: { $lte: now }
                    },
                    {
                        $set: {
                            status: "EXPIRED",
                            decidedAt: now
                        }
                    }
                );

                const latest = await MoneyRequest.findById(existing._id);

                if (!latest) {
                    return res.status(404).json({
                        error: "Money request not found"
                    });
                }

                if (latest.status === "EXPIRED") {
                    return res.status(410).json({
                        error: "Money request has expired"
                    });
                }

                return res.status(409).json({
                    error: `Request is already ${latest.status.toLowerCase()}`
                });
            }

            // Request is already in a terminal state
            return res.status(409).json({
                error: `Request is already ${existing.status.toLowerCase()}`
            });
        }

        return res.status(200).json({
            message: "Money request declined successfully",
            requestId: request._id,
            status: request.status,
            decidedAt: request.decidedAt
        });

    } catch (error) {
        console.error("Decline request error:", error.message);

        return res.status(500).json({
            error: "Could not decline money request"
        });
    }
});


// CANCEL MONEY REQUEST (REQUESTER ONLY)

router.post("/:id/cancel", authMiddleware, async (req, res) => {
    try {
        // Validate request ID
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({
                error: "Money request not found"
            });
        }

        const now = new Date();

        // Atomically change PENDING to CANCELLED
        const request = await MoneyRequest.findOneAndUpdate(
            {
                _id: req.params.id,
                requesterId: req.userId,
                status: "PENDING",
                expiresAt: { $gt: now }
            },
            {
                $set: {
                    status: "CANCELLED",
                    decidedAt: now
                }
            },
            {
                returnDocument: "after"
            }
        );

        if (!request) {
            const existing = await MoneyRequest.findById(req.params.id);

            // Request does not exist or user is not a participant
            if (
                !existing ||
                (
                    !existing.requesterId.equals(req.userId) &&
                    !existing.payerId.equals(req.userId)
                )
            ) {
                return res.status(404).json({
                    error: "Money request not found"
                });
            }

            // Only requester can cancel
            if (!existing.requesterId.equals(req.userId)) {
                return res.status(403).json({
                    error: "Only the requester can cancel this request"
                });
            }

            // Handle expired request
            if (
                existing.status === "PENDING" &&
                existing.expiresAt <= now
            ) {
                await MoneyRequest.updateOne(
                    {
                        _id: existing._id,
                        status: "PENDING",
                        expiresAt: { $lte: now }
                    },
                    {
                        $set: {
                            status: "EXPIRED",
                            decidedAt: now
                        }
                    }
                );

                const latest = await MoneyRequest.findById(existing._id);

                if (!latest) {
                    return res.status(404).json({
                        error: "Money request not found"
                    });
                }

                if (latest.status === "EXPIRED") {
                    return res.status(410).json({
                        error: "Money request has expired"
                    });
                }

                return res.status(409).json({
                    error: `Request is already ${latest.status.toLowerCase()}`
                });
            }

            // Request is already in a terminal state
            return res.status(409).json({
                error: `Request is already ${existing.status.toLowerCase()}`
            });
        }

        return res.status(200).json({
            message: "Money request cancelled successfully",
            requestId: request._id,
            status: request.status,
            decidedAt: request.decidedAt
        });

    } catch (error) {
        console.error("Cancel request error:", error.message);

        return res.status(500).json({
            error: "Could not cancel money request"
        });
    }
});

// --------------------------------------------------
// PAY MONEY REQUEST (PAYER ONLY)
// --------------------------------------------------

router.post("/:id/pay", authMiddleware, moneyLimit, async (req, res) => {
    let record;
    let session;

    try {
        // 1. Validate request ID
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({
                error: "Money request not found"
            });
        }

        // 2. Validate idempotency key
        const key = req.get("Idempotency-Key");

        if (
            typeof key !== "string" ||
            !key.trim() ||
            key.length > 200
        ) {
            return res.status(400).json({
                error: "A valid Idempotency-Key header is required"
            });
        }

        // 3. Validate payment PIN
        const result = payRequestSchema.safeParse(req.body || {});

        if (!result.success) {
            return res.status(400).json({
                error: result.error.issues[0].message
            });
        }

        // 4. Load the money request
        const moneyRequest = await MoneyRequest.findById(
            req.params.id
        );

        if (!moneyRequest) {
            return res.status(404).json({
                error: "Money request not found"
            });
        }

        // 5. Only the payer can pay
        if (!moneyRequest.payerId.equals(req.userId)) {
            if (moneyRequest.requesterId.equals(req.userId)) {
                return res.status(403).json({
                    error: "You cannot pay your own money request"
                });
            }

            return res.status(404).json({
                error: "Money request not found"
            });
        }

        // 6. Verify PIN before creating an idempotency record
        let pinResult;

        try {
            pinResult = await verifyPaymentPin(
                req.userId,
                result.data.pin
            );
        } catch (error) {
            console.error(
                "Request payment PIN error:",
                error.message
            );

            return res.status(500).json({
                error: "Payment PIN verification failed"
            });
        }

        if (sendPinFailure(res, pinResult)) {
            return;
        }

        // 7. Create a request-specific idempotency hash.
        // Never include the PIN in this hash.
        const requestHash = crypto
            .createHash("sha256")
            .update(JSON.stringify({
                action: "PAY_MONEY_REQUEST",
                requestId: req.params.id
            }))
            .digest("hex");

        // 8. Reserve the idempotency key
        try {
            [record] = await IdempotencyRecord.create([{
                userId: req.userId,
                key: key.trim(),
                requestHash,
                status: "IN_PROGRESS"
            }]);
        } catch (error) {
            if (error.code !== 11000) {
                throw error;
            }

            const existing = await IdempotencyRecord.findOne({
                userId: req.userId,
                key: key.trim()
            });

            if (!existing) {
                throw error;
            }

            if (existing.requestHash !== requestHash) {
                return res.status(422).json({
                    error: "Idempotency key was already used with a different request"
                });
            }

            if (existing.status === "DONE" && existing.response) {
                return res
                    .status(existing.response.httpStatus)
                    .json(existing.response.body);
            }

            return res.status(409).json({
                error: "A request with this idempotency key is in progress"
            });
        }

        // Helper for expected business errors
        const fail = (status, message) => {
            const error = new Error(message);
            error.status = status;
            throw error;
        };

        const now = new Date();

        // 9. Check request state after idempotency replay handling
        if (moneyRequest.status !== "PENDING") {
            if (moneyRequest.status === "EXPIRED") {
                fail(410, "Money request has expired");
            }

            fail(
                409,
                `Request is already ${moneyRequest.status.toLowerCase()}`
            );
        }

        if (moneyRequest.expiresAt <= now) {
            await MoneyRequest.updateOne(
                {
                    _id: moneyRequest._id,
                    status: "PENDING",
                    expiresAt: { $lte: now }
                },
                {
                    $set: {
                        status: "EXPIRED",
                        decidedAt: now
                    }
                }
            );

            const latest = await MoneyRequest.findById(
                moneyRequest._id
            );

            if (!latest) {
                fail(404, "Money request not found");
            }
            if (latest.status === "EXPIRED") {
                fail(410, "Money request has expired");
            }

            fail(
                409,
                `Request is already ${latest.status.toLowerCase()}`
            );
        }

        // 10. Load payer and requester
        const payer = await User.findById(req.userId);
        const requester = await User.findById(
            moneyRequest.requesterId
        );

        if (!payer || !requester) {
            fail(404, "User not found");
        }

        // Ensure today's daily counter exists before transaction
        await ensureDailyCounter(payer._id);

        // 11. Start MongoDB transaction
        session = await mongoose.startSession();

        let responseData;

        await session.withTransaction(async () => {

            // Atomically claim the request.
            // Only one payment can change PENDING to PAID.
            const claimedRequest =
                await MoneyRequest.findOneAndUpdate(
                    {
                        _id: moneyRequest._id,
                        payerId: payer._id,
                        status: "PENDING",
                        expiresAt: { $gt: new Date() }
                    },
                    {
                        $set: {
                            status: "PAID",
                            decidedAt: new Date()
                        }
                    },
                    {
                        returnDocument: "after",
                        session
                    }
                );

            if (!claimedRequest) {
                const error = new Error(
                    "Request is no longer available for payment"
                );

                error.status = 409;

                throw error;
            }

            // 12. Transfer money inside the same transaction
            const movement = await transferMoney({
                fromUser: payer,
                toUser: requester,
                amount: claimedRequest.amount,
                note: `Request: ${claimedRequest.note || "Money request"}`,
                session
            });

            // 13. Save transaction ID on money request
            const updatedRequest = await MoneyRequest.updateOne(
                {
                    _id: claimedRequest._id,
                    status: "PAID"
                },
                {
                    $set: {
                        transactionId: movement.transaction._id
                    }
                },
                { session }
            );

            if (updatedRequest.modifiedCount !== 1) {
                throw new Error(
                    "Could not save money request transaction"
                );
            }

            // 14. Save idempotency success in the same transaction
            responseData = {
                message: "Money request paid successfully",
                requestId: claimedRequest._id,
                transactionId: movement.transaction._id,
                amount: claimedRequest.amount,
                status: "PAID",
                requester: requester.username,
                payerBalance: movement.senderBalance
            };

            const savedRecord = await IdempotencyRecord.updateOne(
                {
                    _id: record._id,
                    status: "IN_PROGRESS"
                },
                {
                    $set: {
                        status: "DONE",
                        response: {
                            httpStatus: 200,
                            body: responseData
                        }
                    }
                },
                { session }
            );

            if (savedRecord.modifiedCount !== 1) {
                throw new Error(
                    "Could not save idempotency response"
                );
            }
        });

        return res.status(200).json(responseData);

    } catch (error) {
        console.error(
            "Pay money request error:",
            error.message
        );

            // Recheck the request when the atomic payment claim fails.
    // This distinguishes expiry from other terminal-state conflicts.
    if (
        error.message ===
        "Request is no longer available for payment"
    ) {
        let latest = await MoneyRequest.findById(req.params.id);

        if (!latest) {
            error.status = 404;
            error.message = "Money request not found";
        } else if (
            latest.status === "PENDING" &&
            latest.expiresAt <= new Date()
        ) {
            const now = new Date();

            await MoneyRequest.updateOne(
                {
                    _id: latest._id,
                    status: "PENDING",
                    expiresAt: { $lte: now }
                },
                {
                    $set: {
                        status: "EXPIRED",
                        decidedAt: now
                    }
                }
            );

            latest = await MoneyRequest.findById(req.params.id);

            if (!latest) {
                error.status = 404;
                error.message = "Money request not found";
            } else if (latest.status === "EXPIRED") {
                error.status = 410;
                error.message = "Money request has expired";
            } else {
                error.status = 409;
                error.message =
                    `Request is already ${latest.status.toLowerCase()}`;
            }
        } else if (latest.status === "EXPIRED") {
            error.status = 410;
            error.message = "Money request has expired";
        } else {
            error.status = 409;
            error.message =
                `Request is already ${latest.status.toLowerCase()}`;
        }
    }

        // Save expected business errors for safe retries
        if (
            record &&
            [400, 404, 409, 410, 429].includes(error.status)
        ) {
            const body = {
                error: error.message,
                message: error.message,
                ...(error.extra || {})
            };

            try {
                await IdempotencyRecord.updateOne(
                    {
                        _id: record._id,
                        status: "IN_PROGRESS"
                    },
                    {
                        $set: {
                            status: "DONE",
                            response: {
                                httpStatus: error.status,
                                body
                            }
                        }
                    }
                );

                return res.status(error.status).json(body);

            } catch (saveError) {
                console.error(
                    "Could not save payment error response:",
                    saveError.message
                );
            }
        }

        // Release an unfinished idempotency key after unexpected errors
        if (record) {
            try {
                await IdempotencyRecord.deleteOne({
                    _id: record._id,
                    status: "IN_PROGRESS"
                });
            } catch (cleanupError) {
                console.error(
                    "Idempotency cleanup error:",
                    cleanupError.message
                );
            }
        }

        return res.status(500).json({
            error: "Money request payment failed"
        });

    } finally {
        if (session) {
            await session.endSession();
        }
    }
});

module.exports = router;