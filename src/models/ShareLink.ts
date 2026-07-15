import mongoose, { Document, Schema } from "mongoose";

export interface IShareLink extends Document {
  documentId: mongoose.Types.ObjectId;
  token: string;
  createdBy: mongoose.Types.ObjectId;
  expiresAt: Date; // always set — share links are never permanent
  revokedAt?: Date;
  accessCount: number;
  lastAccessedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ShareLinkSchema = new Schema<IShareLink>(
  {
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    token: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date },
  },
  { timestamps: true },
);

export const ShareLink = mongoose.model<IShareLink>(
  "ShareLink",
  ShareLinkSchema,
);
