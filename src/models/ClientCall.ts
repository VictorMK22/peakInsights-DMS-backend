import mongoose, { Schema, Document } from "mongoose";

export interface IClientCall extends Document {
  clientId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId; // who logged the call
  direction: "outbound" | "inbound";
  calledAt: Date;
  durationMinutes?: number;
  summary: string;
  createdAt: Date;
  updatedAt: Date;
}

const ClientCallSchema = new Schema<IClientCall>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    direction: { type: String, enum: ["outbound", "inbound"], required: true },
    calledAt: { type: Date, required: true },
    durationMinutes: { type: Number, min: 0 },
    summary: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

ClientCallSchema.index({ clientId: 1, calledAt: -1 });

export const ClientCallModel = mongoose.model<IClientCall>(
  "ClientCall",
  ClientCallSchema,
);
