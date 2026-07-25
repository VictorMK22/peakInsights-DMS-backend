import axios from "axios";

// ═════════════════════════════════════════════════════════════════
// ZOHO MAIL API CLIENT
// ═════════════════════════════════════════════════════════════════
// Docs: https://www.zoho.com/mail/help/api/
//
// Required env vars:
//   ZOHO_CLIENT_ID
//   ZOHO_CLIENT_SECRET
//   ZOHO_REDIRECT_URI        — e.g. https://yourdomain.com/api/integrations/zoho/callback
//   ZOHO_ACCOUNTS_DOMAIN     — region-specific, defaults to accounts.zoho.com
//                              (EU: accounts.zoho.eu, IN: accounts.zoho.in,
//                              AU: accounts.zoho.com.au, JP: accounts.zoho.jp —
//                              use whichever matches where your Zoho org is hosted)
//   ZOHO_MAIL_API_DOMAIN     — defaults to mail.zoho.com (same region rule)
// ═════════════════════════════════════════════════════════════════

const ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || "accounts.zoho.com";
const MAIL_API_DOMAIN = process.env.ZOHO_MAIL_API_DOMAIN || "mail.zoho.com";
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;

// Read-only — we only ever need to see mail, never send through the
// staff member's own account (outbound already goes through our SMTP).
const SCOPES = [
  "ZohoMail.accounts.READ",
  "ZohoMail.folders.READ",
  "ZohoMail.messages.READ",
].join(",");

export const isZohoConfigured = () =>
  Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

export function buildZohoAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID || "",
    response_type: "code",
    redirect_uri: REDIRECT_URI || "",
    scope: SCOPES,
    access_type: "offline", // required to receive a refresh token
    prompt: "consent", // required every time to actually get a refresh token back
    state,
  });
  return `https://${ACCOUNTS_DOMAIN}/oauth/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
}

export async function exchangeCodeForTokens(
  code: string,
): Promise<TokenResponse> {
  const res = await axios.post(
    `https://${ACCOUNTS_DOMAIN}/oauth/v2/token`,
    null,
    {
      params: {
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      },
    },
  );
  return res.data;
}

export async function refreshZohoAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await axios.post(
    `https://${ACCOUNTS_DOMAIN}/oauth/v2/token`,
    null,
    {
      params: {
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
      },
    },
  );
  return res.data;
}

const authHeader = (accessToken: string) => ({
  Authorization: `Zoho-oauthtoken ${accessToken}`,
});

/** Returns the Zoho "accountId" (needed for every other call) + primary email. */
export async function fetchZohoAccount(
  accessToken: string,
): Promise<{ accountId: string; emailAddress: string }> {
  const res = await axios.get(`https://${MAIL_API_DOMAIN}/api/accounts`, {
    headers: authHeader(accessToken),
  });
  const account = res.data?.data?.[0];
  if (!account) throw new Error("No Zoho Mail account found for this token");
  return {
    accountId: String(account.accountId),
    emailAddress: (
      account.primaryEmailAddress ||
      account.mailboxAddress ||
      ""
    ).toLowerCase(),
  };
}

export interface ZohoFolder {
  folderId: string;
  folderName: string;
  folderType?: string; // e.g. "Inbox", "Sent"
}

export async function listFolders(
  accessToken: string,
  accountId: string,
): Promise<ZohoFolder[]> {
  const res = await axios.get(
    `https://${MAIL_API_DOMAIN}/api/accounts/${accountId}/folders`,
    { headers: authHeader(accessToken) },
  );
  return res.data?.data ?? [];
}

export interface ZohoMessageSummary {
  messageId: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  receivedTime: string; // epoch millis as string
  hasAttachment: boolean;
}

export async function listMessages(
  accessToken: string,
  accountId: string,
  folderId: string,
  sinceEpochMs: number,
  limit = 50,
): Promise<ZohoMessageSummary[]> {
  const res = await axios.get(
    `https://${MAIL_API_DOMAIN}/api/accounts/${accountId}/messages/view`,
    {
      headers: authHeader(accessToken),
      params: {
        folderId,
        limit,
        sortBy: "date",
        sortorder: false, // newest first
      },
    },
  );
  const messages: any[] = res.data?.data ?? [];
  return messages
    .filter((m) => Number(m.receivedTime) > sinceEpochMs)
    .map((m) => ({
      messageId: String(m.messageId),
      subject: m.subject || "(no subject)",
      fromAddress: (m.fromAddress || "").toLowerCase(),
      toAddress: (m.toAddress || "").toLowerCase(),
      receivedTime: String(m.receivedTime),
      hasAttachment: Boolean(m.hasAttachment),
    }));
}

export async function getMessageContent(
  accessToken: string,
  accountId: string,
  folderId: string,
  messageId: string,
): Promise<string> {
  const res = await axios.get(
    `https://${MAIL_API_DOMAIN}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`,
    { headers: authHeader(accessToken) },
  );
  // Zoho returns HTML content; callers can strip tags if a plain-text
  // preview is needed, but we store it as-is (same as our own SMTP emails).
  return res.data?.data?.content ?? "";
}

export interface ZohoAttachmentMeta {
  attachmentId: string;
  attachmentName: string;
  attachmentSize: number;
  contentType: string;
}

export async function listMessageAttachments(
  accessToken: string,
  accountId: string,
  folderId: string,
  messageId: string,
): Promise<ZohoAttachmentMeta[]> {
  const res = await axios.get(
    `https://${MAIL_API_DOMAIN}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo`,
    { headers: authHeader(accessToken) },
  );
  return res.data?.data ?? [];
}

export async function downloadAttachment(
  accessToken: string,
  accountId: string,
  folderId: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await axios.get(
    `https://${MAIL_API_DOMAIN}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`,
    { headers: authHeader(accessToken), responseType: "arraybuffer" },
  );
  return Buffer.from(res.data);
}
