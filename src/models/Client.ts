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

// A staff member who used to serve this client and was later deactivated or
// deleted. Kept so the CEO can see who the client was with before.
export interface IFormerAssignee {
  userId: mongoose.Types.ObjectId;
  name: string;
  role?: string;
  releasedAt: Date;
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
  // When a lead is won it goes to the CEO, who allocates an accountant to
  // serve the client. The accountant is also added to assignedTo (so every
  // existing access rule just works); these fields record who/when and let
  // the CEO re-allocate later.
  wonAt?: Date;
  allocatedAccountant?: mongoose.Types.ObjectId;
  allocatedAt?: Date;
  allocatedBy?: mongoose.Types.ObjectId;
  // Set when the accountant serving this client left (deactivated/deleted) and
  // nobody else is serving them. The client lands in the CEO's allocation queue
  // until a new accountant is assigned; everything already recorded against the
  // client (emails, WhatsApp, notes, calls…) stays and is visible to whoever
  // is assigned next.
  needsReallocation?: boolean;
  releasedAt?: Date;
  formerAssignees?: IFormerAssignee[];
  // Monthly Management Accounts configuration. Every served client owes MAs
  // by the 15th of each month unless the CEO/supervisor exempts them.
  maRequired?: boolean; // default true; false = exempt / different frequency
  maStartPeriod?: string; // "YYYY-MM" — first reporting month the client owes
  maExemptReason?: string;
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

const FormerAssigneeSchema = new Schema<IFormerAssignee>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    role: { type: String },
    releasedAt: { type: Date, default: Date.now },
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
    wonAt: { type: Date },
    allocatedAccountant: { type: Schema.Types.ObjectId, ref: "User" },
    allocatedAt: { type: Date },
    allocatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    needsReallocation: { type: Boolean, default: false },
    releasedAt: { type: Date },
    formerAssignees: { type: [FormerAssigneeSchema], default: undefined },
    maRequired: { type: Boolean, default: true },
    maStartPeriod: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    maExemptReason: { type: String, trim: true },
  },
  { timestamps: true },
);

ClientSchema.index({ createdBy: 1 });
ClientSchema.index({ assignedTo: 1 });
ClientSchema.index({ isSalesLead: 1, salesStage: 1 });
ClientSchema.index({ salesStage: 1, allocatedAccountant: 1 });
ClientSchema.index({ needsReallocation: 1 });
ClientSchema.index({ name: "text", company: "text", email: "text" });

export const ClientModel = mongoose.model<IClient>("Client", ClientSchema);