/**
 * fixEmailDuplicatesAndDates.ts
 *
 * One-off cleanup for emails already in the hub, to run AFTER deploying the
 * sync fix (src/services/emailSyncService.ts). It repairs two things:
 *
 *  1. FUTURE / SHIFTED DATES. Synced emails were stamped with Zoho's
 *     `sentDateInGMT`, which is off by the mailbox's timezone offset (8h ahead
 *     for a US-Pacific account). A synced email can't have been sent after the
 *     moment we saved it, so any external_sync row whose sentAt is later than
 *     its createdAt (or later than now) gets the shift is
 *     subtracted (whole half-hours, 8h here), recovering the real send time; if
 *     that looks implausible it falls back to createdAt (the sync time, ~10 min).
 *
 *  2. DUPLICATES. The same message logged twice: once when it was sent from the
 *     hub, again when the sync found the delivered copy. Same sender + same
 *     subject + within 10 minutes + a shared address = one email. The kept row
 *     is the one with replies, else the hub-sent one, else the oldest. Other
 *     recipients of the dropped rows are put on the kept row's Cc (with their
 *     read state), and the dropped rows are written to a JSON backup first.
 *     Groups where more than one row has replies are skipped and reported.
 *
 * SAFE BY DEFAULT: without --execute it only prints what it would do.
 *
 *   npx ts-node scripts/fixEmailDuplicatesAndDates.ts             # dry run
 *   npx ts-node scripts/fixEmailDuplicatesAndDates.ts --execute   # real run
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { EmailLog } from "../src/models/EmailLog";

dotenv.config();

const EXECUTE = process.argv.includes("--execute");
const WINDOW_MS = 10 * 60 * 1000;
const SLACK_MS = 5 * 60 * 1000;

const addrs = (r: any): Set<string> =>
  new Set(
    [r.toEmail, ...(r.toAddresses ?? []), ...(r.ccEmails ?? [])]
      .filter(Boolean)
      .map((a: string) => a.toLowerCase()),
  );
const overlap = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));

async function main() {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI is missing (set it in .env)");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log(EXECUTE ? "EXECUTE mode\n" : "DRY RUN (add --execute to apply)\n");

  // ── 1. Dates ───────────────────────────────────────────────────
  const now = Date.now();
  const synced = await EmailLog.find({ source: "external_sync" })
    .select("sentAt createdAt lastMessageAt subject")
    .lean();
  let dateFixes = 0;
  for (const r of synced as any[]) {
    if (!r.sentAt) continue;
    const bad =
      r.sentAt.getTime() > now ||
      r.sentAt.getTime() > r.createdAt.getTime() + SLACK_MS;
    if (!bad) continue;
    dateFixes++;
    // The shift is a whole number of half-hours (8h for this account), less the
    // few minutes between the real send and our sync. Round it off to recover
    // the real send time; if that lands somewhere implausible, use the sync time.
    const HALF_HOUR = 30 * 60 * 1000;
    const diff = r.sentAt.getTime() - r.createdAt.getTime();
    const shift = Math.round(diff / HALF_HOUR) * HALF_HOUR;
    const exact = r.sentAt.getTime() - shift;
    const plausible =
      shift > 0 &&
      exact <= r.createdAt.getTime() + SLACK_MS &&
      exact >= r.createdAt.getTime() - 2 * 60 * 60 * 1000;
    const fixed = new Date(
      plausible ? exact : Math.min(r.createdAt.getTime(), now),
    );
    console.log(
      `date: "${r.subject}" ${r.sentAt.toISOString()} -> ${fixed.toISOString()}`,
    );
    if (EXECUTE) {
      const set: Record<string, Date> = { sentAt: fixed };
      // only move lastMessageAt if it was just the wrong send time (no newer reply)
      if (r.lastMessageAt && r.lastMessageAt.getTime() === r.sentAt.getTime())
        set.lastMessageAt = fixed;
      await EmailLog.updateOne({ _id: r._id }, { $set: set });
    }
  }
  console.log(`\n${dateFixes} email date(s) ${EXECUTE ? "fixed" : "to fix"}.\n`);

  // ── 2. Duplicates ──────────────────────────────────────────────
  const rows: any[] = await EmailLog.find({
    parentId: null,
    broadcastId: { $exists: false },
  }).lean();
  const withReplies = new Set(
    (await EmailLog.distinct("parentId", { parentId: { $ne: null } })).map(String),
  );
  const t = (r: any) => (r.sentAt ?? r.createdAt).getTime();

  const bySubject = new Map<string, any[]>();
  for (const r of rows) {
    const k = `${r.senderId}|${r.subject.trim().toLowerCase()}`;
    (bySubject.get(k) ?? bySubject.set(k, []).get(k)!).push(r);
  }

  const backupFile = path.join(process.cwd(), `email-duplicates-backup-${Date.now()}.jsonl`);
  let removed = 0;
  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => t(a) - t(b));
    const used = new Set<string>();
    for (const seed of group) {
      if (used.has(String(seed._id))) continue;
      const cluster = group.filter(
        (r) =>
          !used.has(String(r._id)) &&
          // createdAt proxy covers rows whose sentAt was shifted
          (Math.abs(t(r) - t(seed)) <= WINDOW_MS ||
            Math.abs(r.createdAt.getTime() - seed.createdAt.getTime()) <= WINDOW_MS) &&
          overlap(addrs(r), addrs(seed)),
      );
      cluster.forEach((r) => used.add(String(r._id)));
      if (cluster.length < 2) continue;

      const replied = cluster.filter((r) => withReplies.has(String(r._id)));
      if (replied.length > 1) {
        console.log(`SKIP (several copies have replies): "${seed.subject}"`);
        continue;
      }
      const keeper =
        replied[0] ??
        cluster.find((r) => r.source === "system") ??
        cluster[0];
      const drop = cluster.filter((r) => r._id !== keeper._id);

      console.log(
        `dup: "${keeper.subject}" keep ${keeper._id} (${keeper.source}), drop ${drop.length}`,
      );
      if (!EXECUTE) continue;

      const ccAdd: any[] = [];
      const readAdd: any[] = [];
      for (const d of drop) {
        const person = String(d.receiverId);
        if (person !== String(keeper.receiverId) && person !== String(keeper.senderId)) {
          ccAdd.push(d.receiverId);
          if (d.isRead) readAdd.push(d.receiverId);
        }
      }
      const set: Record<string, unknown> = {};
      if (keeper.toAddresses == null) {
        const d = drop.find((x) => x.toAddresses?.length);
        if (d) set.toAddresses = d.toAddresses;
      }
      if (!keeper.attachments?.length) {
        const d = drop.find((x) => x.attachments?.length);
        if (d) set.attachments = d.attachments;
      }
      const update: any = {};
      if (Object.keys(set).length) update.$set = set;
      if (ccAdd.length || readAdd.length)
        update.$addToSet = {
          ...(ccAdd.length && { ccIds: { $each: ccAdd } }),
          ...(readAdd.length && { ccReadBy: { $each: readAdd } }),
        };
      if (Object.keys(update).length)
        await EmailLog.updateOne({ _id: keeper._id }, update);

      // Back up BEFORE deleting, one JSON row per line.
      fs.appendFileSync(backupFile, drop.map((d) => JSON.stringify(d)).join("\n") + "\n");
      await EmailLog.deleteMany({ _id: { $in: drop.map((d) => d._id) } });
      removed += drop.length;
    }
  }

  if (EXECUTE && removed) console.log(`\nBackup of deleted rows: ${backupFile}`);
  console.log(`\n${removed} duplicate row(s) ${EXECUTE ? "removed" : "(dry run, none removed)"}.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});