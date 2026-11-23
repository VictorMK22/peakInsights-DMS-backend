// Run once: npx ts-node scripts/removeSalesFromWonClients.ts [--dry]
// Won / existing clients are served by accountants only. This takes sales
// people off won / existing clients that were saved before that rule, and
// leaves prospects (still in the pipeline) untouched.
import "dotenv/config";
import mongoose from "mongoose";
import { ClientModel } from "../src/models/Client";
import { User } from "../src/models/User";

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Check your backend .env file.");
  const dry = process.argv.includes("--dry");
  await mongoose.connect(uri);

  const salesIds = (await User.find({ role: "sales_person" }).select("_id").lean()).map(
    (u) => u._id,
  );
  // Not a prospect: an existing client (not a sales lead) or a won lead.
  const filter = {
    assignedTo: { $in: salesIds },
    $or: [{ isSalesLead: { $ne: true } }, { salesStage: "won" }],
  };
  const clients = await ClientModel.find(filter).select("_id name assignedTo").lean();
  for (const c of clients) {
    console.log(`${dry ? "[dry] " : ""}${c._id} ${c.name}`);
  }
  if (!dry && clients.length) {
    await ClientModel.updateMany(filter, { $pull: { assignedTo: { $in: salesIds } } });
  }
  console.log(`${dry ? "Would update" : "Updated"} ${clients.length} client(s)`);
  await mongoose.disconnect();
})();