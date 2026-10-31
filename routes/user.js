const express = require("express");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { User, Wallet } = require("../db");
const { JWT_SECRET } = require("../config");
const authMiddleware = require("../middleware/auth");
const {
    verifyPaymentPin,
    sendPinFailure,
    pinProblem
} = require("../services/paymentPin");
const { rateLimit, byIp, byUser, byEmail } = require("../middleware/rateLimit");

// Rate limits (Day 6)
const signupIpLimit = rateLimit({ name: "signup-ip", max: 10, windowSeconds: 3600, keyFrom: byIp });
const signinIpLimit = rateLimit({ name: "signin-ip", max: 20, windowSeconds: 60, keyFrom: byIp });
const signinEmailLimit = rateLimit({ name: "signin-email", max: 5, windowSeconds: 60, keyFrom: byEmail });
const passwordChangeLimit = rateLimit({ name: "password-change", max: 5, windowSeconds: 3600, keyFrom: byUser });
const pinSetupLimit = rateLimit({ name: "pin-setup", max: 5, windowSeconds: 3600, keyFrom: byUser });

function makeToken(user) {
    return jwt.sign(
        { userId: user._id.toString(), tv: user.tokenVersion ?? 0 },
        JWT_SECRET,
        { expiresIn: "1h" }
    );
}

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
router.post("/signup", signupIpLimit, async (req, res) => {
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
router.post("/signin", signinIpLimit, signinEmailLimit, async (req, res) => {
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

        const token = makeToken(user);

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
                hasPin: Boolean(user.paymentPinHash),
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
    pin: z.string(),
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

        const problem = pinProblem(pin);
        if (problem) {
            return res.status(400).json({ error: problem, message: problem });
        }

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

        if (sendPinFailure(res, result)) return;

        return res.status(200).json({
            message: "Payment PIN verified successfully",
        });
    } catch (error) {
        console.error("Payment PIN verification error:", error);

        return res.status(500).json({
            error: "Could not verify Payment PIN",
        });
    }
});

// --------------------
// SET OR CHANGE PIN  (POST /api/v1/user/pin)
// --------------------
const setPinSchema = z.object({
    password: z.string().min(1),
    pin: z.string(),
});

router.post("/pin", authMiddleware, pinSetupLimit, async (req, res) => {
    const parsed = setPinSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: "password and pin are required",
            message: "password and pin are required",
        });
    }

    const { password, pin } = parsed.data;

    const problem = pinProblem(pin);
    if (problem) {
        return res.status(400).json({ error: problem, message: problem });
    }

    try {
        const user = await User.findById(req.userId).select("+paymentPinHash passwordHash");

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const passwordOk = await bcrypt.compare(password, user.passwordHash);
        if (!passwordOk) {
            return res.status(401).json({ error: "Wrong password", message: "Wrong password" });
        }

        const hadPin = Boolean(user.paymentPinHash);
        const paymentPinHash = await bcrypt.hash(pin, 10);

        await User.updateOne(
            { _id: req.userId },
            { $set: { paymentPinHash, pinFailedAttempts: 0, pinLockedUntil: null } }
        );

        const text = hadPin ? "PIN changed" : "PIN set";
        return res.status(200).json({ message: text });
    } catch (error) {
        console.error("Set PIN error:", error.message);
        return res.status(500).json({ error: "Could not save PIN" });
    }
});

// --------------------
// LOG OUT OF ALL DEVICES
// --------------------
router.post("/logout-all", authMiddleware, async (req, res) => {
    try {
        await User.updateOne({ _id: req.userId }, { $inc: { tokenVersion: 1 } });

        return res.status(200).json({ message: "Signed out on all devices" });
    } catch (error) {
        console.error("Logout-all error:", error.message);
        return res.status(500).json({ error: "Could not sign you out" });
    }
});

// --------------------
// CHANGE PASSWORD (ends every old session, returns a fresh token)
// --------------------
const changePasswordSchema = z.object({
    username: z.string().trim().toLowerCase().email("must be a valid email"),
    oldPassword: z.string().min(1, "is required"),
    newPassword: z.string().min(6, "must be at least 6 characters"),
});

router.put("/", authMiddleware, passwordChangeLimit, async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);

    if (!parsed.success) {
        const text = firstError(parsed.error);
        return res.status(400).json({ error: text, message: text });
    }

    const { username, oldPassword, newPassword } = parsed.data;

    try {
        const account = await User.findById(req.userId).select("username passwordHash");

        if (!account) {
            return res.status(404).json({ error: "User not found" });
        }

        // The email must be the one for the account that is signed in.
        if (account.username !== username) {
            const text = "Email does not match your account";
            return res.status(400).json({ error: text, message: text });
        }

        const oldOk = await bcrypt.compare(oldPassword, account.passwordHash);
        if (!oldOk) {
            const text = "Old password is wrong";
            return res.status(401).json({ error: text, message: text });
        }

        if (oldPassword === newPassword) {
            const text = "New password must be different from the old one";
            return res.status(400).json({ error: text, message: text });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);

        const user = await User.findByIdAndUpdate(
            req.userId,
            { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
            { returnDocument: "after" }
        );

        return res.status(200).json({
            message: "Password changed. You are signed out on all devices",
            token: makeToken(user),
        });
    } catch (error) {
        console.error("Change password error:", error.message);
        return res.status(500).json({ error: "Could not change password" });
    }
});

module.exports = router;