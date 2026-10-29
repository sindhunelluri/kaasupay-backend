const mongoose = require("mongoose");

// Connect to MongoDB
async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log("MongoDB connected successfully");

        console.log("Connected database:", mongoose.connection.name);
        console.log("MongoDB host:", mongoose.connection.host);

        await IdempotencyRecord.init();
        console.log("Idempotency index initialized");

        await DailyTransferLimit.init();
        console.log("Daily transfer limit index initialized");

    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

// User model
const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    firstName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 50
    },
    lastName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 50
    },
        passwordHash: {
        type: String,
        required: true
    },
    paymentPinHash: {
        type: String,
        default: null,
        select: false
    },
    pinFailedAttempts: {
        type: Number,
        default: 0,
        min: 0
    },
    pinLockedUntil: {
        type: Date,
        default: null
    }
});

// Wallet model
const walletSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true
    },
    balance: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        validate: {
            validator: Number.isInteger,
            message: "Balance must be an integer"
        }
    }
}, {
    timestamps: true
});


const paymentOrderSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    gatewayOrderId: {
        type: String,
        required: true,
        unique: true
    },
    amount: {
        type: Number,
        required: true,
        min: 1000,
        max: 1000000,
        validate: {
            validator: Number.isInteger,
            message: "Amount must be a whole number of paise"
        }
    },
    currency: {
        type: String,
        required: true,
        default: "INR"
    },
    status: {
        type: String,
        enum: ["CREATED", "PAID", "EXPIRED"],
        default: "CREATED",
        required: true
    },
    gatewayPaymentId: {
        type: String,
        default: null
    },
    paidVia: {
        type: String,
        enum: ["CALLBACK", "WEBHOOK"],
        default: null
    },
    transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
        default: null
    }
}, {
    timestamps: true
});


const transactionSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["DEPOSIT", "TRANSFER", "TOPUP", "WITHDRAWAL", "REVERSAL"],
        required: true
    },
    fromUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null
    },
    toUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
    },
    amount: {
        type: Number,
        required: true,
        min: 1,
        validate: {
            validator: Number.isInteger,
            message: "Amount must be a whole number of paise"
        }
    },
    note: {
        type: String,
        trim: true,
        maxlength: 50,
        default: ""
    },
    status: {
    type: String,
    enum: [
        "PENDING",
        "PROCESSING",
        "SUCCESS",
        "REVERSED",
        "NEEDS_REVIEW"
    ],
    default: "SUCCESS",
    required: true
}
}, {
    timestamps: true
});

const ledgerEntrySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
        required: true
    },
    direction: {
        type: String,
        enum: ["DEBIT", "CREDIT"],
        required: true
    },
    amount: {
        type: Number,
        required: true,
        min: 1,
        validate: {
            validator: Number.isInteger,
            message: "Amount must be a whole number of paise"
        }
    },
    balanceAfter: {
        type: Number,
        required: true,
        min: 0,
        validate: {
            validator: Number.isInteger,
            message: "Balance must be a whole number of paise"
        }
    }
}, {
    timestamps: true
});

ledgerEntrySchema.index({ userId: 1, createdAt: -1 });


const idempotencyRecordSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    key: {
        type: String,
        required: true
    },
    requestHash: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ["IN_PROGRESS", "DONE"],
        default: "IN_PROGRESS",
        required: true
    },
    response: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    }
}, {
    timestamps: true
});

// One idempotency key per user
idempotencyRecordSchema.index(
    { userId: 1, key: 1 },
    { unique: true }
);

// Daily outgoing transfer limit — amounts are stored in paise.
const dailyTransferLimitSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    dayKey: {
        type: String,
        required: true
    },
    totalAmount: {
        type: Number,
        required: true,
        default: 0,
        min: 0
    }
}, {
    timestamps: true
});

dailyTransferLimitSchema.index(
    { userId: 1, dayKey: 1 },
    { unique: true }
);

const DailyTransferLimit = mongoose.model(
    "DailyTransferLimit",
    dailyTransferLimitSchema
);
const User = mongoose.model("User", userSchema);
const Wallet = mongoose.model("Wallet", walletSchema);
const PaymentOrder = mongoose.model("PaymentOrder", paymentOrderSchema);
const Transaction = mongoose.model("Transaction", transactionSchema);
const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);
const IdempotencyRecord = mongoose.model("IdempotencyRecord",idempotencyRecordSchema);


// Bank account model — never return the full account number in API responses.
const bankAccountSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    holderName: {
        type: String,
        required: true,
        trim: true,
        minlength: 2,
        maxlength: 60
    },
    accountNumber: {
        type: String,
        required: true,
        match: /^\d{9,18}$/
    },
    ifsc: {
        type: String,
        required: true,
        uppercase: true,
        match: /^[A-Z]{4}0[A-Z0-9]{6}$/
    },
    last4: {
        type: String,
        required: true,
        match: /^\d{4}$/
    }
}, {
    timestamps: true
});

bankAccountSchema.index(
    { userId: 1, accountNumber: 1 },
    { unique: true }
);


// Withdrawal model.
const withdrawalSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    bankAccountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "BankAccount",
        required: true
    },
    amount: {
        type: Number,
        required: true,
        min: 1,
        validate: {
            validator: Number.isInteger,
            message: "Amount must be a whole number of paise"
        }
    },
    reference: {
        type: String,
        required: true,
        unique: true
    },
    transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    default: null
},
    status: {
        type: String,
        enum: [
            "PENDING",
            "PROCESSING",
            "SUCCESS",
            "REVERSED",
            "NEEDS_REVIEW"
        ],
        default: "PENDING",
        required: true
    },
    bankRef: {
        type: String,
        default: null
    },
    failureReason: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});


// Outbox model — durable jobs for the withdrawal worker.
const outboxEventSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["PAYOUT_REQUESTED"],
        required: true
    },
    withdrawalId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Withdrawal",
        required: true
    },
    status: {
        type: String,
        enum: ["NEW", "PROCESSING", "DONE", "STUCK"],
        default: "NEW",
        required: true
    },
    attempts: {
        type: Number,
        default: 0,
        min: 0
    },
    nextAttemptAt: {
        type: Date,
        default: Date.now
    },
    lockedAt: {
        type: Date,
        default: null
    },
    lastError: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

outboxEventSchema.index({ status: 1, nextAttemptAt: 1 });
const BankAccount = mongoose.model("BankAccount", bankAccountSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawalSchema);
const OutboxEvent = mongoose.model("OutboxEvent", outboxEventSchema);

module.exports = {
    connectDB,
    User,
    DailyTransferLimit,
    Wallet,
    PaymentOrder,
    Transaction,
    LedgerEntry,
    IdempotencyRecord,
    BankAccount,
    Withdrawal,
    OutboxEvent
};



//Temporary data storage
// Everything disappears when the server restarts.
/*const users = [];

const wallets = [];

let lastUserId = 0; 

let lastWalletId = 0;

function newUserId() {
    lastUserId = lastUserId + 1;
    return lastUserId;
}

function newWalletId() {
    lastWalletId = lastWalletId + 1;
    return lastWalletId;
}

module.exports = {
    users,
    wallets,
    newUserId,
    newWalletId
};*/