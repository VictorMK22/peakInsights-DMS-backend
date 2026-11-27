import mongoose, { Document, Schema } from "mongoose";

/**
 * One row per presigned direct-to-S3 upload we hand out (see
 * services/documentDirectUpload.ts). If the browser uploads a file but never
 * finishes creating the document (tab closed, validation error, network drop),
 * nothing references the S3 object — this is the ledger the orphan sweep uses
 * to find and delete it.
 *
 *   claimedAt set   → a create/replace request took ownership of the key
 *   claimedAt null  → not yet claimed, or the request that claimed it failed
 */
export interface IPendingUpload extends Document {
  fileKey: string;
  userId: mongoose.Types.ObjectId;
  filename: string;
  createdAt: Date;
  claimedAt?: Date | null;
}

const PendingUploadSchema = new Schema<IPendingUpload>(
  {
    fileKey: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    filename: { type: String, required: true },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

PendingUploadSchema.index({ claimedAt: 1, createdAt: 1 });

export const PendingUpload = mongoose.model<IPendingUpload>(
  "PendingUpload",
  PendingUploadSchema,
);