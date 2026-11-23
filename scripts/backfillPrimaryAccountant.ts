// Run once: npx ts-node scripts/backfillPrimaryAccountant.ts [--dry]
// Every won / existing client has ONE primary accountant (allocatedAccountant);
// other accountants on it are secondary. Existing clients added before that
// rule have accountants but no primary. This makes the first accountant on each
// one (else supervisor, else CEO) its primary. Clients with nobody serving them
// are left alone.
import "dotenv/config";
import mongoose from "mongoose";
import { ClientModel } from "../src/models/Client";
import { User } from "../src/models/User";

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Check your backend .env file.");
  const dry = process.argv.includes("--dry");
  await mongoose.connect(uri);

  const clients = await ClientModel.find({
    allocatedAccountant: { $exists: false },
    assignedTo: { $exists: true, $not: { $size: 0 } },
    $or: [{ isSalesLead: { $ne: true } }, { salesStage: "won" }],
  })
    .select("_id name assignedTo assignedAt")
    .lean();

  // Look the roles up directly (no populate), so this script doesn't depend on
  // the User model having been registered by the app.
  const everyone = [
    ...new Set(clients.flatMap((c) => c.assignedTo.map((id) => String(id)))),
  ];
  const roleOf = new Map(
    (await User.find({ _id: { $in: everyone } }).select("role").lean()).map(
      (u) => [String(u._id), u.role as string],
    ),
  );

  const rank: Record<string, number> = { accountant: 0, supervisor: 1, ceo: 2 };
  let updated = 0;
  for (const c of clients) {
    const serving = c.assignedTo
      .map((id) => ({ id, role: roleOf.get(String(id)) ?? "" }))
      .filter((u) => u.role in rank)
      .sort((a, b) => rank[a.role] - rank[b.role]);
    if (serving.length === 0) continue;
    console.log(`${dry ? "[dry] " : ""}${c._id} ${c.name} -> primary ${serving[0].id}`);
    if (!dry)
      await ClientModel.updateOne(
        { _id: c._id },
        {
          $set: {
            allocatedAccountant: serving[0].id,
            allocatedAt: c.assignedAt ?? new Date(),
          },
        },
      );
    updated++;
  }
  console.log(`${dry ? "Would update" : "Updated"} ${updated} client(s)`);
  await mongoose.disconnect();
})();