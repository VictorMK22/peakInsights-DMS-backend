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
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

LearningCategorySchema.index(
  { name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } },
);
LearningCategorySchema.index({ order: 1, name: 1 });

export const LearningCategoryModel = mongoose.model<ILearningCategory>(
  "LearningCategory",
  LearningCategorySchema,
);
