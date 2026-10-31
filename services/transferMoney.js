const {
    Wallet,
    Transaction,
    LedgerEntry
} = require("../db");

const { reserveDailyLimit } = require("./dailyLimit");

function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

// Moves money using a session supplied by the caller.
// This function NEVER starts, commits, or ends a transaction.
async function transferMoney({
    fromUser,
    toUser,
    amount,
    note,
    session
}) {
    if (!session) {
        throw new Error("A MongoDB transaction session is required");
    }

    // Reserve the sender's daily limit inside the caller's transaction.
    await reserveDailyLimit(fromUser._id, amount, session);

    // Debit sender only when sufficient balance exists.
    const senderWallet = await Wallet.findOneAndUpdate(
        {
            userId: fromUser._id,
            balance: { $gte: amount }
        },
        {
            $inc: { balance: -amount }
        },
        {
            returnDocument: "after",
            session
        }
    );

    if (!senderWallet) {
        throw createHttpError(400, "Insufficient balance");
    }

    // Credit receiver.
    const receiverWallet = await Wallet.findOneAndUpdate(
        { userId: toUser._id },
        {
            $inc: { balance: amount }
        },
        {
            returnDocument: "after",
            session
        }
    );

    if (!receiverWallet) {
        throw createHttpError(404, "Recipient wallet not found");
    }

    // Create the transaction record.
    const [transaction] = await Transaction.create([{
        type: "TRANSFER",
        fromUserId: fromUser._id,
        toUserId: toUser._id,
        amount,
        note,
        status: "SUCCESS"
    }], { session });

    // Debit ledger entry.
    await LedgerEntry.create([{
        userId: fromUser._id,
        transactionId: transaction._id,
        direction: "DEBIT",
        amount,
        balanceAfter: senderWallet.balance
    }], { session });

    // Credit ledger entry.
    await LedgerEntry.create([{
        userId: toUser._id,
        transactionId: transaction._id,
        direction: "CREDIT",
        amount,
        balanceAfter: receiverWallet.balance
    }], { session });

    return {
        transaction,
        senderBalance: senderWallet.balance,
        receiverBalance: receiverWallet.balance
    };
}

module.exports = { transferMoney };