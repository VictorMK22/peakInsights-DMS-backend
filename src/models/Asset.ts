import mongoose, { Document, Schema } from "mongoose";

export type AssetType =
  | "laptop"
  | "desktop"
  | "printer"
  | "switch"
  | "router"
  | "firewall"
  | "license"
  | "software"
  | "accessory";
export type AssetStatus = "in_use" | "spare" | "maintenance" | "retired";

export interface IAsset extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  type: AssetType;
  owner?: mongoose.Types.ObjectId;
  department?: string;
  status: AssetStatus;
  purchaseDate?: Date;
  warrantyExpiry?: Date;
  maintenanceHistory: { note: string; at: Date; by: mongoose.Types.ObjectId }[];
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const AssetSchema = new Schema<IAsset>(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["laptop", "desktop", "printer", "switch", "router", "firewall", "license", "software", "accessory"],
      required: true,
    },
    owner: { type: Schema.Types.ObjectId, ref: "User" },
    department: { type: String, trim: true },
    status: {
      type: String,
      enum: ["in_use", "spare", "maintenance", "retired"],
      default: "spare",
    },
    purchaseDate: { type: Date },
    warrantyExpiry: { type: Date },
    maintenanceHistory: [
      {
        note: { type: String, required: true },
        at: { type: Date, default: Date.now },
        by: { type: Schema.Types.ObjectId, ref: "User", required: true },
      },
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

AssetSchema.index({ status: 1 });
AssetSchema.index({ type: 1 });

export const Asset = mongoose.model<IAsset>("Asset", AssetSchema);
