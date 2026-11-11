import mongoose, { Document, Schema } from "mongoose";

export interface ILearningCategory extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  // Lucide icon name (e.g. "Rocket", "ShieldCheck") — kept as a plain
  // string rather than an enum so new icons don't need a backend
  // change; the frontend falls back to a default if unrecognized.
  icon?: string;
  color: string;
  order: number;
  isActive: boolean;
  // Which kind of document this category files: "working", "storage" or
  // "learning". Rows created before categories were extended to every
  // document type have no value and are treated as "learning".
  documentType: "working" | "storage" | "learning";
  // Set for a personal category (a user's own working/storage filing);
  // absent for a shared one created by the CEO / a supervisor.
  ownerId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const LearningCategorySchema = new Schema<ILearningCategory>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, maxlength: 500 },
    icon: { type: String, trim: true, default: "BookOpen" },
    color: { type: String, trim: true, default: "violet" },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    documentType: {
      type: String,
      enum: ["working", "storage", "learning"],
      default: "learning",
    },
    ownerId: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// Name uniqueness is enforced per (type, owner) in the controller rather than
// by a unique index: shared and personal categories of different types may
// legitimately share a name (e.g. "General"). The old global unique index on
// `name` must be dropped — see scripts/migrateDocumentCategories.ts.
LearningCategorySchema.index({ documentType: 1, ownerId: 1, order: 1, name: 1 });

export const LearningCategoryModel = mongoose.model<ILearningCategory>(
  "LearningCategory",
  LearningCategorySchema,
);