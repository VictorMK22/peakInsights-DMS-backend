import crypto from "crypto";
import mongoose from "mongoose";

/**
 * Signed token inside the "pick one of these times instead" links emailed
 * when a host declines a booking request but offers alternatives.
 *
 * It says only: "the holder was sent the offer attached to request <id>".
 * Which times were offered, whether the offer has expired, whether it has
 * already been used, and whose email it is for are all read from the LIVE
 * request at the moment the link is used (see services/bookingService.ts),
 * so a token can't be stretched beyond what the host actually offered, and
 * it dies the moment the offer is used or runs out.
 *
 * An HMAC of the request id, keyed from JWT_SECRET with its own suffix so
 * it can never be replayed as a login JWT, an RSVP token, etc. Nothing is
 * stored for it.
 */

// Read at call time, not import time (dotenv runs after imports evaluate).
const getKey = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return `${secret}:booking-offer`;
};

const sign = (requestId: string): string =>
  crypto.createHmac("sha256", getKey()).update(requestId).digest("base64url");

export const createOfferToken = (requestId: string): string =>
  `${requestId}.${sign(requestId)}`;

/** The request id inside a genuine token, or null for anything else. */
export const verifyOfferToken = (token: unknown): string | null => {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [requestId, sig] = parts;
  if (!mongoose.isValidObjectId(requestId)) return null;

  const expected = Buffer.from(sign(requestId));
  const given = Buffer.from(sig);
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? requestId : null;
};