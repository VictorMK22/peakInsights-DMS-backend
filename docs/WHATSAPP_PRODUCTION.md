# WhatsApp Cloud API — Production Deployment

This covers what's needed to take the WhatsApp integration from the test
environment to production. It assumes the codebase changes described in
the PR/commit this file ships with have already been applied.

## Important correction to the domain used for the webhook

The original brief specified `https://hub.peak-insights.com/webhooks/whatsapp`
as the callback URL. Based on the actual Vercel setup (confirmed via the
project's Domains settings):

- `hub.peak-insights.com` → **`peak-insights-hub-frontend`** (the Vite/React
  app — has no Express server, no MongoDB access, cannot handle webhooks)
- `api.peak-insights.com` → **`peak-insights-hub-backend`** (this repo — the
  Express app with `/webhooks/whatsapp` already mounted)

**The production callback URL must therefore be:**

```
https://api.peak-insights.com/webhooks/whatsapp
```

Registering the frontend domain would 404 — there's no backend listening
there. Everywhere below uses `api.peak-insights.com`.

---

## 1. Architecture

```
Customer WhatsApp
        │
        ▼
Meta WhatsApp Cloud API
        │
        ▼
https://api.peak-insights.com/webhooks/whatsapp   (peak-insights-hub-backend, Vercel)
        │  (Express app, GET verify / POST events → api/index.ts serverless handler)
        ▼
PeakInsights Hub Backend
        │
        ├── src/services/whatsappService.ts   (Graph API client: send, retry, signature verify)
        ├── src/controllers/clientWhatsappController.ts  (webhook + client-facing send/list)
        ├── MongoDB — ClientWhatsappMessage collection (idempotent on waMessageId)
        ├── Client collection (inbound sender matched by normalized phone)
        └── (Notification/Invoice modules — available for future WhatsApp-channel
             wiring; not modified by this change, see §6)
```

Every request to the backend Vercel project — regardless of path — is
routed through `vercel.json`'s rewrite into `api/index.ts`, which hands
the request to the same Express `app` (`src/app.ts`) used by local dev.
The webhook route is mounted **before** the app's JWT auth middleware, so
Meta's requests reach it without a bearer token — authenticity is instead
established by the signature check described in §4.

---

## 2. Environment variables

Full `.env.example` (also present in the repo root):

```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/<database>
JWT_SECRET=your-jwt-secret
JWT_EXPIRES_IN=7d
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=52428800
ALLOWED_FILE_TYPES=pdf,doc,docx,xls,xlsx,ppt,pptx,jpg,jpeg,png,txt,csv
FRONTEND_URL=http://localhost:5173

CEO_NAME=PeakInsights CEO
CEO_EMAIL=ceo@peakinsights.com
CEO_PASSWORD=PeakInsights@2025
CEO_DEPARTMENT=Executive

# ── WhatsApp Cloud API (Meta) ──
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_API_VERSION=v20.0
META_APP_ID=
META_APP_SECRET=
```

Never commit real values — `.env` is already in `.gitignore`.

### Where each WhatsApp/Meta value comes from

| Variable                       | Where to find it                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_ACCESS_TOKEN`        | Meta Business Settings → Users → System Users → your system user → **Generate New Token**, scopes `whatsapp_business_messaging` + `whatsapp_business_management`. Use the **permanent System User token**, not the 24h token from the Cloud API quickstart. |
| `WHATSAPP_PHONE_NUMBER_ID`     | Meta App → WhatsApp → API Setup → the **Phone number ID** under your production number (not the WABA ID).                                                                                                                                                   |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta App → WhatsApp → API Setup → **WhatsApp Business Account ID**. Reference/logging only in this codebase.                                                                                                                                                |
| `WHATSAPP_VERIFY_TOKEN`        | Any string you choose. Enter the _same_ value here and in the Meta Dashboard's webhook "Verify token" field (§5).                                                                                                                                           |
| `WHATSAPP_API_VERSION`         | Optional, defaults to `v20.0` if unset.                                                                                                                                                                                                                     |
| `META_APP_ID`                  | Meta App → Settings → Basic → **App ID**. Not read server-side currently; kept for completeness/future use (e.g. embedded signup).                                                                                                                          |
| `META_APP_SECRET`              | Meta App → Settings → Basic → **App Secret**. Used to verify `X-Hub-Signature-256` on every webhook POST — **required in production**, see §4.                                                                                                              |

### Vercel environment scoping

In the `peak-insights-hub-backend` Vercel project → **Settings → Environment
Variables**, add all seven WhatsApp/Meta vars plus the existing
`MONGODB_URI`/`JWT_SECRET`/etc.:

| Variable                       | Development                                                      | Preview                  | Production                                                  |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `WHATSAPP_ACCESS_TOKEN`        | test-app token (optional)                                        | ✅                       | ✅ (permanent System User token)                            |
| `WHATSAPP_PHONE_NUMBER_ID`     | test number ID (optional)                                        | ✅                       | ✅ (production number ID)                                   |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | optional                                                         | ✅                       | ✅                                                          |
| `WHATSAPP_VERIFY_TOKEN`        | any local value                                                  | ✅ (can share with prod) | ✅                                                          |
| `WHATSAPP_API_VERSION`         | optional                                                         | optional                 | recommended, pin explicitly                                 |
| `META_APP_ID`                  | optional                                                         | ✅                       | ✅                                                          |
| `META_APP_SECRET`              | optional (checks are skipped-with-warning if unset outside prod) | ✅                       | ✅ (**required** — signature checks fail closed without it) |

Use **separate values for Preview vs Production** where you can (e.g. a
second test phone number for Preview) so pull-request deployments never
send real messages to real clients. If you only have one WhatsApp
Business number, set the vars at "Production" scope only and leave
Preview/Development unset — the app degrades gracefully (sends fail with
a clear error; the webhook rejects with 401 rather than crashing).

---

## 3. Webhook endpoint

Already implemented, no route changes needed for this deployment:

- `GET /webhooks/whatsapp` — verification handshake. Compares
  `hub.verify_token` to `WHATSAPP_VERIFY_TOKEN`; echoes `hub.challenge`
  with HTTP 200 on match, HTTP 403 otherwise.
- `POST /webhooks/whatsapp` — receives message/status events. Now:
  1. Verifies `X-Hub-Signature-256` against the raw request body (§4)
     — rejects with 401 before any processing if invalid.
  2. Acknowledges 200 immediately once the signature passes.
  3. Processes each entry/change (multiple supported per payload).
  4. Never throws on unsupported event types — falls into a labeled
     `[Unsupported message type: ...]` body rather than crashing.

Supported inbound message types: text, image, document, audio, video,
location, contacts, button replies, interactive (list/button) replies —
all normalized into the `ClientWhatsappMessage` collection with a
`messageType` field and, for non-text types, a `metadata` object holding
the type-specific structured data (coordinates for location, the shared
contact card, the selected button/list item id, etc).

Status events handled: `sent`, `delivered`, `read`, `failed` (with the
failure reason captured from Meta's `errors[0].message` into `waError`).

---

## 4. Security

- **Webhook signature verification** (new): every POST is checked against
  `X-Hub-Signature-256` (HMAC-SHA256 over the raw body, keyed with
  `META_APP_SECRET`), using a timing-safe comparison. In production, a
  missing `META_APP_SECRET` fails closed (all webhooks rejected) rather
  than silently accepting unsigned requests. In development, it logs a
  warning and allows the request through so local testing works before
  the secret is wired up.
- **Verify token**: unchanged, checked on the GET handshake.
- **Duplicate processing**: prevented via the existing unique sparse index
  on `waMessageId` in `ClientWhatsappMessage` — a redelivered webhook
  (Meta retries on anything other than a fast 200) is a no-op.
- **Rate limiting**: `/webhooks/*` is now explicitly exempted from the
  app's general 500-req/15-min-per-IP limiter, since Meta's traffic
  pattern (bursts from many clients messaging at once) is authenticated
  by the signature check above, not by request volume.
- **Logging**: webhook processing errors are logged with `.message` only
  (never the raw error object, which for an axios error could include
  the Authorization header). No code path logs `WHATSAPP_ACCESS_TOKEN`
  or `META_APP_SECRET`.
- **Sanitization**: inbound text/caption bodies are stored as-is (Mongo
  string field, not interpolated into any query or template) — no
  injection surface from message content.

---

## 5. Meta Developer Dashboard checklist

Do not assume any of this is already done — verify each item:

**Webhook subscription** (Meta App → WhatsApp → Configuration):

- Callback URL: `https://api.peak-insights.com/webhooks/whatsapp`
- Verify token: the exact value of `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and Save** — this only succeeds once the env vars above
  are live in the target Vercel environment (the GET request has to
  actually reach a deployed instance with a matching token).
- Webhook fields to subscribe to: **`messages`** (required). Also
  recommended: **`message_template_status_update`** if you'll manage
  templates and want to know when Meta approves/rejects them.

**App publication**:

- While unpublished, Meta only delivers **test** webhooks from the app
  dashboard — no production traffic reaches your endpoint until the app
  is published (App Dashboard → banner: "Publish your app").

**Business verification**:

- Required for production messaging volume and for removing the
  developer-only sending restriction. Meta Business Settings →
  Business → Security Center → **Start verification**. Can take days;
  start this early.

**Production phone number registration**:

- Meta App → WhatsApp → API Setup → **Register your WhatsApp phone
  number** for the production number (separate from the test number used
  during development).

**Permanent System User token**:

- Confirm the token in `WHATSAPP_ACCESS_TOKEN` is the **permanent**
  System User token, not the temporary 24-hour token the quickstart page
  generates for testing — the temporary one will expire and silently
  break production sending.

---

## 6. Integration with existing modules

The repo already has `Client`, `ClientInvoice`, and an in-app
`Notification` model/service. This change does **not** wire WhatsApp into
invoice/quotation notifications automatically — that would mean deciding
product behavior (which events trigger a WhatsApp message, what the
message copy is, whether it needs a Meta-approved template since most
such notifications happen outside the 24-hour customer-service window)
that's outside the scope of "make the integration production-ready."

What's now available for that follow-up work:

- `sendTemplateMessage()` — needed for any proactive notification (an
  invoice or payment confirmation is not a reply to a customer message,
  so it requires a pre-approved template, not `sendTextMessage()`).
- `sendDocumentMessage()` — for attaching an invoice PDF.
- The existing per-client thread (`GET/POST /clients/:id/whatsapp`) already
  gives staff a place to see any such automated message alongside manual
  ones.

Recommend scoping this as its own follow-up task once the relevant
templates are approved by Meta (template approval must happen before the
code can send them).

---

## 7. Testing

`src/tests/whatsappWebhook.test.ts` (new) covers, against a real
in-memory MongoDB (`mongodb-memory-server`, same pattern as the rest of
`src/tests/`):

- GET verification: valid token, invalid token, wrong `hub.mode`
- POST signature check: missing signature (401), wrong secret (401),
  correctly signed (200)
- Inbound text message stored and matched to the right client
- Inbound location message normalized into `metadata`
- Duplicate webhook delivery does not create a duplicate record
- Message from an unrecognized number is dropped without erroring
- Status webhook updates `waStatus` on the corresponding outbound message

Run with:

```bash
npm test
```

(Existing `tests/*.test` files at the repo root are pre-existing and not
wired into this Jest config — see the comment in `jest.config.js`; not
touched by this change.)

**Not yet covered by automated tests** (would need a mocked or
sandboxed Graph API call): outgoing send success, invalid recipient,
Meta auth failure. `whatsappService.ts`'s `postToGraph()` is structured
so these are straightforward to add with `axios` mocked — recommend as a
fast follow if outbound send reliability needs regression coverage.

---

## 8. Deployment steps

1. In the `peak-insights-hub-backend` Vercel project, add all environment
   variables from §2 at **Production** scope (and Preview, if you want
   PR previews to be able to send/receive — see the note about using a
   separate test number for Preview).
2. Deploy (`git push` to the branch Vercel builds from, or `vercel
--prod`). No `vercel.json` changes were needed — the existing rewrite
   already routes every path, including `/webhooks/whatsapp`, into
   `api/index.ts`.
3. Confirm `https://api.peak-insights.com/webhooks/whatsapp` resolves
   (should return `403` for a bare `GET` with no query params — that's
   correct, it means the route is live and rejecting an unverified
   handshake attempt).
4. Register the webhook in the Meta Dashboard per §5. "Verify and Save"
   should now succeed.
5. Send a real WhatsApp message to the production number from a phone
   Meta will allow (during pre-verification, only numbers added as
   testers in the Meta Dashboard can message the number) and confirm it
   appears in `ClientWhatsappMessage` / the client's thread in the app.
6. Send an outbound message via the app UI and confirm delivery status
   progresses `sent` → `delivered` → `read` as the recipient reads it.

---

## 9. Final verification checklist

- [ ] `GET /webhooks/whatsapp` with the correct verify token returns the
      challenge and 200; wrong token returns 403.
- [ ] Meta Dashboard webhook "Verify and Save" succeeds against
      `https://api.peak-insights.com/webhooks/whatsapp`.
- [ ] A real inbound WhatsApp message reaches MongoDB
      (`ClientWhatsappMessage`, `direction: "inbound"`).
- [ ] An outbound message sent from the app is delivered and its
      `waMessageId` is populated.
- [ ] Delivery status transitions (`sent` → `delivered` → `read`) are
      reflected on the stored message.
- [ ] Resending the same webhook payload (e.g. via Meta Dashboard's
      "Resend" on a test event) does not create a duplicate DB record.
- [ ] The production domain works with **no ngrok dependency** —
      confirm nothing in `.env`/Vercel env vars still points at an
      `ngrok.io`/`ngrok-free.app` URL.
- [ ] `git log -p -- .env` / a secrets scan confirms no real token or
      app secret was ever committed (`.env` has always been in
      `.gitignore` in this repo).
- [ ] `META_APP_SECRET` is set in Production — without it, all incoming
      webhooks are rejected with 401 (fail-closed behavior, by design).
