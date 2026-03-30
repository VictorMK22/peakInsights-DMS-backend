import dotenv from "dotenv";
import { DocumentModel } from "../src/models/Document";
import mongoose from "mongoose";

dotenv.config();

async function fixFileKeys() {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI missing");
    }
  
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to DB");
  
    const docs = await DocumentModel.find({});
    console.log(`Scanning ${docs.length} documents...`);
  
    for (const doc of docs) {
      let modified = false;
  
      doc.versionHistory = doc.versionHistory
        .map((v) => {
          let fileKey = v.fileKey;
          let fileUrl = v.fileUrl;
          let fileType = v.fileType;
  
          // 🧠 Try to recover missing fileKey
          if (!fileKey && fileUrl) {
            const extracted = fileUrl.split("/").pop();
            if (extracted) {
              fileKey = extracted;
              modified = true;
            }
          }
  
          // ❌ If still broken → skip this version
          if (!fileKey || !fileUrl || !fileType) {
            console.warn(
              `⚠️ Skipping corrupt version in doc ${doc._id}`
            );
            return null;
          }
  
          return {
            ...v,
            fileKey,
            fileUrl,
            fileType,
          };
        })
        .filter(Boolean) as any; // remove nulls
  
      // ❗ If ALL versions were bad → skip document
      if (doc.versionHistory.length === 0) {
        console.warn(`❌ Document ${doc._id} has NO valid versions → skipping`);
        continue;
      }
  
      if (modified) {
        await doc.save();
        console.log(`✅ Fixed document ${doc._id}`);
      }
    }

    for (const doc of docs) {
        if (doc.versionHistory.length === 0) {
          await doc.deleteOne();
          console.log(`🗑️ Deleted corrupt document ${doc._id}`);
        }
    }
  
    console.log("🎉 Migration complete");
    process.exit(0);
}
  
fixFileKeys().catch((err) => {
    console.error(err);
    process.exit(1);
});

