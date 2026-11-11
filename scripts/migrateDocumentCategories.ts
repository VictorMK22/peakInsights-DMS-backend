/**
 * One-off migration: categories now cover every document type.
 *
 *   1. Backfills `documentType: "learning"` on existing categories (they were
 *      all Learning Library categories).
 *   2. Drops the old GLOBAL unique index on `name` and creates the new
 *      non-unique lookup index. Without this, a personal "General" working
 *      category would collide with a learning "General" one.
 *
 * Mongoose runs with autoIndex disabled in this project, so index changes are
 * applied explicitly. Safe to re-run.
 *
 *   npx ts-node scripts/migrateDocumentCategories.ts
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { LearningCategoryModel } from "../src/models/LearningCategory";

dotenv.config();

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to DB");

  const backfill = await LearningCategoryModel.updateMany(
    { documentType: { $exists: false } },
    { $set: { documentType: "learning" } },
  );
  console.log(`Backfilled documentType on ${backfill.modifiedCount} categories`);

  const coll = LearningCategoryModel.collection;
  const indexes = await coll.indexes();
  for (const idx of indexes) {
    const keys = Object.keys(idx.key ?? {});
    if (idx.unique && keys.length === 1 && keys[0] === "name" && idx.name) {
      await coll.dropIndex(idx.name);
      console.log(`Dropped unique index ${idx.name}`);
    }
  }

  await coll.createIndex({ documentType: 1, ownerId: 1, order: 1, name: 1 });
  console.log("Ensured lookup index");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});