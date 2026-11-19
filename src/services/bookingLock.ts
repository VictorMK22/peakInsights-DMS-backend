import crypto from "crypto";
import mongoose, { Schema } from "mongoose";

/**
 * A tiny mutex stored in MongoDB, used so two people booking the same
 * owner at the same instant are handled one after the other: the second
 * re-checks availability only after the first's meeting exists, so they
 * see it and get a clean "slot taken" instead of both succeeding.
 *
 * It has to live in the database (not in memory) because the app runs as
 * several serverless instances at once, and the unique index on `key` is
 * what makes "who holds it" a single atomic decision.
 *
 * Leases expire (`expiresAt`), so a function that dies mid-booking can't
 * block that owner's bookings for long: the next caller steals a lock
 * whose lease has run out. Each lock carries a random `holder` token so
 * a slow holder whose lease was stolen never releases someone else's lock.
 */

interface IBookingLock {
  key: string;
  holder: string;
  expiresAt: Date;
}

const BookingLockSchema = new Schema<IBookingLock>({
  key: { type: String, required: true, unique: true },
  holder: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

export const BookingLockModel = mongoose.model<IBookingLock>(
  "BookingLock",
  BookingLockSchema,
);

/** Thrown when the lock couldn't be obtained in time. */
export class BookingLockTimeout extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` while holding the lock named `key`. Keep `fn` to quick
 * database work — other bookings for the same key wait for it.
 */
export async function withBookingLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { leaseMs?: number; waitMs?: number } = {},
): Promise<T> {
  const leaseMs = opts.leaseMs ?? 15_000;
  const waitMs = opts.waitMs ?? 8_000;
  const holder = crypto.randomBytes(8).toString("hex");

  // Make sure the unique index exists before relying on it (it is built
  // asynchronously after the model is first registered).
  await BookingLockModel.init();

  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await BookingLockModel.create({
        key,
        holder,
        expiresAt: new Date(Date.now() + leaseMs),
      });
      break;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      // Held by someone else. If their lease has run out, clear it and
      // try again straight away; otherwise wait a moment.
      const cleared = await BookingLockModel.deleteOne({
        key,
        expiresAt: { $lt: new Date() },
      });
      if (cleared.deletedCount > 0) continue;
      if (Date.now() >= deadline) {
        throw new BookingLockTimeout(`Timed out waiting for lock ${key}`);
      }
      await sleep(30 + Math.random() * 70);
    }
  }

  try {
    return await fn();
  } finally {
    await BookingLockModel.deleteOne({ key, holder }).catch((err) =>
      console.error("Releasing booking lock failed:", err),
    );
  }
}
