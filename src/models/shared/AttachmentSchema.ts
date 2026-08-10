import { Schema } from "mongoose";

// Shared shape for file attachments across Ticket/Asset/Deployment.
// `fileKey` is the S3 key returned by the existing upload middleware
// (see middleware/upload.ts) — the same pattern documents already
// use. We store the key, not a URL, because URLs are short-lived
// signed links (see utils/fileAccessToken.ts); a fresh one is built
// at read time in each controller's list/get handler instead.
export interface IAttachment {
  fileKey: string;
  filename: string;
  mimeType?: string;
  size?: number;
  uploadedBy: Schema.Types.ObjectId;
  uploadedAt: Date;
}

export const AttachmentSchema = new Schema<IAttachment>(
  {
    fileKey: { type: String, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String },
    size: { type: Number },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);
