import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod: MongoMemoryServer | undefined;

export const startTestDb = async (): Promise<void> => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
};

export const stopTestDb = async (): Promise<void> => {
  await mongoose.disconnect();
  await mongod?.stop();
};

export const clearCollection = async (
  model: mongoose.Model<any>,
): Promise<void> => {
  await model.deleteMany({});
};
