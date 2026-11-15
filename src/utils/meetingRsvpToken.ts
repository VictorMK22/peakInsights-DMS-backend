import crypto from "crypto";
import mongoose from "mongoose";

/**
 * Signed tokens for answering a meeting invitation straight from the
 * invitation email — no login needed, which is what makes it work for
 * external (email-only) invitees too.
 *
 * A token says exactly one thing: "the holder is <attendee> of <meeting>",
 * where the attendee is either a system user (by id) or an external
 * invitee (by email address). It is an HMAC over that payload, derived
 * from JWT_SECRET with its own suffix so it can never be mistaken for —
 * or replayed as — a login JWT, a file-access token, etc.
 *
 * Deliberately stateless and with no embedded expiry:
 *   - Nothing is stored, so there is nothing to clean up or migrate.
 *   - Validity is decided against the LIVE meeting at the moment the
 *     token is used (see services/meetingRsvpService.ts): the invitee
 *     must still be on the list, and the meeting must still be
 *     scheduled and not yet over. So a link stops working when the
 *     meeting ends, is cancelled, or the person is removed — and an
 *     old email's link keeps working after a reschedule instead of
 *     dying with the old time.
 *   - Worst case for a forwarded/leaked link: someone can set ONE
 *     person's RSVP for ONE meeting until it ends. It grants no read
 *     access beyond the meeting summary the invitee already received.
 */

export type RsvpTokenActor =
  | { kind: "user"; userId: string }
  | { kind: "external"; email: string };

export interface RsvpTokenPayload {
  meetingId: string;
  actor: RsvpTokenActor;
}

// Wire format (short keys keep the emailed URL compact):
//   { v: 1, m: <meetingId>, t: "u" | "e", i: <userId | lowercased email> }
interface WirePayload {
  v: 1;
  m: string;
  t: "u" | "e";
  i: string;
}

// Read at call time, not import time: dotenv.config() runs in app.ts
// *after* its imports are evaluated, so a module-level read would miss a
// secret that only lives in .env. No dev fallback either — a guessable
// signing key would let anyone forge RSVP links.
const getKey = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return `${secret}:meeting-rsvp`;
};

const b64url = (buf: Buffer): string => buf.toString("base64url");

const sign = (body: string): string =>
  b64url(crypto.createHmac("sha256", getKey()).update(body).digest());

export const createRsvpToken = (
  meetingId: string,
  actor: RsvpTokenActor,
): string => {
  const wire: WirePayload =
    actor.kind === "user"
      ? { v: 1, m: meetingId, t: "u", i: actor.userId }
      : { v: 1, m: meetingId, t: "e", i: actor.email.trim().toLowerCase() };
  const body = b64url(Buffer.from(JSON.stringify(wire), "utf8"));
  return `${body}.${sign(body)}`;
};

/** Returns the payload for a genuine token, or null for anything else. */
export const verifyRsvpToken = (token: unknown): RsvpTokenPayload | null => {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let wire: Partial<WirePayload>;
  try {
    wire = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    wire.v !== 1 ||
    typeof wire.m !== "string" ||
    typeof wire.i !== "string" ||
    !mongoose.isValidObjectId(wire.m)
  ) {
    return null;
  }
  if (wire.t === "u" && mongoose.isValidObjectId(wire.i)) {
    return { meetingId: wire.m, actor: { kind: "user", userId: wire.i } };
  }
  if (wire.t === "e" && wire.i.length > 0) {
    return { meetingId: wire.m, actor: { kind: "external", email: wire.i } };
  }
  return null;
};