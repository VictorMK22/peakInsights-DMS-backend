/**
 * backfillOpeningBalance.ts
 *
 * One-off: gives every client created BEFORE opening balances existed an
 * explicit opening balance of 0 (KES), dated at the client's creation time.
 * Clients that already have one are left alone, so it is safe to re-run.
 *
 * Usage (backend root, MONGODB_URI in .env):
 *   npx ts-node scripts/backfillOpeningBalance.ts
 *
 * Review/adjust real balances afterwards from the client's Edit form (CEO).
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ClientModel } from "../src/models/Client";

dotenv.config();

(async () => {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);

  const res = await ClientModel.collection.updateMany(
    { openingBalance: { $exists: false } },
    [
      {
        $set: {
          openingBalance: 0,
          openingBalanceDate: { $ifNull: ["$createdAt", "$$NOW"] },
        },
      },
    ],
  );
  console.log(`✅ Backfilled ${res.modifiedCount} client(s).`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});
