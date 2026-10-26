// Loads environment variables from .env
require("dotenv").config();

//Starts server
const express = require("express"); //We are importing Express.
const rootRouter = require("./routes/index");//import all api routes from the index.js file in the routes folder. This is where we define all our API endpoints.

const { connectDB } = require("./db"); //This reads your .env file & This imports the MongoDB connection function from your db.js.

const app = express(); //This creates our Express application.
// Keep the original body for Razorpay webhook signature verification
app.use(
    "/api/v1/webhooks/razorpay",
    express.raw({ type: "application/json" })
);

// Parse JSON for all other API routes
app.use(express.json()); // Turns JSON request body into req.body
app.get("/", (req, res) => { //When someone sends a GET request to /, execute this function.
    res.json({
        status: "KaasuPay backend is running"
    });
});

app.use(express.static("public"));
// All API routes start with /api/v1
app.use("/api/v1", rootRouter);

// Connect to MongoDB, then start server
connectDB().then(() => {
    app.listen(3000, () => {
        console.log("Server running on http://localhost:3000");
    });
});

// Start server
/* app.listen(3000, () => { //Start listening for requests on port 3000.
    console.log("Server running on http://localhost:3000");
}); */
//to run the server, use the command: node index.js 

