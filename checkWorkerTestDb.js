require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const uri = process.env.MONGO_URL;

  if (!uri) {
    throw new Error("MONGO_URL is missing from .env");
  }

  const testUri = uri.replace(
    /\/kaasupay(?:_test)?(?=\?|$)/,
    "/kaasupay_worker_test"
  );

  if (testUri === uri) {
    throw new Error(
      "Could not safely identify the database name in MONGO_URL. No connection attempted."
    );
  }

  await mongoose.connect(testUri);

  try {
    console.log("Connected database:", mongoose.connection.name);

    if (mongoose.connection.name !== "kaasupay_worker_test") {
      throw new Error("Safety check failed: unexpected database.");
    }

    console.log("Safety check passed.");
    console.log("No records were created or modified.");
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => {
  console.error("Test connection check failed:", error.message);
  process.exit(1);
});
