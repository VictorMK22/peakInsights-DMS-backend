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
    // 2. send email
    const result = await sendDirectUserEmail({
      toEmail: receiverEmail,
      toName: receiverName,
      fromName: senderName,
      fromEmail: senderEmail,
      subject,
      body,
    });

    // 3. mark success
    await EmailLog.findByIdAndUpdate(log._id, {
      status: 'sent',
      sentAt: new Date(),
      messageId: result?.messageId,
    });

    // 4. audit success
    await AuditLog.create({
      actorId: senderId,
      action: 'email_sent',
      targetUserId: receiverId,
      supervisorIdAtTime: supervisorId,
      details: { toEmail: receiverEmail, subject },
      ipAddress,
      userAgent,
    });

    return { success: true, logId: log._id, messageId: result?.messageId };

  } catch (err: any) {

    // 5. mark failure
    await EmailLog.findByIdAndUpdate(log._id, {
      status: 'failed',
      error: err.message,
    });

    // 6. audit failure
    await AuditLog.create({
      actorId: senderId,
      action: 'email_failed',
      targetUserId: receiverId,
      supervisorIdAtTime: supervisorId,
      details: { toEmail: receiverEmail, subject, error: err.message },
      ipAddress,
      userAgent,
    });

    throw err;
  }
}