import mongoose, { Schema, Document } from "mongoose";

export interface IFolder extends Document {
  name: string;
  parentFolderId?: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  path: string;
  accessControlList: mongoose.Types.ObjectId[];
  // Which tab a folder belongs to (Working / Stored / Learning) — mirrors
  // Document.documentType. Root folders get this set explicitly at
  // creation time (from whichever tab the user was on); subfolders
  // always inherit it from their parent, so a folder can never mix
  // content from two tabs. Optional only for backward-compatibility
  // with folders created before this field existed — those get
  // self-healed (inferred + persisted) the first time they're read,
  // see resolveFolderType() in folderController.
  documentType?: "working" | "storage" | "learning";
  // ── Drive-like trash & starring — mirrors Document's fields. ──────
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId;
  isStarred: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FolderSchema = new Schema<IFolder>(
  {
    name: {
      type: String,
      required: true,
    },

    parentFolderId: {
      type: Schema.Types.ObjectId,
      ref: "Folder",
      default: null,
    },

    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    path: {
      type: String,
      required: true,
      index: true,
    },

    accessControlList: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    documentType: {
      type: String,
      enum: ["working", "storage", "learning"],
      default: undefined,
    },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
    isStarred: { type: Boolean, default: false },
  },

  { timestamps: true },
);

FolderSchema.index({ ownerId: 1, path: 1 }, { unique: true });
FolderSchema.index({ ownerId: 1, parentFolderId: 1 });
FolderSchema.index({ ownerId: 1, parentFolderId: 1, documentType: 1 });
FolderSchema.index({ ownerId: 1, isDeleted: 1, deletedAt: -1 });
FolderSchema.index({ ownerId: 1, isStarred: 1 });

export const FolderModel = mongoose.model<IFolder>("Folder", FolderSchema);
