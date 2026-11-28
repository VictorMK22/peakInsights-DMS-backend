// A client can have several email addresses — the main one (Client.email, with
// Client.emailLabel) plus any number of labelled extras (CEO, Manager, HR…).
// Everything that needs "all the addresses we hold for this client" goes
// through here so the rules stay in one place.

export interface ClientEmailEntry {
  label: string;
  email: string;
}

export interface ClientAddress extends ClientEmailEntry {
  primary: boolean;
}

export const MAX_ADDITIONAL_CLIENT_EMAILS = 10;
const MAX_LABEL = 40;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export const isValidEmail = (v: string): boolean => EMAIL_RE.test(v);

/** additionalEmails can arrive as an array or a JSON string (multipart/import). */
const toArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

/**
 * Cleans the extra addresses submitted from the client form: trims, lowercases,
 * drops blank rows and duplicates (also against the main address). Returns an
 * error message instead of throwing so the controller can answer 400.
 */
export function normalizeAdditionalEmails(
  input: unknown,
  primaryEmail?: string | null,
): { value: ClientEmailEntry[]; error?: string } {
  const seen = new Set<string>();
  if (primaryEmail?.trim()) seen.add(primaryEmail.trim().toLowerCase());
  const value: ClientEmailEntry[] = [];

  for (const raw of toArray(input)) {
    const row = (raw ?? {}) as { label?: unknown; email?: unknown };
    const email = String(row.email ?? "").trim().toLowerCase();
    if (!email) continue; // a row left blank in the form
    if (!isValidEmail(email))
      return { value: [], error: `"${email}" is not a valid email address` };
    if (seen.has(email)) continue;
    seen.add(email);
    value.push({
      label: String(row.label ?? "").trim().slice(0, MAX_LABEL) || "Other",
      email,
    });
  }
  if (value.length > MAX_ADDITIONAL_CLIENT_EMAILS)
    return {
      value: [],
      error: `A client can have at most ${MAX_ADDITIONAL_CLIENT_EMAILS} extra email addresses`,
    };
  return { value };
}

/** Every address held for a client, main one first. */
export function allClientAddresses(c: {
  email?: string | null;
  emailLabel?: string | null;
  additionalEmails?: ClientEmailEntry[] | null;
}): ClientAddress[] {
  const out: ClientAddress[] = [];
  if (c.email?.trim())
    out.push({
      label: c.emailLabel?.trim() || "Main",
      email: c.email.trim().toLowerCase(),
      primary: true,
    });
  for (const a of c.additionalEmails ?? [])
    if (a?.email)
      out.push({ label: a.label || "Other", email: a.email.toLowerCase(), primary: false });
  return out;
}