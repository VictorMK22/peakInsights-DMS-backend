import mongoose, { Schema, Document } from "mongoose";

// Free-form extra information about a WON / EXISTING client, e.g. the
// client's iTax or eTIMS login. Kept in its own collection (not embedded in
// Client) so it can never leak through the many endpoints that return or
// populate a Client. Values flagged `isSecret` are stored AES-256-GCM
// encrypted (see utils/tokenCrypto.ts) and are only decrypted by the
// explicit reveal endpoint.
export interface IClientExtraField extends Document {
  clientId: mongoose.Types.ObjectId;
  label: string;
  /** Plain text, or an encrypted "iv:tag:cipher" payload when isSecret. */
  value: string;
  isSecret: boolean;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ClientExtraFieldSchema = new Schema<IClientExtraField>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    value: { type: String, required: true, maxlength: 4000 },
    isSecret: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

ClientExtraFieldSchema.index({ clientId: 1, createdAt: 1 });

export const ClientExtraFieldModel = mongoose.model<IClientExtraField>(
  "ClientExtraField",
  ClientExtraFieldSchema,
);