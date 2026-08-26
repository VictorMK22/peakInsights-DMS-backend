import axios from "axios";
import crypto from "crypto";

// ═════════════════════════════════════════════════════════════════
// WHATSAPP BUSINESS CLOUD API (Meta)
// ═════════════════════════════════════════════════════════════════
// Requires these env vars to actually send/receive real messages:
//   WHATSAPP_ACCESS_TOKEN       — permanent or long-lived system-user token
//   WHATSAPP_PHONE_NUMBER_ID    — the "Phone number ID" from Meta App > WhatsApp > API Setup
//   WHATSAPP_BUSINESS_ACCOUNT_ID — the WABA ID (used for reference/logging only here)
//   WHATSAPP_VERIFY_TOKEN       — a string you choose; Meta echoes it back
//                                  during webhook verification, we just check
//                                  it matches so randoms can't hijack the webhook
//   WHATSAPP_API_VERSION        — optional, defaults to v20.0
//   META_APP_SECRET             — used to verify the X-Hub-Signature-256
//                                  header Meta signs every webhook POST
//                                  with (see verifyWebhookSignature below)
//
// Without these set, sends will fail gracefully (message is still saved to
// the DB with waStatus "failed") and the webhook will simply have nothing
// pointed at it from Meta's side. See:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
// ═════════════════════════════════════════════════════════════════

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;

const isConfigured = () => Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN);

const graphUrl = (path: string) =>
  `https://graph.facebook.com/${API_VERSION}/${path}`;

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request
 * body using META_APP_SECRET (HMAC-SHA256, per Meta's webhook security
 * docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads).
 * `rawBody` must be the exact bytes Meta sent — not a re-serialized
 * JSON.stringify of the parsed body, since whitespace/key-order
 * differences would break the signature.
 *
 * If META_APP_SECRET isn't set, this fails closed (returns false) in
 * production so a misconfigured deployment doesn't silently accept
 * unsigned payloads; in development it logs a warning and allows the
 * request through so local testing (e.g. curl, Meta's dashboard "Test"
 * button before the App Secret is wired up) still works.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
): boolean {
  if (!APP_SECRET) {
    if (process.env.NODE_ENV === "production") return false;
    console.warn(
      "WhatsApp webhook signature check skipped — META_APP_SECRET not set (dev only).",
    );
    return true;
  }
  if (!rawBody || !signatureHeader?.startsWith("sha256=")) return false;

  const expected = crypto
    .createHmac("sha256", APP_SECRET)
    .update(rawBody)
    .digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  // Lengths must match before timingSafeEqual, or it throws.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Shared POST-to-Graph-API helper with a couple of retries for
 * transient failures (network errors, timeouts, and 429/5xx — i.e.
 * conditions likely to succeed on retry). 4xx errors other than 429
 * are not retried since they indicate a bad request that won't
 * change on its own (invalid recipient, bad token, malformed
 * payload, etc.).
 */
async function postToGraph(
  path: string,
  body: Record<string, unknown>,
  { retries = 2 }: { retries?: number } = {},
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  if (!isConfigured()) {
    return {
      ok: false,
      error:
        "WhatsApp Business API is not configured (missing WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID env vars)",
    };
  }

  let lastError = "Unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(graphUrl(path), body, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      });
      return { ok: true, data: res.data };
    } catch (err: any) {
      const status = err?.response?.status;
      lastError =
        err?.response?.data?.error?.message || err?.message || "Unknown error";
      const retriable = !status || status === 429 || status >= 500;
      if (!retriable || attempt === retries) break;
      // Small exponential backoff: 300ms, 600ms, ...
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  console.error("WhatsApp Graph API call failed:", lastError);
  return { ok: false, error: lastError };
}

/** Strips everything but digits so phone numbers compare reliably
 *  regardless of "+", spaces, or dashes on either side. */
export const normalizePhone = (phone: string) => phone.replace(/\D/g, "");

export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
}

/** Pulls a WhatsApp message id out of a successful Graph API send response,
 *  or surfaces the error in the shape callers already expect. */
function toSendResult(
  result: Awaited<ReturnType<typeof postToGraph>>,
): SendResult {
  if (!result.ok) return { ok: false, error: result.error };
  const waMessageId = result.data?.messages?.[0]?.id as string | undefined;
  return { ok: true, waMessageId };
}

/**
 * Sends a plain text WhatsApp message to a client's phone number.
 * `to` should be the client's phone in any reasonable format — it's
 * normalized before sending (WhatsApp wants digits only, no "+").
 */
export async function sendWhatsappTextMessage(
  to: string,
  body: string,
): Promise<SendResult> {
  const result = await postToGraph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "text",
    text: { body },
  });
  return toSendResult(result);
}

/**
 * Sends a pre-approved template message — the only way to message a
 * client outside the 24-hour customer-service window (e.g. the first
 * outbound contact, or a reminder after the window has closed).
 * `components` follows Meta's template component schema (for
 * header/body variable substitution); omit it for templates with no
 * variables.
 */
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode = "en_US",
  components?: unknown[],
): Promise<SendResult> {
  const result = await postToGraph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  });
  return toSendResult(result);
}

/** Sends an image by public URL or a previously-uploaded Meta media ID. */
export async function sendImageMessage(
  to: string,
  image: { link: string } | { id: string },
  caption?: string,
): Promise<SendResult> {
  const result = await postToGraph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "image",
    image: { ...image, ...(caption ? { caption } : {}) },
  });
  return toSendResult(result);
}

/** Sends a document (PDF, etc.) by public URL or Meta media ID. */
export async function sendDocumentMessage(
  to: string,
  document: { link: string } | { id: string },
  options?: { filename?: string; caption?: string },
): Promise<SendResult> {
  const result = await postToGraph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "document",
    document: { ...document, ...options },
  });
  return toSendResult(result);
}

/**
 * Sends an interactive message — reply buttons (max 3) or a list
 * picker. `interactive` follows Meta's interactive object schema, e.g.
 * `{ type: "button", body: { text }, action: { buttons: [...] } }`.
 */
export async function sendInteractiveMessage(
  to: string,
  interactive: Record<string, unknown>,
): Promise<SendResult> {
  const result = await postToGraph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "interactive",
    interactive,
  });
  return toSendResult(result);
}

/** Marks an inbound message as read (shows the blue double-check to the
 *  client) — also required before certain follow-up sends by Meta's
 *  customer-service-window rules. */
export async function markMessageAsRead(
  waMessageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await postToGraph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: waMessageId,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Confirms the token Meta sends during GET webhook verification matches ours. */
export function verifyWebhookToken(token: string | undefined): boolean {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  return Boolean(expected) && token === expected;
}

/**
 * Media messages (images/documents) only give you a media ID in the
 * webhook payload — you have to make a follow-up call to resolve it to a
 * downloadable URL. That URL itself is short-lived and still requires the
 * access token to fetch, so callers should download it promptly.
 */
export async function resolveMediaUrl(
  mediaId: string,
): Promise<{ url: string; mimeType: string } | null> {
  if (!isConfigured()) return null;
  try {
    const meta = await axios.get(graphUrl(mediaId), {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 15000,
    });
    return { url: meta.data.url, mimeType: meta.data.mime_type };
  } catch (err) {
    console.error("WhatsApp media resolve failed:", err);
    return null;
  }
}

export async function downloadMedia(url: string): Promise<Buffer | null> {
  if (!isConfigured()) return null;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 20000,
    });
    return Buffer.from(res.data);
  } catch (err) {
    console.error("WhatsApp media download failed:", err);
    return null;
  }
}

export const whatsappIsConfigured = isConfigured;
