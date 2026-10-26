// Configuration / secrets

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is missing in .env");
}

module.exports = {
    JWT_SECRET
};