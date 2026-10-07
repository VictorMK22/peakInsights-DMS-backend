import mongoose from "mongoose";
import { EmailLog, IEmailAttachment } from "../models/EmailLog";
import { sendDirectUserEmail } from "./emailService";
import { AuditLog } from "../models/AuditLog";
import { MailAttachment } from "./emailAttachmentService";

// Recipients per SMTP transaction for announcements. Providers cap
// recipients per message (Zoho's limit is low on some plans), so a big
// announcement is split into several BCC batches.
const BROADCAST_BATCH_SIZE =
  Number(process.env.EMAIL_BROADCAST_BATCH_SIZE) || 40;

export async function sendTrackedEmail({
  senderId,
  receiverId,
  receiverEmail,
  receiverName,
  ccUsers,
  senderName,
  senderEmail,
  subject,
  body,
  ipAddress,
  userAgent,
  supervisorId,
  parentId,
  attachments,
  mailAttachments,
}: any) {
  const now = new Date();
  const cc: { _id: string; email: string }[] = ccUsers ?? [];

  // For a reply, pull the immediate parent so we can (a) build the
  // real RFC 2822 threading headers (In-Reply-To / References) and
  // (b) quote what they actually wrote underneath our reply — this
  // is what makes it land in the recipient's real inbox as a normal
  // threaded email reply instead of a fresh, unrelated message.
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let quoted: { fromName: string; date: string; body: string } | undefined;

  if (parentId) {
    const parent = await EmailLog.findById(parentId)
      .populate("senderId", "name")
      .select("senderId subject body messageId references createdAt");

    if (parent) {
      inReplyTo = parent.messageId;
      references = [...(parent.references ?? []), parent.messageId].filter(
        (v): v is string => !!v,
      );
      quoted = {
        fromName: (parent.senderId as any)?.name ?? "Someone",
        date: new Date(parent.createdAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }),
        body: parent.body,
      };
    }
  }

  // 1. create log FIRST
  const log = await EmailLog.create({
    senderId,
    receiverId,
    toEmail: receiverEmail,
    ccIds: cc.length ? cc.map((c) => c._id) : undefined,
    ccEmails: cc.length ? cc.map((c) => c.email) : undefined,
    subject,
    body,
    bodyPreview: body.slice(0, 200),
    status: "pending",
    parentId: parentId || undefined,
    lastMessageAt: now,
    attachments: attachments?.length ? attachments : undefined,
  });

  // A reply landed — bump the root thread's lastMessageAt so the
  // conversation resurfaces to the top of the inbox/sent list, same
  // as Messages does.
  if (parentId) {
    await EmailLog.findByIdAndUpdate(parentId, {
      lastMessageAt: now,
      hasReplies: true,
    });
  }

  try {
    const result = await sendDirectUserEmail({
      toEmail: receiverEmail,
      ccEmails: cc.map((c) => c.email),
      toName: receiverName,
      fromName: senderName,
      fromEmail: senderEmail,
      subject,
      body,
      inReplyTo,
      references,
      quoted,
      attachments: mailAttachments,
    });

    log.status = "sent";
    log.sentAt = new Date();
    log.messageId = result?.messageId;
    // Carry the ancestor chain forward (without this log's own
    // messageId — the next reply appends that itself from `parent.messageId`),
    // so References always accumulates correctly down the thread.
    log.references = references;
    await log.save();

    await AuditLog.create({
      actorId: senderId,
      action: "email_sent",
      targetUserId: receiverId,
      supervisorIdAtTime: supervisorId,
      details: { toEmail: receiverEmail, subject },
      ipAddress,
      userAgent,
    });
  } catch (err: any) {
    log.status = "failed";
    log.error = err?.message || "Unknown email error";
    await log.save();

    await AuditLog.create({
      actorId: senderId,
      action: "email_failed",
      targetUserId: receiverId,
      supervisorIdAtTime: supervisorId,
      details: { toEmail: receiverEmail, subject, error: log.error },
      ipAddress,
      userAgent,
    });

    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════
// ANNOUNCEMENT ("send to everyone")
// ═════════════════════════════════════════════════════════════════
export interface BroadcastRecipient {
  _id: string;
  email: string;
}

export async function sendBroadcastEmail({
  senderId,
  senderName,
  senderEmail,
  recipients,
  subject,
  body,
  attachments,
  mailAttachments,
  ipAddress,
  userAgent,
  supervisorId,
}: {
  senderId: string;
  senderName?: string;
  senderEmail?: string;
  recipients: BroadcastRecipient[];
  subject: string;
  body: string;
  attachments?: IEmailAttachment[];
  mailAttachments?: MailAttachment[];
  ipAddress?: string;
  userAgent?: string;
  supervisorId?: unknown;
}) {
  const now = new Date();
  const broadcastId = new mongoose.Types.ObjectId();

  // One log per recipient so each person gets their own inbox copy,
  // read state and reply thread. Only the first ("lead") is listed in
  // the sender's Sent view.
  await EmailLog.insertMany(
    recipients.map((r, i) => ({
      senderId,
      receiverId: r._id,
      toEmail: r.email,
      subject,
      body,
      bodyPreview: body.slice(0, 200),
      status: "pending",
      lastMessageAt: now,
      attachments: attachments?.length ? attachments : undefined,
      broadcastId,
      broadcastLead: i === 0,
      broadcastRecipientCount: recipients.length,
    })),
  );

  let sent = 0;
  let failed = 0;
  let firstError: string | undefined;

  // Anchor address for the visible "To:" — recipients are all BCC'd.
  const anchor = senderEmail || process.env.SMTP_USER || "";

  for (let i = 0; i < recipients.length; i += BROADCAST_BATCH_SIZE) {
    const batch = recipients.slice(i, i + BROADCAST_BATCH_SIZE);
    const ids = batch.map((r) => r._id);
    try {
      const result = await sendDirectUserEmail({
        toEmail: anchor,
        bccEmails: batch.map((r) => r.email),
        fromName: senderName,
        fromEmail: senderEmail,
        subject,
        body,
        attachments: mailAttachments,
        broadcast: true,
      });
      await EmailLog.updateMany(
        { broadcastId, receiverId: { $in: ids } },
        { status: "sent", sentAt: new Date(), messageId: result?.messageId },
      );
      sent += batch.length;
    } catch (err: any) {
      const reason = err?.message || "Unknown email error";
      firstError ??= reason;
      await EmailLog.updateMany(
        { broadcastId, receiverId: { $in: ids } },
        { status: "failed", error: reason },
      );
      failed += batch.length;
    }
  }

  await AuditLog.create({
    actorId: senderId,
    action: "email_broadcast_sent",
    supervisorIdAtTime: supervisorId,
    details: { subject, recipientCount: recipients.length, sent, failed },
    ipAddress,
    userAgent,
  });

  return { broadcastId, total: recipients.length, sent, failed, firstError };
}
