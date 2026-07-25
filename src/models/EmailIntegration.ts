import mongoose, { Schema, Document } from "mongoose";
import { encryptToken, decryptToken } from "../utils/tokenCrypto";

export type MailProvider = "zoho"; // extend later: "google" | "microsoft"

export interface IEmailIntegration extends Document {
  userId: mongoose.Types.ObjectId;
  provider: MailProvider;
  emailAddress: string;
  providerAccountId: string; // Zoho's internal "accountId" — needed for every API call
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
  status: "connected" | "error" | "disconnected";
  lastError?: string;
  lastSyncedAt?: Date; // watermark — only messages newer than this are fetched
  createdAt: Date;
  updatedAt: Date;
}

const EmailIntegrationSchema = new Schema<IEmailIntegration>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one connected mailbox per staff member, for now
    },
    provider: { type: String, enum: ["zoho"], default: "zoho" },
    emailAddress: { type: String, required: true, trim: true, lowercase: true },
    providerAccountId: { type: String, required: true },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["connected", "error", "disconnected"],
      default: "connected",
    },
    lastError: { type: String },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true },
);

export const EmailIntegrationModel = mongoose.model<IEmailIntegration>(
  "EmailIntegration",
  EmailIntegrationSchema,
);

// ── Token helpers ──────────────────────────────────────────────
// Plain functions rather than schema methods, so there's no ambiguity
// around `this` typing under strict mode — just pass the document in.

export function getAccessToken(integration: IEmailIntegration): string {
  return decryptToken(integration.encryptedAccessToken);
}

export function getRefreshToken(integration: IEmailIntegration): string {
  return decryptToken(integration.encryptedRefreshToken);
}

export function setTokens(
  integration: IEmailIntegration,
  access: string,
  refresh: string,
  expiresInSeconds: number,
): void {
  integration.encryptedAccessToken = encryptToken(access);
  integration.encryptedRefreshToken = encryptToken(refresh);
  integration.tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
}
