import mongoose from "mongoose";
import { seedCEO } from "../utils/seeder";

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

export const connectDatabase = async (retries = MAX_RETRIES): Promise<void> => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is missing");
  }

  try {
    await mongoose.connect(mongoUri, {
      autoIndex: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });

    await seedCEO();

    console.log("✅ MongoDB connected");

    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected");
    });

  } catch (error) {
    console.error(`MongoDB connection failed. Retries left: ${retries}`, error);

    if (retries === 0) {
      console.error("❌ Max retries reached. Exiting...");
      process.exit(1);
    }

    setTimeout(() => connectDatabase(retries - 1), RETRY_DELAY);
  }
};