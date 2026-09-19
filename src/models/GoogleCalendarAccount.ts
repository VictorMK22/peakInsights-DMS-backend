import mongoose, { Schema, Document } from "mongoose";
import { encryptToken, decryptToken } from "../utils/tokenCrypto";

// ═════════════════════════════════════════════════════════════════
// One connected Google account per staff member, used ONLY to create
// real Google Meet links (via a Calendar event with conferenceData)
// when they schedule a meeting. We never read the user's calendar or
// mailbox with this — see services/googleCalendarService.ts for the
// exact scope requested.
// ═════════════════════════════════════════════════════════════════

export interface IGoogleCalendarAccount extends Document {
  userId: mongoose.Types.ObjectId;
  googleEmail: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
  status: "connected" | "error" | "disconnected";
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GoogleCalendarAccountSchema = new Schema<IGoogleCalendarAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one connected Google account per staff member
    },
    googleEmail: { type: String, required: true, trim: true, lowercase: true },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["connected", "error", "disconnected"],
      default: "connected",
    },
    lastError: { type: String },
  },
  { timestamps: true },
);

export const GoogleCalendarAccountModel =
  mongoose.model<IGoogleCalendarAccount>(
    "GoogleCalendarAccount",
    GoogleCalendarAccountSchema,
  );

export function getAccessToken(account: IGoogleCalendarAccount): string {
  return decryptToken(account.encryptedAccessToken);
}

export function getRefreshToken(account: IGoogleCalendarAccount): string {
  return decryptToken(account.encryptedRefreshToken);
}

export function setTokens(
  account: IGoogleCalendarAccount,
  access: string,
  refresh: string | undefined,
  expiresInSeconds: number,
): void {
  account.encryptedAccessToken = encryptToken(access);
  // Google only returns a refresh_token on the very first consent
  // (prompt=consent forces it every time here — see buildGoogleAuthUrl —
  // but guard anyway rather than overwrite a good token with nothing).
  if (refresh) account.encryptedRefreshToken = encryptToken(refresh);
  account.tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
}
