import mongoose from "mongoose";

const ShareLinkSchema = new mongoose.Schema({
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Document",
    required: true
  },
  token: { type: String, required: true, unique: true },
  isPublic: { type: Boolean, default: false },
  expiresAt: Date
}, { timestamps: true });

export const ShareLink = mongoose.model("ShareLink", ShareLinkSchema);