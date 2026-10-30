
const express = require("express");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { User, Wallet } = require("../db");
const { JWT_SECRET } = require("../config");
const authMiddleware = require("../middleware/auth");
const { verifyPaymentPin } = require("../services/paymentPin");

const router = express.Router();

// --------------------
// ZOD ERROR HELPER
// --------------------
function firstError(zodError) {
    const issue = zodError.issues[0];
    const field = issue.path[0] || "body";

    return `${field}: ${issue.message}`;
}

// --------------------
// SIGNUP SCHEMA
// --------------------
const signupSchema = z.object({
    username: z.string()
        .trim()
        .toLowerCase()
        .email("must be a valid email"),

    firstName: z.string()
        .trim()
        .min(1, "is required")
        .max(50, "is too long"),

    lastName: z.string()
        .trim()
        .min(1, "is required")
        .max(50, "is too long"),

    password: z.string()
        .min(6, "must be at least 6 characters"),
});

// --------------------
// SIGNUP
// --------------------
router.post("/signup", async (req, res) => {
    try {
        const result = signupSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                error: firstError(result.error),
            });
        }

        const {
            username,
            firstName,
            lastName,
            password,
        } = result.data;

        const existing = await User.findOne({ username });

        if (existing) {
            return res.status(409).json({
                error: "This email is already registered",
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const user = await User.create({
            username,
            firstName,
            lastName,
            passwordHash,
        });

        const wallet = await Wallet.create({
            userId: user._id,
            balance: 0,
        });

        return res.status(201).json({
            message: "User created successfully",
            user: {
                id: user._id,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
            },
            wallet: {
                id: wallet._id,
                balance: wallet.balance,
            },
        });
    } catch (error) {
        console.error("Signup error:", error);

        return res.status(500).json({
            error: "Could not create user",
        });
    }
});

// --------------------
// SIGNIN SCHEMA
// --------------------
const signinSchema = z.object({
    username: z.string()
        .trim()
        .toLowerCase()
        .email("must be a valid email"),

    password: z.string()
        .min(1, "is required"),
});

// --------------------
// SIGNIN
// --------------------
router.post("/signin", async (req, res) => {
    const requestStart = Date.now();

    try {
        const result = signinSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                error: firstError(result.error),
            });
        }

        const { username, password } = result.data;

        const dbStart = Date.now();
        const user = await User.findOne({ username });
        const dbMs = Date.now() - dbStart;

        if (!user) {
            console.log(
                `[SIGNIN TIMING] db=${dbMs}ms user-not-found`
            );

            return res.status(401).json({
                error: "Wrong email or password",
            });
        }

        const bcryptStart = Date.now();

        const passwordOk = await bcrypt.compare(
            password,
            user.passwordHash
        );

        const bcryptMs = Date.now() - bcryptStart;

        if (!passwordOk) {
            console.log(
                `[SIGNIN TIMING] db=${dbMs}ms bcrypt=${bcryptMs}ms password-invalid`
            );

            return res.status(401).json({
                error: "Wrong email or password",
            });
        }

        const jwtStart = Date.now();

        const token = jwt.sign(
            { userId: user._id.toString() },
            JWT_SECRET,
            { expiresIn: "1h" }
        );

        const jwtMs = Date.now() - jwtStart;

        console.log(
            `[SIGNIN TIMING] db=${dbMs}ms bcrypt=${bcryptMs}ms jwt=${jwtMs}ms total=${Date.now() - requestStart}ms`
        );

        return res.status(200).json({
            message: "Signed in",
            token,
        });
    } catch (error) {
        console.error("Sign-in error:", error);

        return res.status(500).json({
            error: "Something went wrong",
        });
    }
});

// --------------------
// GET CURRENT USER
// --------------------
router.get("/me", authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.userId)
            .select("+paymentPinHash")
            .lean();

        if (!user) {
            return res.status(404).json({
                error: "User not found",
            });
        }

        return res.status(200).json({
            user: {
                _id: user._id,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
                hasPaymentPin: Boolean(user.paymentPinHash),
            },
        });
    } catch (error) {
        console.error("GET /me error:", error);

        return res.status(500).json({
            error: "Could not fetch user details",
        });
    }
});

// --------------------
// PAYMENT PIN SCHEMA
// --------------------
const paymentPinSchema = z.object({
    password: z.string().min(1),
    pin: z.string().regex(
        /^\d{4,6}$/,
        "PIN must contain 4 to 6 digits"
    ),
});

// --------------------
// CREATE PAYMENT PIN
// --------------------
router.post("/payment-pin", authMiddleware, async (req, res) => {
    const parsed = paymentPinSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: "Enter your account password and a valid 4–6 digit PIN",
        });
    }

    try {
        const { password, pin } = parsed.data;

        const user = await User.findById(req.userId)
            .select("+paymentPinHash");

        if (!user) {
            return res.status(404).json({
                error: "User not found",
            });
        }

        const passwordMatches = await bcrypt.compare(
            password,
            user.passwordHash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                error: "Incorrect account password",
            });
        }

        if (user.paymentPinHash) {
            return res.status(409).json({
                error: "Payment PIN is already set",
            });
        }

        const paymentPinHash = await bcrypt.hash(pin, 10);

        const updatedUser = await User.findOneAndUpdate(
            {
                _id: req.userId,
                $or: [
                    { paymentPinHash: null },
                    { paymentPinHash: { $exists: false } },
                ],
            },
            {
                $set: {
                    paymentPinHash,
                    pinFailedAttempts: 0,
                    pinLockedUntil: null,
                },
            },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(409).json({
                error: "Payment PIN is already set",
            });
        }

        return res.status(201).json({
            message: "Payment PIN created successfully",
            hasPaymentPin: true,
        });
    } catch (error) {
        console.error("Payment PIN setup error:", error);

        return res.status(500).json({
            error: "Could not create Payment PIN",
        });
    }
});

// --------------------
// VERIFY PAYMENT PIN
// --------------------
const verifyPinSchema = z.object({
    pin: z.string().regex(/^\d{4,6}$/),
});

router.post("/payment-pin/verify", authMiddleware, async (req, res) => {
    const parsed = verifyPinSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: "Enter a valid 4–6 digit PIN",
        });
    }

    try {
        const result = await verifyPaymentPin(
            req.userId,
            parsed.data.pin
        );

        if (result.ok) {
            return res.status(200).json({
                message: "Payment PIN verified successfully",
            });
        }

        if (result.status === "PIN_NOT_SET") {
            return res.status(400).json({
                error: "Set your payment PIN first",
            });
        }

        if (result.status === "PIN_LOCKED") {
            return res.status(423).json({
                error: "Payment PIN is temporarily locked",
                retryAfterSeconds: result.retryAfterSeconds,
            });
        }

        if (result.status === "PIN_RETRY") {
            return res.status(409).json({
                error: "PIN verification conflicted with another request. Try again.",
            });
        }

        return res.status(401).json({
            error: "Incorrect payment PIN",
            attemptsRemaining: result.attemptsRemaining,
        });
    } catch (error) {
        console.error("Payment PIN verification error:", error);

        return res.status(500).json({
            error: "Could not verify Payment PIN",
        });
    }
});

module.exports = router;
