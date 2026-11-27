import mongoose, { Document, Schema } from "mongoose";

/**
 * Tiny key/value store for company-wide switches that an admin can flip at
 * runtime (no redeploy). One row per key; `value` is whatever that key needs.
 *
 * Keys in use:
 *   "documentDeletion" -> { userDeleteEnabled: boolean }
 */
export interface IAppSetting extends Document {
  key: string;
  value: Record<string, unknown>;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const AppSettingSchema = new Schema<IAppSetting>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export const AppSettingModel = mongoose.model<IAppSetting>(
  "AppSetting",
  AppSettingSchema,
);