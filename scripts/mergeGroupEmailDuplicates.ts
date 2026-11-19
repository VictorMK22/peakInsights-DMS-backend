/**
 * mergeGroupEmailDuplicates.ts
 *
 * An email sent to a company/group address (e.g. peakinsights@…) reaches every
 * member's Zoho mailbox. Before the sync fix, each member's mailbox created its
 * OWN row in the hub, so one email showed up as N rows ("Weekly Meeting Minutes"
 * x7). This merges those rows back into ONE email per message:
 *
 *  - keeps one row (the one with replies, else the oldest),
 *  - puts every other recipient on its Cc list, carrying over who had read it,
 *  - deletes the extra rows (after writing them to a JSON backup).
 *
 * What counts as "the same email": synced from Zoho, same sender, same subject,
 * sent within 2 minutes of each other, to 2+ different recipients. If someone
 * really did send the same subject to people one at a time within two minutes,
 * those would be merged too — the dry run lists every group so you can check.
 * Groups where more than one copy has replies are skipped and reported.
 *
 * RUN ORDER: deploy the sync fix first and click Sync (or wait one cycle) so the
 * read state of each copy is up to date — this script carries it over.
 *
 * SAFE BY DEFAULT: without --execute it only prints what it would do.
 *
 * Usage (backend project root, MONGODB_URI in .env):
 *
 *   npx ts-node scripts/mergeGroupEmailDuplicates.ts             # dry run
 *   npx ts-node scripts/mergeGroupEmailDuplicates.ts --execute   # real run
 *
 * Note: each copy had its own attachment files uploaded to S3. The extra files
 * are left in the bucket (harmless, just unused storage).
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { EmailLog } from "../src/models/EmailLog";
import { User } from "../src/models/User";

dotenv.config();

const EXECUTE = process.argv.includes("--execute");
const WINDOW_MS = 2 * 60 * 1000;

type Row = {
  _id: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;
  ccIds?: mongoose.Types.ObjectId[];
  ccReadBy?: mongoose.Types.ObjectId[];
  isRead: boolean;
  subject: string;
  sentAt?: Date;
  createdAt: Date;
};

const when = (r: Row) => (r.sentAt ?? r.createdAt).getTime();

async function main(): Promise<void> {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI is missing (set it in .env)");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });

  // An old schema built a { ccIds, ccReadBy } index. MongoDB can't index two
  // array fields together, so saving an email that has both fails ("cannot
  // index parallel arrays"). Drop it first (deploy the updated EmailLog model
  // before running this, or the app recreates it on its next start).
  const BAD_INDEX = "ccIds_1_ccReadBy_1";
  const hasBadIndex = (await EmailLog.collection.indexes()).some(
    (i) => i.name === BAD_INDEX,
  );
  if (hasBadIndex) {
    if (EXECUTE) {
      await EmailLog.collection.dropIndex(BAD_INDEX);
      console.log(`Dropped index ${BAD_INDEX}.\n`);
    } else {
      console.log(`Would drop index ${BAD_INDEX} (it blocks the merge).\n`);
    }
  }

  const rows = (await EmailLog.find({
    source: "external_sync",
    parentId: null,
    broadcastId: { $exists: false },
  })
    .select("senderId receiverId ccIds ccReadBy isRead subject sentAt createdAt")
    .lean()) as unknown as Row[];

  // Rows that have replies hanging off them.
  const withReplies = new Set(
    (await EmailLog.find({ parentId: { $in: rows.map((r) => r._id) } }).distinct(
      "parentId",
    )).map(String),
  );

  // Group by sender + subject, then split each group into 2-minute clusters.
  const bySubject = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.senderId}|${r.subject.trim().toLowerCase()}`;
    (bySubject.get(k) ?? bySubject.set(k, []).get(k)!).push(r);
  }

  const clusters: Row[][] = [];
  for (const group of bySubject.values()) {
    group.sort((a, b) => when(a) - when(b));
    let current: Row[] = [];
    for (const r of group) {
      if (current.length && when(r) - when(current[0]) > WINDOW_MS) {
        clusters.push(current);
        current = [];
      }
      current.push(r);
    }
    if (current.length) clusters.push(current);
  }

  const mergeable = clusters.filter(
    (c) => new Set(c.map((r) => String(r.receiverId))).size >= 2,
  );

  const userIds = new Set<string>();
  mergeable.forEach((c) =>
    c.forEach((r) => {
      userIds.add(String(r.senderId));
      userIds.add(String(r.receiverId));
    }),
  );
  const users = await User.find({ _id: { $in: [...userIds] } })
    .select("name")
    .lean();
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
  const name = (id: unknown) => nameOf.get(String(id)) ?? String(id);

  console.log(
    `${EXECUTE ? "EXECUTING" : "DRY RUN"} — ${mergeable.length} group email(s) found split into several rows.\n`,
  );

  let merged = 0;
  let removed = 0;
  const backup: unknown[] = [];

  for (const cluster of mergeable) {
    const replied = cluster.filter((r) => withReplies.has(String(r._id)));
    const label = `"${cluster[0].subject}" from ${name(cluster[0].senderId)}, ${(cluster[0].sentAt ?? cluster[0].createdAt).toISOString()}`;

    if (replied.length > 1) {
      console.log(`SKIP  ${label}\n      ${replied.length} copies have replies — merge by hand.\n`);
      continue;
    }

    const keep = replied[0] ?? cluster.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    const others = cluster.filter((r) => r !== keep);

    // Everyone else who received it goes on the Cc list; the keeper's own
    // sender/receiver don't belong there.
    const exclude = new Set([String(keep.senderId), String(keep.receiverId)]);
    const ccSet = new Set<string>();
    for (const id of [
      ...(keep.ccIds ?? []),
      ...others.flatMap((o) => [o.receiverId, ...(o.ccIds ?? [])]),
    ]) {
      if (!exclude.has(String(id))) ccSet.add(String(id));
    }
    // Who had already read it: the keeper's Cc readers, each other copy's
    // recipient if that copy was read, and anyone those copies had as readers.
    const readSet = new Set<string>(
      [
        ...(keep.ccReadBy ?? []),
        ...others.filter((o) => o.isRead).map((o) => o.receiverId),
        ...others.flatMap((o) => o.ccReadBy ?? []),
      ]
        .map(String)
        .filter((id) => ccSet.has(id)),
    );

    console.log(
      `${EXECUTE ? "MERGE" : "WOULD MERGE"}  ${label}\n` +
        `      ${cluster.length} rows -> 1 · to ${name(keep.receiverId)} + ${ccSet.size} on Cc ` +
        `(${[...ccSet].map(name).join(", ")}) · ${readSet.size} of them already read\n`,
    );

    if (EXECUTE) {
      backup.push(
        ...(await EmailLog.find({ _id: { $in: others.map((o) => o._id) } }).lean()),
      );
    }
    merged++;
    removed += others.length;

    if (EXECUTE) {
      await EmailLog.updateOne(
        { _id: keep._id },
        {
          $set: {
            ccIds: [...ccSet].map((id) => new mongoose.Types.ObjectId(id)),
            ccReadBy: [...readSet].map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
      );
    }
  }

  if (EXECUTE && backup.length) {
    const dir = path.resolve(process.cwd(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `email-merge-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`Backup of the ${backup.length} removed row(s): ${file}`);

    await EmailLog.deleteMany({
      _id: {
        $in: backup.map((b) => (b as { _id: mongoose.Types.ObjectId })._id),
      },
    });
  }

  console.log(
    `\n${EXECUTE ? "Done" : "Dry run"}: ${merged} group email(s), ${removed} duplicate row(s) ${EXECUTE ? "removed" : "would be removed"}.`,
  );
  if (!EXECUTE && merged) console.log("Re-run with --execute to apply.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());