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

async function syncOneMailbox(integration: IEmailIntegration): Promise<void> {
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

  if (clientByEmail.size === 0 && staffByEmail.size === 0) return;

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

      if (clientId) {
        await syncClientMessage(
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
        await syncInternalMessage(
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

      newestSeen = Math.max(newestSeen, Number(msg.receivedTime));
    }
  }

  integration.lastSyncedAt = new Date(newestSeen);
  integration.status = "connected";
  integration.lastError = undefined;
  await integration.save();
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
): Promise<void> {
  // Idempotency: skip if we've already logged this exact message
  // (unique index also protects against a race, this just avoids
  // the extra failed insert + noisy error log).
  const exists = await ClientEmailModel.exists({
    externalMessageId: msg.messageId,
  });
  if (exists) return;

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
  } catch (err: any) {
    // Duplicate key race (unique index) — safe to ignore
    if (err?.code !== 11000) {
      console.error(
        `Zoho sync: failed to save client message ${msg.messageId}:`,
        err,
      );
    }
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
): Promise<void> {
  const epochMs = Number(msg.receivedTime);
  const dedupeKey = computeInternalDedupeKey(
    [integration.emailAddress, counterpart],
    msg.subject,
    epochMs,
  );

  const exists = await EmailLog.exists({ dedupeKey });
  if (exists) return;

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

  // Note: EmailLog has no attachments field today, so internal synced
  // messages are logged text-only. Attachments still sync fine for the
  // client-facing side (see syncClientMessage / ClientEmail).
  try {
    await EmailLog.create({
      senderId: direction === "inbound" ? otherUserId : integration.userId,
      receiverId: direction === "inbound" ? integration.userId : otherUserId,
      toEmail:
        direction === "outbound" ? counterpart : integration.emailAddress,
      subject: msg.subject,
      body: body || "(no content)",
      bodyPreview: (body || "(no content)")
        .replace(/<[^>]*>/g, "")
        .slice(0, 200),
      status: "sent",
      sentAt: new Date(epochMs),
      lastMessageAt: new Date(epochMs),
      parentId: null,
      source: "external_sync",
      dedupeKey,
    });
  } catch (err: any) {
    // Duplicate key race (unique index) — safe to ignore, this is the
    // expected outcome when the other participant's sync already logged it
    if (err?.code !== 11000) {
      console.error(
        `Zoho sync: failed to save internal message ${msg.messageId}:`,
        err,
      );
    }
  }
}

async function syncAttachments(
  accessToken: string,
  accountId: string,
  folderId: string,
  msg: ZohoMessageSummary,
): Promise<
  { filename: string; fileKey: string; size: number; mimeType: string }[]
> {
  if (!msg.hasAttachment) return [];
  try {
    const metas = await listMessageAttachments(
      accessToken,
      accountId,
      folderId,
      msg.messageId,
    );
    const results = [];
    for (const meta of metas) {
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
      });
    }
    return results;
  } catch (err) {
    console.error(
      `Zoho sync: failed to sync attachments for message ${msg.messageId}:`,
      err,
    );
    return [];
  }
}

/** Entry point called by the scheduled job (queue-backed or setInterval fallback). */
export async function syncAllConnectedMailboxes(): Promise<void> {
  const integrations = await EmailIntegrationModel.find({
    status: { $ne: "disconnected" },
  });
  for (const integration of integrations) {
    try {
      await syncOneMailbox(integration);
    } catch (err: any) {
      console.error(`Zoho sync failed for ${integration.emailAddress}:`, err);
      integration.status = "error";
      integration.lastError = err?.message || "Unknown sync error";
      await integration.save().catch(() => undefined);
    }
  }
}
