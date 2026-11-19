/**
 * backfillOldEmails.ts
 *
 * Fills in the real "To" address (e.g. the company address) and Zoho read state
 * on synced emails that are older than the regular sync looks at. It pages back
 * through every connected mailbox's Inbox and Sent folders and matches messages
 * to the emails already in the hub.
 *
 * Only fills gaps: it never creates, deletes or un-reads an email, so it is safe
 * to run more than once. Run it AFTER mergeGroupEmailDuplicates.ts --execute.
 *
 * Usage (backend project root; MONGODB_URI and the Zoho credentials in .env):
 *
 *   npx ts-node scripts/backfillOldEmails.ts              # last 120 days
 *   npx ts-node scripts/backfillOldEmails.ts --days=365   # reach further back
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import { backfillOldEmails } from "../src/services/emailSyncService";

dotenv.config();

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = daysArg ? Number(daysArg.split("=")[1]) : 120;

async function main(): Promise<void> {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI is missing (set it in .env)");
  if (!Number.isFinite(days) || days <= 0)
    throw new Error("--days must be a positive number");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });

  console.log(`Backfilling emails from the last ${days} days...`);
  const r = await backfillOldEmails({ days });
  console.log(
    `Done: ${r.mailboxes} mailbox(es) checked (${r.failed} failed), ` +
      `${r.messagesScanned} messages scanned, ${r.emailsUpdated} hub email(s) updated.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());