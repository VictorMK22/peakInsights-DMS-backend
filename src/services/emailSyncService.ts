import crypto from "crypto";
import {
  EmailIntegrationModel,
  IEmailIntegration,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from "../models/EmailIntegration";
import { ClientModel } from "../models/Client";
import { ClientEmailModel } from "../models/ClientEmail";
import { User } from "../models/User";
import { EmailLog } from "../models/EmailLog";
import { uploadBufferToS3 } from "./s3Storage";
import {
  refreshZohoAccessToken,
  listFolders,
  listMessages,
  getMessageContent,
  listMessageAttachments,
  downloadAttachment,
  ZohoMessageSummary,
} from "./zohoMailService";

const MAX_SYNCED_ATTACHMENTS = 10;
const MAX_SYNCED_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Refreshes the stored access token if it's expired or about to be. */
async function ensureFreshToken(
  integration: IEmailIntegration,
): Promise<string> {
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  if (integration.tokenExpiresAt.getTime() > fiveMinutesFromNow) {
    return getAccessToken(integration);
  }
  const refreshed = await refreshZohoAccessToken(getRefreshToken(integration));
  setTokens(
    integration,
    refreshed.access_token,
    // Zoho doesn't always return a new refresh token on refresh — keep the old one if so
    refreshed.refresh_token || getRefreshToken(integration),
    refreshed.expires_in,
  );
  await integration.save();
  return refreshed.access_token;
}

/** Extracts the "other party" email address from a message, given which
 *  folder it came from (Inbox = client is the sender, Sent = client is
 *  the recipient). Handles Zoho's "Name <email>" formatting. */
function extractCounterpartEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

/** Content fingerprint used to dedupe an internal staff-to-staff email
 *  that may get synced independently from both participants' mailboxes.
 *  Rounds the timestamp to the minute since the two copies of the same
 *  message can have slightly different stored receivedTime values. */
function computeInternalDedupeKey(
  participantEmails: string[],
  subject: string,
  epochMs: number,
): string {
  const normalized = [
    [...participantEmails]
      .map((e) => e.toLowerCase())
      .sort()
      .join("|"),
    subject.trim().toLowerCase(),
    Math.floor(epochMs / 60000),
  ].join("::");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** Plain-text preview of an HTML email body: drops <style>/<script>/<head>,
 *  strips tags, decodes common entities, collapses whitespace. */
function htmlToPreview(html: string, max = 200): string {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function syncOneMailbox(
  integration: IEmailIntegration,
): Promise<{ messagesFound: number; messagesSynced: number }> {
  const accessToken = await ensureFreshToken(integration);
  const accountId = integration.providerAccountId;

  // Two lookups: known clients (external comms) and known staff (internal
  // comms) — this is the whole filter. Anything that matches neither is
  // unrelated personal mail and is never logged.
  const clients = await ClientModel.find({
    email: { $exists: true, $ne: "" },
  }).select("email");
  const clientByEmail = new Map(
    clients.map((c) => [String(c.email).toLowerCase(), c._id]),
  );

  const staff = await User.find({
    _id: { $ne: integration.userId },
    email: { $exists: true, $ne: "" },
  }).select("email name");
  const staffByEmail = new Map(
    staff.map((s) => [String(s.email).toLowerCase(), s._id]),
  );

  let messagesFound = 0;
  let messagesSynced = 0;

  if (clientByEmail.size === 0 && staffByEmail.size === 0)
    return { messagesFound, messagesSynced };

  const folders = await listFolders(accessToken, accountId);
  const inbox = folders.find((f) =>
    /inbox/i.test(f.folderType || f.folderName),
  );
  const sent = folders.find((f) => /sent/i.test(f.folderType || f.folderName));

  const sinceEpochMs =
    integration.lastSyncedAt?.getTime() ??
    Date.now() - 30 * 24 * 60 * 60 * 1000; // first run: last 30 days
  let newestSeen = sinceEpochMs;

  const targets: { folderId: string; direction: "inbound" | "outbound" }[] = [];
  if (inbox) targets.push({ folderId: inbox.folderId, direction: "inbound" });
  if (sent) targets.push({ folderId: sent.folderId, direction: "outbound" });

  for (const target of targets) {
    let messages: ZohoMessageSummary[] = [];
    try {
      messages = await listMessages(
        accessToken,
        accountId,
        target.folderId,
        sinceEpochMs,
      );
    } catch (err) {
      console.error(
        `Zoho sync: failed to list messages for ${integration.emailAddress} (${target.direction}):`,
        err,
      );
      continue;
    }

    for (const msg of messages) {
      const counterpart = extractCounterpartEmail(
        target.direction === "inbound" ? msg.fromAddress : msg.toAddress,
      );

      const clientId = clientByEmail.get(counterpart);
      const staffUserId = staffByEmail.get(counterpart);
      if (!clientId && !staffUserId) continue; // unrelated mail — never logged

      messagesFound++;
      let wasLogged = false;
      if (clientId) {
        wasLogged = await syncClientMessage(
          integration,
          target.direction,
          target.folderId,
          msg,
          counterpart,
          clientId,
          accessToken,
          accountId,
        );
      } else if (staffUserId) {
        wasLogged = await syncInternalMessage(
          integration,
          target.direction,
          target.folderId,
          msg,
          counterpart,
          staffUserId,
          accessToken,
          accountId,
        );
      }
      if (wasLogged) messagesSynced++;

      newestSeen = Math.max(newestSeen, Number(msg.receivedTime));
    }
  }

  // One-time, automatic catch-up for internal emails synced before
  // attachments were supported. Best-effort: never fails the sync.
  try {
    await backfillInternalAttachments(
      integration,
      accessToken,
      accountId,
      targets,
      staffByEmail,
    );
  } catch (err) {
    console.error(
      `Zoho sync: attachment backfill failed for ${integration.emailAddress}:`,
      err,
    );
  }

  integration.lastSyncedAt = new Date(newestSeen);
  integration.status = "connected";
  integration.lastError = undefined;
  await integration.save();

  return { messagesFound, messagesSynced };
}

// ── Attachment backfill ───────────────────────────────────────────
// Internal emails synced before attachment support have none stored, and
// the normal incremental sync never looks at them again. This walks back
// through recent mail once per mailbox and fills them in. It is budgeted
// per run (serverless time limits) and resumes on the next sync until it
// has covered everything, then records attachmentBackfilledAt and stops.
const BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const BACKFILL_MAX_FILLED_PER_RUN = 25;
const BACKFILL_TIME_BUDGET_MS = 25_000; // leave headroom under the serverless limit
const BACKFILL_MAX_PAGES = 6; // x50 messages per folder
const BACKFILL_MAX_ATTEMPTS = 3;

async function backfillInternalAttachments(
  integration: IEmailIntegration,
  accessToken: string,
  accountId: string,
  targets: { folderId: string; direction: "inbound" | "outbound" }[],
  staffByEmail: Map<string, unknown>,
): Promise<void> {
  if (integration.attachmentBackfilledAt) return;

  const since = Date.now() - BACKFILL_WINDOW_MS;
  const deadline = Date.now() + BACKFILL_TIME_BUDGET_MS;
  const stats = { scanned: 0, withFiles: 0, matched: 0, filled: 0, empty: 0, failed: 0 };
  let finished = true;

  outer: for (const target of targets) {
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const messages = await listMessages(
        accessToken,
        accountId,
        target.folderId,
        since,
        50,
        page * 50 + 1,
      );

      for (const msg of messages) {
        stats.scanned++;
        if (!msg.hasAttachment) continue;
        stats.withFiles++;
        const counterpart = extractCounterpartEmail(
          target.direction === "inbound" ? msg.fromAddress : msg.toAddress,
        );
        if (!staffByEmail.has(counterpart)) continue; // client mail is handled elsewhere

        const log = await EmailLog.findOne({
          dedupeKey: computeInternalDedupeKey(
            [integration.emailAddress, counterpart],
            msg.subject,
            Number(msg.receivedTime),
          ),
          attachmentsCheckedAt: { $exists: false },
        }).select("_id attachments attachmentBackfillAttempts");
        if (!log || log.attachments?.length) continue;
        stats.matched++;

        if (
          stats.filled + stats.failed >= BACKFILL_MAX_FILLED_PER_RUN ||
          Date.now() > deadline
        ) {
          finished = false; // out of budget — pick up again on the next sync
          break outer;
        }

        try {
          const attachments = await fetchAttachments(
            accessToken,
            accountId,
            target.folderId,
            msg,
          );
          // A clean answer — even "no files" — means we're done with this email.
          await EmailLog.updateOne(
            { _id: log._id },
            {
              ...(attachments.length ? { attachments } : {}),
              attachmentsCheckedAt: new Date(),
            },
          );
          attachments.length ? stats.filled++ : stats.empty++;
        } catch (err: any) {
          // Don't mark it checked on a failure — retry next sync, but give up
          // after a few attempts so one bad email can't block the rest.
          stats.failed++;
          const attempts = (log.attachmentBackfillAttempts ?? 0) + 1;
          await EmailLog.updateOne(
            { _id: log._id },
            {
              attachmentBackfillAttempts: attempts,
              ...(attempts >= BACKFILL_MAX_ATTEMPTS
                ? { attachmentsCheckedAt: new Date() }
                : {}),
            },
          );
          console.error(
            `Zoho backfill: attachments failed for "${msg.subject}" (attempt ${attempts}):`,
            err?.response?.status ?? "",
            err?.response?.data ?? err?.message ?? err,
          );
        }
      }

      // A short page means we've reached the end of the window.
      if (messages.length < 50) break;
    }
  }

  console.log(
    `Zoho backfill ${integration.emailAddress}: ${JSON.stringify(stats)} ${finished ? "— complete" : "— will continue next sync"}`,
  );
  if (finished) integration.attachmentBackfilledAt = new Date();
}

async function syncClientMessage(
  integration: IEmailIntegration,
  direction: "inbound" | "outbound",
  folderId: string,
  msg: ZohoMessageSummary,
  counterpart: string,
  clientId: any,
  accessToken: string,
  accountId: string,
): Promise<boolean> {
  // Idempotency: skip if we've already logged this exact message
  // (unique index also protects against a race, this just avoids
  // the extra failed insert + noisy error log).
  const exists = await ClientEmailModel.exists({
    externalMessageId: msg.messageId,
  });
  if (exists) return false;

  let body = "";
  try {
    body = await getMessageContent(
      accessToken,
      accountId,
      folderId,
      msg.messageId,
    );
  } catch (err) {
    console.error(
      `Zoho sync: failed to fetch content for message ${msg.messageId}:`,
      err,
    );
  }

  const attachments = await syncAttachments(
    accessToken,
    accountId,
    folderId,
    msg,
  );

  try {
    await ClientEmailModel.create({
      clientId,
      authorId: integration.userId,
      direction,
      subject: msg.subject,
      body: body || "(no content)",
      fromEmail:
        direction === "inbound" ? counterpart : integration.emailAddress,
      toEmail:
        direction === "outbound" ? counterpart : integration.emailAddress,
      attachments,
      status: direction === "outbound" ? "sent" : "received",
      sentAt: new Date(Number(msg.receivedTime)),
      source: "external_sync",
      externalMessageId: msg.messageId,
      syncedFromUserId: integration.userId,
    });
    return true;
  } catch (err: any) {
    // Duplicate key race (unique index) — safe to ignore
    if (err?.code !== 11000) {
      console.error(
        `Zoho sync: failed to save client message ${msg.messageId}:`,
        err,
      );
    }
    return false;
  }
}

async function syncInternalMessage(
  integration: IEmailIntegration,
  direction: "inbound" | "outbound",
  folderId: string,
  msg: ZohoMessageSummary,
  counterpart: string,
  otherUserId: any,
  accessToken: string,
  accountId: string,
): Promise<boolean> {
  const epochMs = Number(msg.receivedTime);
  const dedupeKey = computeInternalDedupeKey(
    [integration.emailAddress, counterpart],
    msg.subject,
    epochMs,
  );

  const exists = await EmailLog.exists({ dedupeKey });
  if (exists) return false;

  let body = "";
  try {
    body = await getMessageContent(
      accessToken,
      accountId,
      folderId,
      msg.messageId,
    );
  } catch (err) {
    console.error(
      `Zoho sync: failed to fetch content for message ${msg.messageId}:`,
      err,
    );
  }

  const attachments = await syncAttachments(
    accessToken,
    accountId,
    folderId,
    msg,
  );

  try {
    await EmailLog.create({
      senderId: direction === "inbound" ? otherUserId : integration.userId,
      receiverId: direction === "inbound" ? integration.userId : otherUserId,
      toEmail:
        direction === "outbound" ? counterpart : integration.emailAddress,
      subject: msg.subject,
      body: body || "(no content)",
      bodyPreview: htmlToPreview(body || "(no content)"),
      status: "sent",
      sentAt: new Date(epochMs),
      lastMessageAt: new Date(epochMs),
      parentId: null,
      source: "external_sync",
      dedupeKey,
      attachments: attachments.length ? attachments : undefined,
    });
    return true;
  } catch (err: any) {
    // Duplicate key race (unique index) — safe to ignore, this is the
    // expected outcome when the other participant's sync already logged it
    if (err?.code !== 11000) {
      console.error(
        `Zoho sync: failed to save internal message ${msg.messageId}:`,
        err,
      );
    }
    return false;
  }
}

type SyncedAttachment = {
  filename: string;
  fileKey: string;
  size: number;
  mimeType: string;
  contentId?: string;
};

/** Downloads a message's attachments into S3. THROWS on failure so callers can tell "none" from "couldn't fetch". */
async function fetchAttachments(
  accessToken: string,
  accountId: string,
  folderId: string,
  msg: ZohoMessageSummary,
): Promise<SyncedAttachment[]> {
  if (!msg.hasAttachment) return [];
  const metas = await listMessageAttachments(
    accessToken,
    accountId,
    folderId,
    msg.messageId,
  );
  const results: SyncedAttachment[] = [];
  for (const meta of metas.slice(0, MAX_SYNCED_ATTACHMENTS)) {
    // Skip oversized files rather than risk the serverless function timing out.
    if (meta.attachmentSize > MAX_SYNCED_ATTACHMENT_BYTES) continue;
    const buffer = await downloadAttachment(
      accessToken,
      accountId,
      folderId,
      msg.messageId,
      meta.attachmentId,
    );
    const fileKey = await uploadBufferToS3(
      buffer,
      meta.attachmentName,
      meta.contentType,
    );
    results.push({
      filename: meta.attachmentName,
      fileKey,
      size: meta.attachmentSize,
      mimeType: meta.contentType,
      contentId: meta.contentId,
    });
  }
  return results;
}

/** Best-effort wrapper used by the normal sync: a failure just means no attachments this time. */
async function syncAttachments(
  accessToken: string,
  accountId: string,
  folderId: string,
  msg: ZohoMessageSummary,
): Promise<SyncedAttachment[]> {
  try {
    return await fetchAttachments(accessToken, accountId, folderId, msg);
  } catch (err) {
    console.error(
      `Zoho sync: failed to sync attachments for message ${msg.messageId}:`,
      err,
    );
    return [];
  }
}

/** Entry point called by the scheduled job (queue-backed or setInterval fallback). */
export async function syncAllConnectedMailboxes(): Promise<{
  mailboxesChecked: number;
  mailboxesFailed: number;
  messagesFound: number;
  messagesSynced: number;
}> {
  const integrations = await EmailIntegrationModel.find({
    status: { $ne: "disconnected" },
  });

  let mailboxesFailed = 0;
  let messagesFound = 0;
  let messagesSynced = 0;

  for (const integration of integrations) {
    try {
      const result = await syncOneMailbox(integration);
      messagesFound += result.messagesFound;
      messagesSynced += result.messagesSynced;
    } catch (err: any) {
      mailboxesFailed++;
      console.error(`Zoho sync failed for ${integration.emailAddress}:`, err);
      integration.status = "error";
      integration.lastError = err?.message || "Unknown sync error";
      await integration.save().catch(() => undefined);
    }
  }

  const summary = {
    mailboxesChecked: integrations.length,
    mailboxesFailed,
    messagesFound,
    messagesSynced,
  };
  // On-success logging (everything else in this file only logs on error) —
  // without this, a Vercel log search after a cron run can't tell "ran
  // fine, nothing new" apart from "never actually ran".
  console.log("Zoho email sync summary:", summary);
  return summary;
}

/**
 * On-demand sync of ONE user's connected mailbox — powers the "Sync now"
 * button on the Emails page. The scheduled job only runs every ~10 minutes
 * (GitHub Actions cron), which is why the inbox could look stale.
 * Returns null if the user hasn't connected a mailbox.
 */
export async function syncMyMailbox(
  userId: string,
): Promise<{ messagesFound: number; messagesSynced: number } | null> {
  const integration = await EmailIntegrationModel.findOne({
    userId,
    status: { $ne: "disconnected" },
  });
  if (!integration) return null;
  try {
    return await syncOneMailbox(integration);
  } catch (err: any) {
    integration.status = "error";
    integration.lastError = err?.message || "Unknown sync error";
    await integration.save().catch(() => undefined);
    throw err;
  }
}