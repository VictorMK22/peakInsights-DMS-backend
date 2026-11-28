/**
 * The name a client is shown under everywhere (notifications, emails,
 * audit lines…): the COMPANY name. `name` on a client is the contact
 * person, so it is only a fallback for clients that have no company.
 */
export const clientLabel = (c: {
  name?: string | null;
  company?: string | null;
}): string => c.company?.trim() || c.name?.trim() || "Client";