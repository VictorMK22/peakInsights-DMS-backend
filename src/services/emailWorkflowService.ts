import { EmailLog } from '../models/EmailLog';
import { sendDirectUserEmail } from './emailService';
import { AuditLog } from '../models/AuditLog';

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
}: any) {

  // 1. create log FIRST
  const log = await EmailLog.create({
    senderId,
    receiverId,
    toEmail: receiverEmail,
    subject,
    body,
    bodyPreview: body.slice(0, 200),
    status: 'pending',
  });

  try {
    const result = await sendDirectUserEmail({
      toEmail: receiverEmail,
      toName: receiverName,
      fromName: senderName,
      fromEmail: senderEmail,
      subject,
      body,
    });

    log.status = 'sent';
    log.sentAt = new Date();
    log.messageId = result?.messageId;
    await log.save();

    await AuditLog.create({
      actorId: senderId,
      action: 'email_sent',
      targetUserId: receiverId,
      supervisorIdAtTime: supervisorId,
      details: { toEmail: receiverEmail, subject },
      ipAddress,
      userAgent,
    });

  } catch (err: any) {

    log.status = 'failed';
    log.error = err?.message || 'Unknown email error';
    await log.save();

    await AuditLog.create({
      actorId: senderId,
      action: 'email_failed',
      targetUserId: receiverId,
      supervisorIdAtTime: supervisorId,
      details: { toEmail: receiverEmail, subject, error: log.error },
      ipAddress,
      userAgent,
    });

    throw err;
  }
}