require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URL);
  console.log("Database:", mongoose.connection.name);

  const ids = [
    "6adcd6f3d43ea51453c9cb6d",
    "6adce2a19208e6e365df80a2",
    "6adce30f9208e6e365df80a8"
  ];

  const collection = mongoose.connection.collection("withdrawals");

  for (const id of ids) {
    const record = await collection.findOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        projection: {
          reference: 1,
          amount: 1,
          status: 1,
          bankRef: 1,
          failureReason: 1
        }
      }
    );

    console.log(JSON.stringify(record, null, 2));
  }

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
