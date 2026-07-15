import mongoose, { Schema, Document } from "mongoose";

// ── Sales pipeline ───────────────────────────────────────────────
// A client moves through this pipeline once a sales person / BD
// (Business Development Officer) is working the deal. Existing
// non-sales clients simply leave salesStage unset.
export const SALES_STAGES = [
  "in_discussion",
  "proposal_sent",
  "awaiting_decision",
  "agreement_sent",
  "won",
  "lost",
] as const;
export type SalesStage = (typeof SALES_STAGES)[number];

export interface ISalesStageEntry {
  stage: SalesStage;
  note?: string;
  changedBy: mongoose.Types.ObjectId;
  changedAt: Date;
}

export interface IClient extends Document {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  industry?: string;
  address?: string;
  notes?: string;
  createdBy: mongoose.Types.ObjectId;
  assignedTo: mongoose.Types.ObjectId[];
  assignedAt?: Date;
  // Sales pipeline — set when the client was created/is being worked
  // by a sales person (BD). Undefined for clients outside the pipeline.
  // Once a client is assigned to a regular user to serve, the deal is
  // already won and the pipeline stage is no longer relevant to them —
  // it stays visible only to the CEO and sales persons (see controller).
  isSalesLead: boolean;
  salesStage?: SalesStage;
  salesStageHistory: ISalesStageEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const SalesStageEntrySchema = new Schema<ISalesStageEntry>(
  {
    stage: { type: String, enum: SALES_STAGES, required: true },
    note: { type: String, trim: true },
    changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ClientSchema = new Schema<IClient>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    company: { type: String, trim: true },
    industry: { type: String, trim: true },
    address: { type: String, trim: true },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedTo: [{ type: Schema.Types.ObjectId, ref: "User" }],
    assignedAt: { type: Date },
    isSalesLead: { type: Boolean, default: false },
    salesStage: { type: String, enum: SALES_STAGES },
    salesStageHistory: { type: [SalesStageEntrySchema], default: [] },
  },
  { timestamps: true },
);

ClientSchema.index({ createdBy: 1 });
ClientSchema.index({ assignedTo: 1 });
ClientSchema.index({ isSalesLead: 1, salesStage: 1 });
ClientSchema.index({ name: "text", company: "text", email: "text" });

export const ClientModel = mongoose.model<IClient>("Client", ClientSchema);
