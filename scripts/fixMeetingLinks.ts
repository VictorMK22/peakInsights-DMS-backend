// Run once: npx ts-node scripts/fixMeetingLinks.ts
// Adds https:// to already-saved meeting links that have no scheme.
import "dotenv/config";
import mongoose from "mongoose";
import { MeetingModel } from "../src/models/Meeting";

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Check your backend .env file.");
  }
  await mongoose.connect(uri);
  const docs = await MeetingModel.find({
    meetingLink: { $exists: true, $nin: [null, ""], $not: /^[a-z][a-z0-9+.-]*:/i },
  }).select("_id meetingLink");
  for (const d of docs) {
    const fixed = `https://${String(d.meetingLink).replace(/^\/+/, "")}`;
    await MeetingModel.updateOne({ _id: d._id }, { $set: { meetingLink: fixed } });
    console.log(d._id.toString(), d.meetingLink, "->", fixed);
  }
  console.log(`Fixed ${docs.length} meeting(s)`);
  await mongoose.disconnect();
})();