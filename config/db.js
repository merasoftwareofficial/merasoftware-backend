const mongoose = require("mongoose")
const bandwidthTracker = require("../helpers/bandwidthTracker")

bandwidthTracker.installMongoosePlugin(mongoose);

async function connnectDB () {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      throw new Error("MONGODB_URI is missing in environment variables");
    }

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000
    });
}

module.exports = connnectDB;
