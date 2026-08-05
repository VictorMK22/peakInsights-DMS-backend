import mongoose, { Document, Schema } from "mongoose";

export type TicketStatus = "open" | "in_progress" | "escalated" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "critical";
export type TicketCategory = "hardware" | "software" | "network" | "access" | "other";

// SLA targets in hours, by priority — used to compute slaDueAt on create
// and to flag tickets at risk of breaching on the frontend.
export const SLA_HOURS: Record<TicketPriority, number> = {
  critical: 4,
  high: 8,
  medium: 24,
  low: 72,
};

export interface ITicket extends Document {
  _id: mongoose.Types.ObjectId;
  ticketNumber: string; // e.g. TCK-3041
  subject: string;
  description?: string;
  requester: mongoose.Types.ObjectId;
  department?: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignee?: mongoose.Types.ObjectId;
  slaDueAt: Date;
  resolvedAt?: Date;
  internalNotes: { note: string; by: mongoose.Types.ObjectId; at: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

const TicketSchema = new Schema<ITicket>(
  {
    ticketNumber: { type: String, required: true, unique: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    requester: { type: Schema.Types.ObjectId, ref: "User", required: true },
    department: { type: String, trim: true },
    category: {
      type: String,
      enum: ["hardware", "software", "network", "access", "other"],
      default: "other",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "escalated", "resolved", "closed"],
      default: "open",
    },
    assignee: { type: Schema.Types.ObjectId, ref: "User" },
    slaDueAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    internalNotes: [
      {
        note: { type: String, required: true },
        by: { type: Schema.Types.ObjectId, ref: "User", required: true },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

TicketSchema.index({ status: 1, priority: 1 });
TicketSchema.index({ assignee: 1, status: 1 });

export const Ticket = mongoose.model<ITicket>("Ticket", TicketSchema);
