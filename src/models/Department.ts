import mongoose, { Document, Schema } from "mongoose";

export interface IDepartment extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DepartmentSchema = new Schema<IDepartment>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

DepartmentSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } },
);

export const Department = mongoose.model<IDepartment>(
  "Department",
  DepartmentSchema,
);
