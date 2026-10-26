// Signup / signin logic

const express = require("express"); //importing express module to create a router for user-related routes
const { z } = require("zod"); // importing zod module for schema validation
const bcrypt = require("bcryptjs");//importing bcryptjs module for hashing passwords
const jwt = require("jsonwebtoken");//importing jsonwebtoken module for creating and verifying JWT tokens for user authentication

const { User, Wallet } = require("../db");//importing User and Wallet models from db.js for mongoose database operations

const { JWT_SECRET } = require("../config");

const authMiddleware = require("../middleware/auth");

const router = express.Router();

// ZOD ERROR HELPER
function firstError(zodError) {
    const issue = zodError.issues[0];
    const field = issue.path[0] || "body";

    return `${field}: ${issue.message}`;
}

// SIGNUP SCHEMA
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


// SIGNUP
router.post("/signup", async (req, res) => {

    // 1. Check request data
    const result = signupSchema.safeParse(req.body);

    if (!result.success) {
        return res.status(400).json({
            error: firstError(result.error)
        });
    }

    const {
        username,
        firstName,
        lastName,
        password
    } = result.data;


    // 2. Check whether email already exists
    const existing = await User.findOne({ username });

    if (existing) {
        return res.status(409).json({
            error: "This email is already registered"
        });
    }


    // 3. Hash the password
    const passwordHash = await bcrypt.hash(password, 10);


    // 4. Create and save user in MongoDB
    const user = await User.create({
        username,
        firstName,
        lastName,
        passwordHash
    });


    // 5. Create an empty wallet
    // Balance is stored in paise.
    const wallet = await Wallet.create({
        userId: user._id,
        balance: 0
    });


    // 6. Send response
    // Never send password or passwordHash.
    return res.status(201).json({
        message: "User created successfully",

        user: {
            id: user._id,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName
        },

        wallet: {
            id: wallet._id,
            balance: wallet.balance
        }
    });
});


// SIGNIN SCHEMA
const signinSchema = z.object({
    username: z
        .string()
        .trim()
        .toLowerCase()
        .email("must be a valid email"),

    password: z
        .string()
        .min(1, "is required"),
});


// SIGNIN
router.post("/signin", async (req, res) => {

    // 1. Validate request data
    const result = signinSchema.safeParse(req.body);

    if (!result.success) {
        return res.status(400).json({
            error: firstError(result.error)
        });
    }

    const {
        username,
        password
    } = result.data;


    // 2. Find user by email
    const user = await User.findOne({ username });

    if (!user) {
        return res.status(401).json({
            error: "Wrong email or password"
        });
    }


    // 3. Compare entered password with stored hash
    const passwordOk = await bcrypt.compare(
        password,
        user.passwordHash
    );

    if (!passwordOk) {
        return res.status(401).json({
            error: "Wrong email or password"
        });
    }


    // 4. Create JWT token
    const token = jwt.sign(
        {
            userId: user._id.toString()
        },
        JWT_SECRET,
        {
            expiresIn: "1h"
        }
    );


    // 5. Send token
    return res.json({
        message: "Signed in",
        token
    });
});

// GET CURRENT USER
router.get("/me", authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.userId)
            .select("-passwordHash");

        if (!user) {
            return res.status(404).json({
                error: "User not found"
            });
        }

        return res.json({
            user
        });

    } catch (error) {
        console.error("Get user error:", error);

        return res.status(500).json({
            error: "Something went wrong"
        });
    }
});

module.exports = router;