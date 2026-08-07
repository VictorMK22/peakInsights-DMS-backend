/**
 * Run this on a schedule (e.g. every 5 minutes via cron or a
 * platform scheduled job) so SLA breaches get escalated even if no
 * one happens to open the Help Desk in the meantime. The same
 * escalation also runs inline whenever GET /api/tickets is called —
 * this script exists for the gap between those requests.
 *
 * Usage:
 *   npx ts-node scripts/ict-sla-check.ts
 * or, after building:
 *   node dist/scripts/ict-sla-check.js
 *
 * Requires the same MONGODB_URI env var as the main app.
 */
import mongoose from "mongoose";
import { Ticket } from "../src/models/Ticket";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const result = await Ticket.updateMany(
    { status: { $in: ["open", "in_progress"] }, slaDueAt: { $lt: new Date() } },
    { $set: { status: "escalated" } },
  );

  console.log(`[ict-sla-check] escalated ${result.modifiedCount} ticket(s)`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[ict-sla-check] failed:", err);
  process.exit(1);
});
