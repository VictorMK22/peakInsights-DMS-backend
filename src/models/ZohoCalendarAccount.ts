import mongoose, { Schema, Document } from "mongoose";
import { encryptToken, decryptToken } from "../utils/tokenCrypto";

// ═════════════════════════════════════════════════════════════════
// One connected Zoho Calendar account per staff member. Used to:
//   - put every meeting they organize on their Zoho Calendar (with a
//     Zoho Meeting link when they ask for one),
//   - mirror their "Mark Unavailable" blocks there,
//   - read their existing events for conflict checks and the in-app
//     calendar view.
// Kept separate from the Zoho *Mail* integration (EmailIntegration):
// different scopes, and a staff member can use either independently.
// ═════════════════════════════════════════════════════════════════

export interface IZohoCalendarAccount extends Document {
  userId: mongoose.Types.ObjectId;
  zohoEmail: string;
  /** UID of the user's default calendar — every API call needs it. */
  calendarUid: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
  status: "connected" | "error" | "disconnected";
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ZohoCalendarAccountSchema = new Schema<IZohoCalendarAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one connected Zoho Calendar per staff member
    },
    zohoEmail: { type: String, required: true, trim: true, lowercase: true },
    calendarUid: { type: String, required: true },
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

export const ZohoCalendarAccountModel = mongoose.model<IZohoCalendarAccount>(
  "ZohoCalendarAccount",
  ZohoCalendarAccountSchema,
);

export function getAccessToken(account: IZohoCalendarAccount): string {
  return decryptToken(account.encryptedAccessToken);
}

export function getRefreshToken(account: IZohoCalendarAccount): string {
  return decryptToken(account.encryptedRefreshToken);
}

export function setTokens(
  account: IZohoCalendarAccount,
  access: string,
  refresh: string | undefined,
  expiresInSeconds: number,
): void {
  account.encryptedAccessToken = encryptToken(access);
  // Zoho only returns a refresh token on consent, not on refresh —
  // never overwrite a good one with nothing.
  if (refresh) account.encryptedRefreshToken = encryptToken(refresh);
  account.tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
}