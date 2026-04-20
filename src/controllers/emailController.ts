
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';

import { sendTrackedEmail } from '../services/emailWorkflowService';
import { canSendTo } from './messageController';
import { User } from '../models/User';
import { EmailLog } from '../models/EmailLog';
import { sendDirectUserEmail } from '../services/emailService';

// =====================================================
// 📧 SEND DIRECT EMAIL
// Allows users to compose and send a real email to any
// contact's registered email address, directly from the
// PeakInsights interface. Uses the same SMTP transport
// as the notification emails but the sender controls the
// subject and body.
//
// RBAC: follows the same rules as sendMessage — a user
// can only email their supervisor; a supervisor can email
// their team + CEO; CEO can email anyone.
// =====================================================

export const sendEmailDirect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {

    const senderId = req.user!.userId;
    const senderRole = req.user!.role;

    const { receiverId, subject, body } = req.body;

    if (!receiverId || !body?.trim()) {
      return res.status(400).json({ success: false, message: 'receiverId and body required' });
    }

    const { allowed, message } = await canSendTo(senderId, senderRole, receiverId);
    if (!allowed) return res.status(403).json({ success: false, message });

    const [sender, receiver] = await Promise.all([
      User.findById(senderId).select('name email supervisorId').lean(),
      User.findById(receiverId).select('name email').lean(),
    ]);

    if (!receiver?.email) {
      return res.status(404).json({ success: false, message: 'Recipient not found' });
    }

    sendTrackedEmail({
      senderId,
      receiverId,
      receiverEmail: receiver.email,
      receiverName: receiver.name,
      senderName: sender?.name,
      senderEmail: sender?.email,
      subject: subject?.trim() || '(No subject)',
      body: body.trim(),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      supervisorId: sender?.supervisorId,
    }).catch(err => {
      console.error('Background email failed:', err);
    });

    return res.json({
      success: true,
      message: `Email queued to ${receiver.name}`,
    });

  } catch (err) {
    next(err);
  }
};

export const getSentEmails = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const emails = await EmailLog.find({ senderId: userId })
      .populate('receiverId', 'name email role')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({
      success: true,
      data: { emails },
    });
  } catch (err) {
    next(err);
  }
};

export const retryEmail = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const email = await EmailLog.findById(id)
      .populate('senderId receiverId');

    if (!email) {
      return res.status(404).json({ success: false, message: 'Email not found' });
    }

    if (email.status !== 'failed') {
      return res.status(400).json({ success: false, message: 'Only failed emails can be retried' });
    }

    const result = await sendDirectUserEmail({
      toEmail: email.toEmail,
      toName: (email.receiverId as any).name,
      fromName: 'PeakInsights',
      subject: email.subject,
      body: email.body,
    });

    await EmailLog.findByIdAndUpdate(id, {
      status: 'sent',
      error: null,
      sentAt: new Date(),
      messageId: result?.messageId,
    });

    res.json({ success: true, message: 'Email retried successfully' });

  } catch (err) {
    next(err);
  }
};


export const getEmailAnalytics = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const match = req.user?.role === 'ceo'
      ? {}
      : { senderId: req.user!.userId };

    const stats = await EmailLog.aggregate([
      { $match: match },

      {
        $facet: {
          statusBreakdown: [
            { $group: { _id: '$status', count: { $sum: 1 } } }
          ],

          volumeOverTime: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m", date: "$createdAt" }
                },
                sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
              }
            },
            { $sort: { _id: 1 } }
          ],

          topSenders: [
            {
              $group: {
                _id: "$senderId",
                total: { $sum: 1 },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }
              }
            },
            { $sort: { total: -1 } },
            { $limit: 10 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user"
              }
            },
            { $unwind: "$user" }
          ],

          failureRate: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }
              }
            },
            {
              $project: {
                failureRate: {
                  $divide: ["$failed", "$total"]
                }
              }
            }
          ]
        }
      }
    ]);

    res.json({
      success: true,
      data: stats[0]
    });

  } catch (err) {
    next(err);
  }
};