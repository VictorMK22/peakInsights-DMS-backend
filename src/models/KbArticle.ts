import mongoose, { Document, Schema } from "mongoose";

export type KbCategory =
  | "sop"
  | "technical"
  | "user_guide"
  | "troubleshooting"
  | "architecture"
  | "api";

export interface IKbArticleVersion {
  body: string;
  editedBy: mongoose.Types.ObjectId;
  editedAt: Date;
}

export interface IKbArticle extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  body: string;
  category: KbCategory;
  author: mongoose.Types.ObjectId;
  views: number;
  versions: IKbArticleVersion[];
  createdAt: Date;
  updatedAt: Date;
}

const KbArticleSchema = new Schema<IKbArticle>(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    category: {
      type: String,
      enum: [
        "sop",
        "technical",
        "user_guide",
        "troubleshooting",
        "architecture",
        "api",
      ],
      default: "technical",
    },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    views: { type: Number, default: 0 },
    // Snapshot of the *previous* body pushed on each edit that
    // actually changes it (see updateKbArticle) — so this array is
    // "history before now", not including the current live body.
    versions: [
      {
        body: { type: String, required: true },
        editedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        editedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

KbArticleSchema.index({ title: "text", body: "text" });
KbArticleSchema.index({ category: 1 });

export const KbArticle = mongoose.model<IKbArticle>(
  "KbArticle",
  KbArticleSchema,
);
