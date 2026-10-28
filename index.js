
require("dotenv").config();

const app = require("./app");
const { connectDB } = require("./db");

connectDB()
    .then(() => {
        const PORT = process.env.PORT || 3000;

        app.listen(PORT, "0.0.0.0", () => {
            console.log(`KaasuPay backend running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error("Failed to connect to MongoDB:", error);
        process.exit(1);
    });
