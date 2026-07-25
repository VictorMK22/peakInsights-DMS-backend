import mongoose, { Schema, Document } from "mongoose";

export type ClientInvoiceStatus = "unpaid" | "paid" | "overdue" | "cancelled";

export interface IClientInvoice extends Document {
  clientId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId;
  invoiceNumber?: string;
  amount: number;
  currency: string; // e.g. "USD", "KES"
  status: ClientInvoiceStatus;
  issuedAt: Date;
  dueDate?: Date;
  paidAt?: Date;
  notes?: string;
  // Optional attached invoice document (PDF/image) — same disk-storage +
  // signed-URL pattern used for client email attachments.
  file?: {
    filename: string;
    fileKey: string;
    size: number;
    mimeType: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const ClientInvoiceSchema = new Schema<IClientInvoice>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    invoiceNumber: { type: String, trim: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "USD", trim: true },
    status: {
      type: String,
      enum: ["unpaid", "paid", "overdue", "cancelled"],
      default: "unpaid",
    },
    issuedAt: { type: Date, default: Date.now },
    dueDate: { type: Date },
    paidAt: { type: Date },
    notes: { type: String },
    file: {
      filename: { type: String },
      fileKey: { type: String },
      size: { type: Number },
      mimeType: { type: String },
    },
  },
  { timestamps: true },
);

ClientInvoiceSchema.index({ clientId: 1, issuedAt: -1 });
ClientInvoiceSchema.index({ clientId: 1, status: 1 });

export const ClientInvoiceModel = mongoose.model<IClientInvoice>(
  "ClientInvoice",
  ClientInvoiceSchema,
);
