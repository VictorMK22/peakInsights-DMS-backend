/**
 * cleanupDemoData.ts
 *
 * Removes ALL demo data from the PeakInsights database, keeping exactly one
 * user account (default: vpkipkemei@peakbooks.app).
 *
 *  - users collection      -> every user except the kept one is deleted
 *  - every other collection -> emptied (discovered dynamically, so new
 *                              collections like ydocs, auditlogs, etc. are
 *                              covered without editing this file)
 *
 * SAFE BY DEFAULT: running without --execute is a DRY RUN that only prints
 * what would be deleted.
 *
 * Usage (from the backend project root, with MONGODB_URI in .env):
 *
 *   npx ts-node scripts/cleanupDemoData.ts                 # dry run
 *   npx ts-node scripts/cleanupDemoData.ts --execute       # real run
 *
 * Options:
 *   --execute               actually delete (otherwise dry run)
 *   --email=<address>       user to keep (default vpkipkemei@peakbooks.app)
 *   --keep=a,b              extra collections to leave untouched,
 *                           e.g. --keep=departments,learningcategories
 *   --no-backup             skip the JSON backup written before deleting
 *   --yes                   skip the typed confirmation prompt
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import readline from "readline";

dotenv.config();

// ── CLI args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(name);
const getOpt = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const EXECUTE = hasFlag("--execute");
const SKIP_BACKUP = hasFlag("--no-backup");
const SKIP_PROMPT = hasFlag("--yes");
const KEEP_EMAIL = (getOpt("--email") ?? "vpkipkemei@peakbooks.app")
  .trim()
  .toLowerCase(); // User.email is stored lowercase by the schema
const KEEP_COLLECTIONS = new Set(
  (getOpt("--keep") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const USERS_COLLECTION = "users";

// ── helpers ──────────────────────────────────────────────────────────────
function redactUri(uri: string): string {
  // hide user:password@ in anything we print
  return uri.replace(/\/\/([^@/]+)@/, "//***:***@");
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

async function main(): Promise<void> {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI is missing (set it in .env)");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");

  const dbName = db.databaseName;
  console.log("────────────────────────────────────────────────────────");
  console.log(` Target : ${redactUri(uri)}`);
  console.log(` DB name: ${dbName}`);
  console.log(` Mode   : ${EXECUTE ? "EXECUTE (will delete)" : "DRY RUN"}`);
  console.log(` Keeping: ${KEEP_EMAIL}`);
  console.log("────────────────────────────────────────────────────────");

  // ── 1. The user to keep must exist ────────────────────────────────────
  const users = db.collection(USERS_COLLECTION);
  const keepUser = await users.findOne({ email: KEEP_EMAIL });
  if (!keepUser) {
    throw new Error(
      `User "${KEEP_EMAIL}" not found in "${USERS_COLLECTION}". ` +
        `Aborting — nothing was changed.`,
    );
  }
  console.log(
    `Found user to keep: ${keepUser["name"]} <${keepUser["email"]}> ` +
      `(role: ${keepUser["role"]}, status: ${keepUser["accountStatus"]}, ` +
      `active: ${keepUser["isActive"]})`,
  );

  // ── 2. Warnings that could lock you out or recreate demo data ─────────
  const warnings: string[] = [];
  if (keepUser["role"] !== "ceo") {
    warnings.push(
      `This user's role is "${keepUser["role"]}", not "ceo". After cleanup there ` +
        `will be NO CEO, and the backend's seedCEO() will automatically create one ` +
        `on the next start (default ceo@peakinsights.com / PeakInsights@2025 ` +
        `unless CEO_EMAIL / CEO_PASSWORD are set in Vercel). Either make this ` +
        `user the CEO or set CEO_EMAIL and CEO_PASSWORD in Vercel first.`,
    );
  }
  if (
    keepUser["isActive"] === false ||
    keepUser["accountStatus"] !== "active"
  ) {
    warnings.push(
      `This user is not active/approved (isActive=${keepUser["isActive"]}, ` +
        `accountStatus=${keepUser["accountStatus"]}). With every other user ` +
        `deleted, nobody would be able to approve or activate it.`,
    );
  }
  warnings.forEach((w) => console.log(`\n⚠️  WARNING: ${w}`));

  // ── 3. Work out what will be deleted ──────────────────────────────────
  const all = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = all
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system."))
    .sort();

  type Plan = { name: string; filter: Record<string, unknown>; count: number };
  const plan: Plan[] = [];
  for (const name of names) {
    if (KEEP_COLLECTIONS.has(name)) continue;
    const filter =
      name === USERS_COLLECTION ? { _id: { $ne: keepUser._id } } : {};
    const count = await db.collection(name).countDocuments(filter);
    plan.push({ name, filter, count });
  }

  console.log("\nCollection".padEnd(32) + "To delete");
  console.log("─".repeat(44));
  for (const p of plan) {
    console.log(`${p.name.padEnd(31)} ${p.count}`);
  }
  if (KEEP_COLLECTIONS.size) {
    console.log(
      `\nLeft untouched (--keep): ${[...KEEP_COLLECTIONS].join(", ")}`,
    );
  }
  const total = plan.reduce((s, p) => s + p.count, 0);
  console.log("─".repeat(44));
  console.log(`${"TOTAL".padEnd(31)} ${total}\n`);

  if (!EXECUTE) {
    console.log("Dry run only — nothing was deleted.");
    console.log("Re-run with --execute to apply.");
    return;
  }

  // ── 4. Backup ─────────────────────────────────────────────────────────
  if (!SKIP_BACKUP) {
    const EJSON = mongoose.mongo.BSON.EJSON;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.resolve(process.cwd(), `backup-${dbName}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const p of plan) {
      if (p.count === 0) continue;
      const docs = await db.collection(p.name).find(p.filter).toArray();
      fs.writeFileSync(
        path.join(dir, `${p.name}.json`),
        EJSON.stringify(docs, undefined, 2, { relaxed: false }),
      );
    }
    console.log(`💾 Backup of the data to be deleted written to:\n   ${dir}`);
    console.log(
      "   (contains password hashes — keep it private, don't commit it)\n",
    );
  } else {
    console.log("⚠️  --no-backup: skipping backup.\n");
  }

  // ── 5. Confirmation ───────────────────────────────────────────────────
  if (!SKIP_PROMPT) {
    const answer = await ask(
      `This permanently deletes ${total} documents from "${dbName}".\n` +
        `Type the database name to confirm: `,
    );
    if (answer !== dbName) {
      console.log("Confirmation did not match. Aborted — nothing was deleted.");
      return;
    }
  }

  // ── 6. Delete ─────────────────────────────────────────────────────────
  console.log("\nDeleting...");
  for (const p of plan) {
    if (p.count === 0) continue;
    const res = await db.collection(p.name).deleteMany(p.filter);
    console.log(`  ${p.name.padEnd(30)} deleted ${res.deletedCount}`);
  }

  // The kept user may point at users that no longer exist. Clear those
  // references so populate()/hooks don't trip over them.
  const unset: Record<string, ""> = {};
  for (const field of ["supervisorId", "createdBy", "approvedBy"]) {
    if (keepUser[field] !== undefined && keepUser[field] !== null) {
      unset[field] = "";
    }
  }
  if (Object.keys(unset).length) {
    await users.updateOne({ _id: keepUser._id }, { $unset: unset });
    console.log(
      `  Cleared dangling references on kept user: ${Object.keys(unset).join(", ")}`,
    );
  }

  // ── 7. Verify ─────────────────────────────────────────────────────────
  const remainingUsers = await users.countDocuments({});
  console.log(
    `\n✅ Done. Users remaining: ${remainingUsers} (expected 1: ${KEEP_EMAIL})`,
  );
}

main()
  .catch((err) => {
    console.error(
      "❌ Cleanup failed:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
