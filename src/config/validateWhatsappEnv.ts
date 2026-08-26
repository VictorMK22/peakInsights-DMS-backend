// ═════════════════════════════════════════════════════════════════
// Startup validation for the WhatsApp / Meta Cloud API env vars.
// ═════════════════════════════════════════════════════════════════
// Deliberately logs rather than throws/process.exit()s, even in
// production: this Express app is a single shared instance serving
// every module (documents, tasks, invoices, meetings, etc.), not a
// WhatsApp-only service, and whatsappService.ts already degrades
// gracefully on its own (isConfigured() checks before every Graph API
// call, sends fail with a clear error instead of crashing). Taking
// the entire API down because WhatsApp specifically isn't configured
// yet would be a worse outage than the feature just being
// unavailable, so a loud, impossible-to-miss log is the right level
// of "meaningful startup error" here — ops sees it immediately in the
// Vercel function logs without every other feature going dark too.
// ═════════════════════════════════════════════════════════════════

interface EnvSpec {
  name: string;
  required: boolean; // required to actually send/receive WhatsApp messages
  note?: string;
}

const WHATSAPP_ENV_VARS: EnvSpec[] = [
  { name: "WHATSAPP_ACCESS_TOKEN", required: true },
  { name: "WHATSAPP_PHONE_NUMBER_ID", required: true },
  { name: "WHATSAPP_VERIFY_TOKEN", required: true },
  {
    name: "META_APP_SECRET",
    required: true,
    note: "without this, webhook signature verification fails closed in production (all incoming webhooks rejected)",
  },
  {
    name: "WHATSAPP_BUSINESS_ACCOUNT_ID",
    required: false,
    note: "reference/logging only",
  },
  {
    name: "WHATSAPP_API_VERSION",
    required: false,
    note: 'defaults to "v20.0"',
  },
  {
    name: "META_APP_ID",
    required: false,
    note: "not currently read server-side; kept for completeness / future use",
  },
];

export function validateWhatsappEnv(): void {
  const missing = WHATSAPP_ENV_VARS.filter(
    (v) => v.required && !process.env[v.name],
  );
  if (missing.length === 0) return;

  const isProd = process.env.NODE_ENV === "production";
  const lines = missing.map(
    (v) => `   - ${v.name}${v.note ? ` (${v.note})` : ""}`,
  );

  const banner = [
    "═".repeat(70),
    `⚠️  WhatsApp Cloud API is NOT fully configured${isProd ? " (production)" : ""}.`,
    "   Missing environment variables:",
    ...lines,
    "",
    isProd
      ? "   Outgoing sends will fail and incoming webhooks will be rejected"
      : "   Outgoing sends will fail gracefully; the webhook endpoint will",
    isProd
      ? "   with 401 until these are set in the Vercel Production"
      : "   reject signature verification until these are set locally",
    isProd
      ? "   environment (Project → Settings → Environment Variables)."
      : "   (see .env.example).",
    "   The rest of the application is unaffected.",
    "═".repeat(70),
  ].join("\n");

  if (isProd) {
    console.error(banner);
  } else {
    console.warn(banner);
  }
}
