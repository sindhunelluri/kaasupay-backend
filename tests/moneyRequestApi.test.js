require("dotenv").config();

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = require("../app");
const { connectTestDB } = require("../testDb");
const {
    User,
    Wallet,
    MoneyRequest,
    IdempotencyRecord,
    Transaction,
    LedgerEntry,
    DailyTransferLimit,
    RateLimitCounter
} = require("../db");
const { JWT_SECRET } = require("../config");
const testRunId = `${Date.now()}_${process.pid}`;

let server;
let baseUrl;

let requester;
let payer;
let stranger;

let requesterToken;
let payerToken;
let strangerToken;
let requestId;

async function createTestUser(username) {
    const user = await User.create({
        username,
        firstName: "Test",
        lastName: "User",
        passwordHash: await bcrypt.hash("TestPassword@123", 10),
        paymentPinHash: await bcrypt.hash("2468", 10),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        tokenVersion: 0
    });

    await Wallet.create({
        userId: user._id,
        balance: 100000
    });

    const token = jwt.sign(
        { userId: user._id.toString(), tv: user.tokenVersion ?? 0 },
        JWT_SECRET,
        { expiresIn: "1h" }
    );

    return { user, token };
}

test.before(async () => {
    await connectTestDB();

    // Safety check: never run these tests against another database.
    assert.equal(
        mongoose.connection.name,
        "kaasupay_test",
        "Tests must run only against kaasupay_test"
    );

    const requesterData = await createTestUser(
        `requester_${testRunId}@test.com`
    );

    const payerData = await createTestUser(
        `payer_${testRunId}@test.com`
    );

    const strangerData = await createTestUser(
        `stranger_${testRunId}@test.com`
    );

    requester = requesterData.user;
    requesterToken = requesterData.token;

    payer = payerData.user;
    payerToken = payerData.token;

    stranger = strangerData.user;
    strangerToken = strangerData.token;

    server = app.listen(0);

    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
    try {
        if (server) {
            await new Promise((resolve, reject) => {
                server.close(error => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }

        if (mongoose.connection.name === "kaasupay_test") {
            const userIds = [requester?._id, payer?._id, stranger?._id]
                .filter(Boolean);

            await MoneyRequest.deleteMany({
                $or: [
                    { requesterId: { $in: userIds } },
                    { payerId: { $in: userIds } }
                ]
            });

            await Transaction.deleteMany({
    $or: [
        { fromUserId: { $in: userIds } },
        { toUserId: { $in: userIds } }
    ]
});

await LedgerEntry.deleteMany({
    userId: { $in: userIds }
});

await DailyTransferLimit.deleteMany({
    userId: { $in: userIds }
});

const userIdPattern = userIds
    .map(id => id.toString())
    .join("|");

await RateLimitCounter.deleteMany({
    key: { $regex: userIdPattern }
});

await Wallet.deleteMany({ userId: { $in: userIds } });
await IdempotencyRecord.deleteMany({ userId: { $in: userIds } });
await User.deleteMany({ _id: { $in: userIds } });
        }
    } finally {
        await mongoose.disconnect();
    }
});

test("D1: requester can create a money request", async () => {
    const response = await fetch(`${baseUrl}/api/v1/requests`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requesterToken}`
        },
        body: JSON.stringify({
            to: payer.username,
            amount: 5000,
            note: "Test request"
        })
    });

    const body = await response.json();
    const request = body.request;
    requestId = request.id;

    assert.equal(response.status, 201);
    assert.equal(body.message, "Money request created successfully");
    assert.ok(request.id);
    assert.equal(request.status, "PENDING");
    assert.equal(request.amount, 5000);
    assert.equal(request.note, "Test request");
    assert.equal(request.otherPerson.username, payer.username);
    assert.ok(request.expiresAt);
});

test("D2: payer can view incoming money requests", async () => {
    const response = await fetch(`${baseUrl}/api/v1/requests/incoming`, {
        headers: {
            Authorization: `Bearer ${payerToken}`
        }
    });

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.requests));

    const request = body.requests.find(
        item => item.id.toString() === requestId.toString()
    );

    assert.ok(request, "Created request should appear in incoming list");
    assert.equal(request.status, "PENDING");
    assert.equal(request.amount, 5000);
    assert.equal(request.otherPerson.username, requester.username);
});

test("D3: requester can view outgoing money requests", async () => {
    const response = await fetch(`${baseUrl}/api/v1/requests/outgoing`, {
        headers: {
            Authorization: `Bearer ${requesterToken}`
        }
    });

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.requests));

    const request = body.requests.find(
        item => item.id.toString() === requestId.toString()
    );

    assert.ok(request, "Created request should appear in outgoing list");
    assert.equal(request.status, "PENDING");
    assert.equal(request.amount, 5000);
    assert.equal(request.otherPerson.username, payer.username);
});

test("D4: requester can view their request details", async () => {
    const response = await fetch(
        `${baseUrl}/api/v1/requests/${requestId}`,
        {
            headers: {
                Authorization: `Bearer ${requesterToken}`
            }
        }
    );

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.request);
    assert.equal(body.request.id.toString(), requestId.toString());
    assert.equal(body.request.status, "PENDING");
    assert.equal(body.request.amount, 5000);
    assert.equal(body.request.otherPerson.username, payer.username);
});

test("D5: stranger cannot view another person's request", async () => {
    const response = await fetch(
        `${baseUrl}/api/v1/requests/${requestId}`,
        {
            headers: {
                Authorization: `Bearer ${strangerToken}`
            }
        }
    );

    assert.equal(response.status, 404);
});

test("D6: payer cannot cancel the request", async () => {
    const response = await fetch(
        `${baseUrl}/api/v1/requests/${requestId}/cancel`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${payerToken}`
            }
        }
    );

    assert.equal(response.status, 403);
});

test("D7: payer can decline a pending money request", async () => {
    const response = await fetch(
        `${baseUrl}/api/v1/requests/${requestId}/decline`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${payerToken}`
            }
        }
    );

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.message, "Money request declined successfully");
    assert.equal(body.requestId.toString(), requestId.toString());
    assert.equal(body.status, "DECLINED");
    assert.ok(body.decidedAt);
});

test("D8: requester can cancel a pending money request", async () => {
    // Create a separate request for cancellation
    const createResponse = await fetch(
        `${baseUrl}/api/v1/requests`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${requesterToken}`
            },
            body: JSON.stringify({
                to: payer.username,
                amount: 6000,
                note: "Cancellation test"
            })
        }
    );

    const createBody = await createResponse.json();

    assert.equal(createResponse.status, 201);

    const cancelRequestId = createBody.request.id;

    // Requester cancels the new request
    const response = await fetch(
        `${baseUrl}/api/v1/requests/${cancelRequestId}/cancel`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${requesterToken}`
            }
        }
    );

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.message, "Money request cancelled successfully");
    assert.equal(body.requestId.toString(), cancelRequestId.toString());
    assert.equal(body.status, "CANCELLED");
    assert.ok(body.decidedAt);
});

test("D9: payer can pay a request exactly once", async () => {
    // Create a fresh request
    const createResponse = await fetch(
        `${baseUrl}/api/v1/requests`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${requesterToken}`
            },
            body: JSON.stringify({
                to: payer.username,
                amount: 5000,
                note: "Payment integration test"
            })
        }
    );

    const createBody = await createResponse.json();

    assert.equal(createResponse.status, 201);

    const paymentRequestId = createBody.request.id;
    const idempotencyKey = `request-pay-${testRunId}`;

    // Record balances before payment
    const payerWalletBefore = await Wallet.findOne({
        userId: payer._id
    });

    const requesterWalletBefore = await Wallet.findOne({
        userId: requester._id
    });

    // Pay the request
    const payResponse = await fetch(
        `${baseUrl}/api/v1/requests/${paymentRequestId}/pay`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${payerToken}`,
                "Idempotency-Key": idempotencyKey
            },
            body: JSON.stringify({
                pin: "2468"
            })
        }
    );

    const payBody = await payResponse.json();

    assert.equal(payResponse.status, 200);
    assert.equal(payBody.status, "PAID");
    assert.equal(payBody.amount, 5000);
    assert.ok(payBody.transactionId);

    // Verify wallet balances
    const payerWalletAfter = await Wallet.findOne({
        userId: payer._id
    });

    const requesterWalletAfter = await Wallet.findOne({
        userId: requester._id
    });

    assert.equal(
        payerWalletAfter.balance,
        payerWalletBefore.balance - 5000
    );

    assert.equal(
        requesterWalletAfter.balance,
        requesterWalletBefore.balance + 5000
    );

    // Verify request status and transaction reference
    const savedRequest = await MoneyRequest.findById(
        paymentRequestId
    );

    assert.equal(savedRequest.status, "PAID");
    assert.equal(
        savedRequest.transactionId.toString(),
        payBody.transactionId.toString()
    );

    // Verify transaction
    const transaction = await Transaction.findById(
        payBody.transactionId
    );

    assert.ok(transaction);
    assert.equal(transaction.type, "TRANSFER");
    assert.equal(transaction.amount, 5000);
    assert.equal(transaction.fromUserId.toString(), payer._id.toString());
    assert.equal(transaction.toUserId.toString(), requester._id.toString());

    // Verify both ledger entries
    const ledgerEntries = await LedgerEntry.find({
        transactionId: transaction._id
    });

    assert.equal(ledgerEntries.length, 2);
    assert.ok(ledgerEntries.some(entry => entry.direction === "DEBIT"));
    assert.ok(ledgerEntries.some(entry => entry.direction === "CREDIT"));

    // Replay using the same idempotency key
    const replayResponse = await fetch(
        `${baseUrl}/api/v1/requests/${paymentRequestId}/pay`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${payerToken}`,
                "Idempotency-Key": idempotencyKey
            },
            body: JSON.stringify({
                pin: "2468"
            })
        }
    );

    const replayBody = await replayResponse.json();

    assert.equal(replayResponse.status, 200);
    assert.equal(replayBody.status, "PAID");
    assert.equal(
        replayBody.transactionId.toString(),
        payBody.transactionId.toString()
    );

    // Verify replay did not move money again
    const payerWalletAfterReplay = await Wallet.findOne({
        userId: payer._id
    });

    const requesterWalletAfterReplay = await Wallet.findOne({
        userId: requester._id
    });

    assert.equal(
        payerWalletAfterReplay.balance,
        payerWalletAfter.balance
    );

    assert.equal(
        requesterWalletAfterReplay.balance,
        requesterWalletAfter.balance
    );

    const transactionCount = await Transaction.countDocuments({
        fromUserId: payer._id,
        toUserId: requester._id
    });

    assert.equal(transactionCount, 1);
});

test("D10: insufficient balance leaves request pending", async () => {
    // Give the payer a balance lower than the requested amount
    await Wallet.updateOne(
        { userId: payer._id },
        { $set: { balance: 1000 } }
    );

    const requesterWalletBefore = await Wallet.findOne({
        userId: requester._id
    });

    const transactionCountBefore = await Transaction.countDocuments({
        fromUserId: payer._id,
        toUserId: requester._id
    });

    // Create a request for 5000 paise
    const createResponse = await fetch(
        `${baseUrl}/api/v1/requests`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${requesterToken}`
            },
            body: JSON.stringify({
                to: payer.username,
                amount: 5000,
                note: "Insufficient balance test"
            })
        }
    );

    const createBody = await createResponse.json();

    assert.equal(createResponse.status, 201);

    const paymentRequestId = createBody.request.id;

    // Attempt payment
    const response = await fetch(
        `${baseUrl}/api/v1/requests/${paymentRequestId}/pay`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${payerToken}`,
                "Idempotency-Key": `insufficient-${testRunId}`
            },
            body: JSON.stringify({
                pin: "2468"
            })
        }
    );

    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "Insufficient balance");

    // Request must remain pending
    const savedRequest = await MoneyRequest.findById(
        paymentRequestId
    );

    assert.equal(savedRequest.status, "PENDING");
    assert.equal(savedRequest.transactionId, null);

    // Neither wallet should have changed
    const payerWalletAfter = await Wallet.findOne({
        userId: payer._id
    });

    const requesterWalletAfter = await Wallet.findOne({
        userId: requester._id
    });

    assert.equal(payerWalletAfter.balance, 1000);
    assert.equal(
        requesterWalletAfter.balance,
        requesterWalletBefore.balance
    );

    // No transaction should have been created
    const transactionCountAfter = await Transaction.countDocuments({
        fromUserId: payer._id,
        toUserId: requester._id
    });

    assert.equal(transactionCountAfter, transactionCountBefore);
});

test("D11: a paid request cannot be paid again with a new key", async () => {
    // Restore test payer balance after D10
    await Wallet.updateOne(
        { userId: payer._id },
        { $set: { balance: 100000 } }
    );

    const createResponse = await fetch(`${baseUrl}/api/v1/requests`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requesterToken}`
        },
        body: JSON.stringify({
            to: payer.username,
            amount: 5000,
            note: "New idempotency key test"
        })
    });

    const createBody = await createResponse.json();
    assert.equal(createResponse.status, 201);

    const id = createBody.request.id;

    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${payerToken}`
    };

    // First payment
    const firstResponse = await fetch(
        `${baseUrl}/api/v1/requests/${id}/pay`,
        {
            method: "POST",
            headers: {
                ...headers,
                "Idempotency-Key": `first-${testRunId}`
            },
            body: JSON.stringify({ pin: "2468" })
        }
    );

    assert.equal(firstResponse.status, 200);

    const firstBody = await firstResponse.json();

    const payerAfterFirst = await Wallet.findOne({
        userId: payer._id
    });
    const requesterAfterFirst = await Wallet.findOne({
        userId: requester._id
    });

    const transactionCountBefore = await Transaction.countDocuments({
        fromUserId: payer._id,
        toUserId: requester._id
    });

    // Second payment with a different key
    const secondResponse = await fetch(
        `${baseUrl}/api/v1/requests/${id}/pay`,
        {
            method: "POST",
            headers: {
                ...headers,
                "Idempotency-Key": `second-${testRunId}`
            },
            body: JSON.stringify({ pin: "2468" })
        }
    );

    assert.equal(secondResponse.status, 409);

    const payerAfterSecond = await Wallet.findOne({
        userId: payer._id
    });
    const requesterAfterSecond = await Wallet.findOne({
        userId: requester._id
    });

    assert.equal(payerAfterSecond.balance, payerAfterFirst.balance);
    assert.equal(
        requesterAfterSecond.balance,
        requesterAfterFirst.balance
    );

    const transactionCountAfter = await Transaction.countDocuments({
        fromUserId: payer._id,
        toUserId: requester._id
    });

    assert.equal(transactionCountAfter, transactionCountBefore);

    const savedRequest = await MoneyRequest.findById(id);
    assert.equal(savedRequest.status, "PAID");
    assert.equal(
        savedRequest.transactionId.toString(),
        firstBody.transactionId.toString()
    );
});


test("D12: expired requests cannot be paid and are lazily marked EXPIRED", async () => {
    const createRequest = async (note) => {
        const response = await fetch(`${baseUrl}/api/v1/requests`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${requesterToken}`
            },
            body: JSON.stringify({
                to: payer.username,
                amount: 5000,
                note
            })
        });

        const body = await response.json();
        assert.equal(response.status, 201);
        return body.request.id;
    };

    const makeExpired = async (id) => {
        await MoneyRequest.updateOne(
            { _id: id },
            { $set: { expiresAt: new Date(Date.now() - 1000) } }
        );
    };

    // 1. An expired request cannot be paid
    const payRequestId = await createRequest("Expired payment test");
    await makeExpired(payRequestId);

    const payResponse = await fetch(
        `${baseUrl}/api/v1/requests/${payRequestId}/pay`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${payerToken}`,
                "Idempotency-Key": `expired-pay-${testRunId}`
            },
            body: JSON.stringify({ pin: "2468" })
        }
    );

    const payBody = await payResponse.json();

    assert.equal(payResponse.status, 410);
    assert.equal(payBody.error, "Money request has expired");

    const expiredPayRequest = await MoneyRequest.findById(payRequestId);
    assert.equal(expiredPayRequest.status, "EXPIRED");
    assert.ok(expiredPayRequest.decidedAt);

    // 2. Incoming list lazily expires old pending requests
    const incomingRequestId = await createRequest("Incoming expiry test");
    await makeExpired(incomingRequestId);

    const incomingResponse = await fetch(
        `${baseUrl}/api/v1/requests/incoming`,
        {
            headers: {
                Authorization: `Bearer ${payerToken}`
            }
        }
    );

    assert.equal(incomingResponse.status, 200);

    const incomingBody = await incomingResponse.json();
    assert.ok(
        incomingBody.requests.some(
            request =>
                request.id.toString() === incomingRequestId.toString() &&
                request.status === "EXPIRED"
        )
    );

    const incomingSaved = await MoneyRequest.findById(incomingRequestId);
    assert.equal(incomingSaved.status, "EXPIRED");
    assert.ok(incomingSaved.decidedAt);

    // 3. Outgoing list lazily expires old pending requests
    const outgoingRequestId = await createRequest("Outgoing expiry test");
    await makeExpired(outgoingRequestId);

    const outgoingResponse = await fetch(
        `${baseUrl}/api/v1/requests/outgoing`,
        {
            headers: {
                Authorization: `Bearer ${requesterToken}`
            }
        }
    );

    assert.equal(outgoingResponse.status, 200);

    const outgoingBody = await outgoingResponse.json();
    assert.ok(
        outgoingBody.requests.some(
            request =>
                request.id.toString() === outgoingRequestId.toString() &&
                request.status === "EXPIRED"
        )
    );

    const outgoingSaved = await MoneyRequest.findById(outgoingRequestId);
    assert.equal(outgoingSaved.status, "EXPIRED");
    assert.ok(outgoingSaved.decidedAt);
});

test("D15: concurrent payments cannot pay the same request twice", async () => {
    // Create a fresh money request.
    const createResponse = await fetch(
        `${baseUrl}/api/v1/requests`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${requesterToken}`
            },
            body: JSON.stringify({
                to: payer.username,
                amount: 7000,
                note: "Concurrent payment test"
            })
        }
    );

    const createBody = await createResponse.json();

    assert.equal(createResponse.status, 201);

    const id = createBody.request.id;

    // Record balances and transaction count before payment.
    const payerBefore = await Wallet.findOne({
        userId: payer._id
    });

    const requesterBefore = await Wallet.findOne({
        userId: requester._id
    });

    const transactionsBefore = await Transaction.countDocuments({
        fromUserId: payer._id,
        toUserId: requester._id
    });

    // Send two payments simultaneously with different keys.
    const makePayment = (key) =>
        fetch(`${baseUrl}/api/v1/requests/${id}/pay`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${payerToken}`,
                "Idempotency-Key": key
            },
            body: JSON.stringify({ pin: "2468" })
        });

    const [response1, response2] = await Promise.all([
        makePayment(`concurrent-first-${testRunId}`),
        makePayment(`concurrent-second-${testRunId}`)
    ]);

    const results = [
        { response: response1, body: await response1.json() },
        { response: response2, body: await response2.json() }
    ];

    // Exactly one payment should succeed.
    assert.equal(
        results.filter(item => item.response.status === 200).length,
        1
    );

    // The other payment must receive a conflict.
    assert.equal(
        results.filter(item => item.response.status === 409).length,
        1
    );

    const successfulPayment = results.find(
        item => item.response.status === 200
    );

    assert.equal(successfulPayment.body.status, "PAID");
    assert.equal(successfulPayment.body.amount, 7000);

    // Verify wallet balances changed only once.
    const payerAfter = await Wallet.findOne({
        userId: payer._id
    });

    const requesterAfter = await Wallet.findOne({
        userId: requester._id
    });

    assert.equal(
        payerAfter.balance,
        payerBefore.balance - 7000
    );

    assert.equal(
        requesterAfter.balance,
        requesterBefore.balance + 7000
    );

    // Verify exactly one transaction was created.
    const transactionsAfter = await Transaction.countDocuments({
        fromUserId: payer._id,
        toUserId: requester._id
    });

    assert.equal(transactionsAfter - transactionsBefore, 1);

    // Verify the request has one transaction reference.
    const savedRequest = await MoneyRequest.findById(id);

    assert.equal(savedRequest.status, "PAID");
    assert.equal(
        savedRequest.transactionId.toString(),
        successfulPayment.body.transactionId.toString()
    );

    // Verify exactly two ledger entries for the successful transaction.
    const ledgerEntries = await LedgerEntry.find({
        transactionId: savedRequest.transactionId
    });

    assert.equal(ledgerEntries.length, 2);
    assert.ok(ledgerEntries.some(entry => entry.direction === "DEBIT"));
    assert.ok(ledgerEntries.some(entry => entry.direction === "CREDIT"));
});

test("D13: maximum 5 pending requests per requester-payer pair", async () => {
    const createRequest = async (note) => {
        return fetch(`${baseUrl}/api/v1/requests`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${requesterToken}`
            },
            body: JSON.stringify({
                to: payer.username,
                amount: 2000,
                note
            })
        });
    };

    // D10 already left one pending request.
    const existingPending = await MoneyRequest.countDocuments({
        requesterId: requester._id,
        payerId: payer._id,
        status: "PENDING",
        expiresAt: { $gt: new Date() }
    });

    assert.equal(existingPending, 1);

    // Create four more: total becomes five.
    for (let i = 1; i <= 4; i++) {
        const response = await createRequest(`Limit test ${i}`);
        assert.equal(response.status, 201);
    }

    const pendingCount = await MoneyRequest.countDocuments({
        requesterId: requester._id,
        payerId: payer._id,
        status: "PENDING",
        expiresAt: { $gt: new Date() }
    });

    assert.equal(pendingCount, 5);

    // Sixth pending request must be rejected.
    const sixthResponse = await createRequest("Sixth request test");
    const sixthBody = await sixthResponse.json();

    assert.equal(sixthResponse.status, 409);
    assert.equal(
        sixthBody.error,
        "You already have 5 pending requests for this person"
    );

    // Confirm the count remains five.
    const finalCount = await MoneyRequest.countDocuments({
        requesterId: requester._id,
        payerId: payer._id,
        status: "PENDING",
        expiresAt: { $gt: new Date() }
    });

    assert.equal(finalCount, 5);
});

test("D14: request creation is limited to 20 requests per hour per user", async () => {
    // Reset only this requester's request-create counter.
    await RateLimitCounter.deleteMany({
        key: {
            $regex: `^request-create:${requester._id}:`
        }
    });

    const createInvalidRequest = async (token) => {
        return fetch(`${baseUrl}/api/v1/requests`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({})
        });
    };

    // Record existing money request count.
    const requestsBefore = await MoneyRequest.countDocuments({
        requesterId: requester._id
    });

    // First 20 requests should reach validation and return 400.
    for (let i = 1; i <= 20; i++) {
        const response = await createInvalidRequest(requesterToken);

        assert.equal(
            response.status,
            400,
            `Request ${i} should be allowed through the rate limiter`
        );
    }

    // The 21st request must be rate limited.
    const twentyFirstResponse = await createInvalidRequest(requesterToken);
    const body = await twentyFirstResponse.json();

    assert.equal(twentyFirstResponse.status, 429);
    assert.equal(
        body.error,
        "Too many requests. Slow down"
    );

    assert.equal(
        twentyFirstResponse.headers.get("X-RateLimit-Limit"),
        "20"
    );

    assert.equal(
        twentyFirstResponse.headers.get("X-RateLimit-Remaining"),
        "0"
    );

    assert.ok(
        Number(twentyFirstResponse.headers.get("Retry-After")) > 0
    );

    // Another user must have an independent rate-limit counter.
    const strangerResponse = await createInvalidRequest(strangerToken);

    assert.equal(
        strangerResponse.status,
        400,
        "Another user should not be affected by the requester's limit"
    );

    // Invalid requests must not create money request documents.
    const requestsAfter = await MoneyRequest.countDocuments({
        requesterId: requester._id
    });

    assert.equal(requestsAfter, requestsBefore);
});