import { EmailLog } from "../models/EmailLog";
import { sendDirectUserEmail } from "./emailService";
import { AuditLog } from "../models/AuditLog";

export async function sendTrackedEmail({
  senderId,
  receiverId,
  receiverEmail,
  receiverName,
  senderName,
  senderEmail,
  subject,
  body,
  ipAddress,
  userAgent,
  supervisorId,
  parentId,
}: any) {
  const now = new Date();

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
    subject,
    body,
    bodyPreview: body.slice(0, 200),
    status: "pending",
    parentId: parentId || undefined,
    lastMessageAt: now,
  });

  // A reply landed — bump the root thread's lastMessageAt so the
  // conversation resurfaces to the top of the inbox/sent list, same
  // as Messages does.
  if (parentId) {
    await EmailLog.findByIdAndUpdate(parentId, { lastMessageAt: now });
  }

  try {
    const result = await sendDirectUserEmail({
      toEmail: receiverEmail,
      toName: receiverName,
      fromName: senderName,
      fromEmail: senderEmail,
      subject,
      body,
      inReplyTo,
      references,
      quoted,
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
