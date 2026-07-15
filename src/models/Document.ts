import mongoose, { Document, Schema } from "mongoose";
import { DocumentStatus, DocumentPriority } from "../types";

export interface IDocument extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  fileType: string;
  indexedAt: Date;
  contentText: string;
  // No versioning — a document has exactly one current file, which a
  // new upload replaces in place. Nothing is kept of the old file.
  fileName: string;
  fileKey: string;
  fileUrl: string;
  fileSize: number;
  modifiedBy: mongoose.Types.ObjectId;
  modifiedAt: Date;
  documentType: "working" | "storage" | "learning";
  // Learning-library category — only meaningful when documentType is
  // "learning"; optional so existing/uncategorized materials keep working.
  categoryId?: mongoose.Types.ObjectId;
  status: DocumentStatus;
  priority: DocumentPriority;
  ownerId: mongoose.Types.ObjectId;
  folderId: mongoose.Types.ObjectId;
  departmentId?: string;
  supervisorId?: mongoose.Types.ObjectId;
  targetCompletionTime?: Date;
  startTime?: Date;
  endTime?: Date;
  tatMinutes?: number;
  targetTatMinutes?: number;
  efficiencyRatio?: number;
  completionRequestedAt?: Date;
  completionRequestedBy?: mongoose.Types.ObjectId;
  supervisorApprovedBy?: mongoose.Types.ObjectId;
  supervisorApprovedAt?: Date;
  accessControlList: mongoose.Types.ObjectId[];
  tags: string[];
  metadata: Record<string, unknown>;
  // ── Drive-like trash & starring ──────────────────────────────────
  // Soft-delete: "deleting" a document moves it to Trash rather than
  // erasing it immediately. The physical file stays on disk until the
  // document is permanently deleted (from Trash) or trash is emptied.
  // isDeleted/deletedAt mirror the same fields on Folder.
  isDeleted: boolean;
  deletedAt?: Date | null;
  // Who trashed it — a supervisor/CEO can trash a subordinate's
  // document, so this isn't always the owner.
  deletedBy?: mongoose.Types.ObjectId;
  isStarred: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DocumentSchema = new Schema<IDocument>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    fileType: { type: String, required: true },
    contentText: { type: String },
    indexedAt: { type: Date },

    documentType: {
      type: String,
      enum: ["working", "storage", "learning"],
      default: "working",
    },
    categoryId: { type: Schema.Types.ObjectId, ref: "LearningCategory" },

    fileName: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileSize: { type: Number, required: true },
    modifiedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    modifiedAt: { type: Date, default: Date.now },

    status: {
      type: String,
      enum: [
        "draft",
        "in_progress",
        "pending_completion",
        "completed",
        "archived",
      ],
      default: "draft",
    },

    completionRequestedAt: { type: Date },
    completionRequestedBy: { type: Schema.Types.ObjectId, ref: "User" },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },

    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    folderId: { type: Schema.Types.ObjectId, ref: "Folder", index: true },
    departmentId: { type: String },
    supervisorId: { type: Schema.Types.ObjectId, ref: "User" },

    targetCompletionTime: { type: Date },
    startTime: { type: Date },
    endTime: { type: Date },

    tatMinutes: { type: Number },
    targetTatMinutes: { type: Number },
    efficiencyRatio: { type: Number },

    supervisorApprovedBy: { type: Schema.Types.ObjectId, ref: "User" },
    supervisorApprovedAt: { type: Date },

    accessControlList: [{ type: Schema.Types.ObjectId, ref: "User" }],
    tags: [{ type: String }],
    metadata: { type: Schema.Types.Mixed, default: {} },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
    isStarred: { type: Boolean, default: false },
  },
  { timestamps: true },
);

DocumentSchema.index({ folderId: 1, createdAt: -1 });
DocumentSchema.index({ ownerId: 1, status: 1 });
DocumentSchema.index({ ownerId: 1, documentType: 1, createdAt: -1 });
DocumentSchema.index({ supervisorId: 1, documentType: 1, createdAt: -1 });
DocumentSchema.index({ documentType: 1, createdAt: -1 });
DocumentSchema.index({ documentType: 1, categoryId: 1, createdAt: -1 });
DocumentSchema.index({ accessControlList: 1 });
DocumentSchema.index({ ownerId: 1, isDeleted: 1, deletedAt: -1 });
DocumentSchema.index({ ownerId: 1, isStarred: 1 });
DocumentSchema.index(
  { title: "text", description: "text", contentText: "text", tags: "text" },
  {
    weights: { title: 5, tags: 4, description: 2, contentText: 1 },
    name: "DocumentTextIndex",
  },
);

export const DocumentModel = mongoose.model<IDocument>(
  "Document",
  DocumentSchema,
);
