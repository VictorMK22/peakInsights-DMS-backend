import mongoose from "mongoose";

const YDocSchema = new mongoose.Schema({
  docId: { type: String, required: true, unique: true },
  data: { type: Buffer, required: true },
}, { timestamps: true });

export default mongoose.model("YDoc", YDocSchema);