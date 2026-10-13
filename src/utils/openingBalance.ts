/**
 * Validation for a client's opening balance — the amount (in KES) brought
 * forward when the client is added to the system.
 *
 * Sign convention: positive = the client owes us, negative = the client is
 * in credit, 0 = nothing brought forward. Zero is valid, but it must be
 * stated explicitly: "missing" is rejected so nobody skips it by accident.
 */

export const MAX_OPENING_BALANCE = 1_000_000_000_000;
/** All opening balances are in Kenya Shillings — there is no currency field. */
export const OPENING_BALANCE_CURRENCY = "KES";

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseOpeningBalance(raw: unknown): Parsed<number> {
  if (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "")
  ) {
    return {
      ok: false,
      message: "Opening balance is required (enter 0 if there is none)",
    };
  }

  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
    n = Number(raw.trim());
  } else {
    return { ok: false, message: "Opening balance must be a number" };
  }

  if (!Number.isFinite(n) || Math.abs(n) > MAX_OPENING_BALANCE) {
    return { ok: false, message: "Opening balance is out of range" };
  }

  const rounded = Math.round(n * 100) / 100;
  return { ok: true, value: rounded === 0 ? 0 : rounded }; // normalise -0
}
