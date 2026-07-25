import axios from "axios";

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
//
// Without these set, sends will fail gracefully (message is still saved to
// the DB with waStatus "failed") and the webhook will simply have nothing
// pointed at it from Meta's side. See:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
// ═════════════════════════════════════════════════════════════════

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const isConfigured = () => Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN);

const graphUrl = (path: string) =>
  `https://graph.facebook.com/${API_VERSION}/${path}`;

/** Strips everything but digits so phone numbers compare reliably
 *  regardless of "+", spaces, or dashes on either side. */
export const normalizePhone = (phone: string) => phone.replace(/\D/g, "");

export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
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
  if (!isConfigured()) {
    return {
      ok: false,
      error:
        "WhatsApp Business API is not configured (missing WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID env vars)",
    };
  }
  try {
    const res = await axios.post(
      graphUrl(`${PHONE_NUMBER_ID}/messages`),
      {
        messaging_product: "whatsapp",
        to: normalizePhone(to),
        type: "text",
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );
    const waMessageId = res.data?.messages?.[0]?.id as string | undefined;
    return { ok: true, waMessageId };
  } catch (err: any) {
    const message =
      err?.response?.data?.error?.message || err?.message || "Unknown error";
    console.error("WhatsApp send failed:", message);
    return { ok: false, error: message };
  }
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
