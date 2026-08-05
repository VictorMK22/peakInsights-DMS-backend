import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";

import { sendTrackedEmail } from "../services/emailWorkflowService";
import { canSendTo } from "./messageController";
import { User } from "../models/User";
import { EmailLog } from "../models/EmailLog";
import { sendDirectUserEmail } from "../services/emailService";

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

export const sendEmailDirect = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const senderId = req.user!.userId;
    const senderRole = req.user!.role;

    const { receiverId: bodyReceiverId, subject, body, parentId } = req.body;

    if (!body?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "body is required" });
    }

    // The actual recipient. For a reply, this is ALWAYS derived from
    // the parent thread server-side — never trust the client-supplied
    // receiverId, or anyone in a thread could redirect a "reply" to a
    // third party and bypass canSendTo entirely. Same rule sendMessage
    // already follows for Messages.
    let receiverId = bodyReceiverId;

    if (parentId) {
      const parent = await EmailLog.findById(parentId).select(
        "senderId receiverId",
      );
      if (!parent) {
        return res
          .status(404)
          .json({ success: false, message: "Parent email not found" });
      }
      const isParticipant =
        parent.senderId.toString() === senderId ||
        parent.receiverId.toString() === senderId;
      if (!isParticipant) {
        return res
          .status(403)
          .json({ success: false, message: "Not part of this conversation" });
      }
      receiverId = (
        parent.senderId.toString() === senderId
          ? parent.receiverId
          : parent.senderId
      ).toString();
    } else {
      if (!receiverId) {
        return res
          .status(400)
          .json({ success: false, message: "receiverId and body required" });
      }
      const { allowed, message } = await canSendTo(
        senderId,
        senderRole,
        receiverId,
      );
      if (!allowed) return res.status(403).json({ success: false, message });
    }

    const [sender, receiver] = await Promise.all([
      User.findById(senderId).select("name email supervisorId").lean(),
      User.findById(receiverId).select("name email").lean(),
    ]);

    if (!receiver?.email) {
      return res
        .status(404)
        .json({ success: false, message: "Recipient not found" });
    }

    sendTrackedEmail({
      senderId,
      receiverId,
      receiverEmail: receiver.email,
      receiverName: receiver.name,
      senderName: sender?.name,
      senderEmail: sender?.email,
      subject: subject?.trim() || "(No subject)",
      body: body.trim(),
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      supervisorId: sender?.supervisorId,
      parentId: parentId || undefined,
    }).catch((err) => {
      console.error("Background email failed:", err);
    });

    return res.json({
      success: true,
      message: parentId
        ? `Reply queued to ${receiver.name}`
        : `Email queued to ${receiver.name}`,
    });
  } catch (err) {
    next(err);
    return;
  }
};

// ── Shared pagination helper — mirrors messageController's ──────────
const parsePage = (q: Record<string, string>) => ({
  page: Math.max(1, parseInt(q.page ?? "1", 10)),
  limit: Math.min(50, parseInt(q.limit ?? "20", 10)),
});

export const getSentEmails = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.userId;
    const { page, limit } = parsePage(req.query as Record<string, string>);
    const skip = (page - 1) * limit;

    const rootFilter = { senderId: userId, parentId: null };

    const [emails, total] = await Promise.all([
      EmailLog.find(rootFilter)
        // senderId is always the current user here (rootFilter pins it),
        // but it still needs populating — the frontend's thread view
        // reads senderId.name/.role generically for BOTH parties (it
        // doesn't special-case "I already know who I am"), so leaving
        // this unpopulated meant otherParty.name.charAt(0) crashed the
        // whole page the moment someone opened one of their own sent
        // emails. getInboxEmails right below already does this correctly.
        .populate("senderId", "name email role")
        .populate("receiverId", "name email role")
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit),
      EmailLog.countDocuments(rootFilter),
    ]);

    res.json({
      success: true,
      data: { emails },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// =====================================================
// 📥 GET INBOX EMAILS
// Mirrors getSentEmails but for the recipient side, so the frontend
// can offer an Inbox view for Emails the same way Messages already
// has an inbox/sent split. Only root emails are returned — replies
// live under their thread and surface via hasUnreadReplies, exactly
// like getInbox does for Messages.
// =====================================================
export const getInboxEmails = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.userId;
    const { page, limit } = parsePage(req.query as Record<string, string>);
    const skip = (page - 1) * limit;

    const rootFilter = {
      $or: [
        { receiverId: userId, parentId: null },
        { senderId: userId, parentId: null },
      ],
    };

    const [emails, total] = await Promise.all([
      EmailLog.find(rootFilter)
        .populate("senderId", "name email role")
        .populate("receiverId", "name email role")
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit),
      EmailLog.countDocuments(rootFilter),
    ]);

    const threadIds = emails.map((e) => e._id);
    const unreadReplyCounts = threadIds.length
      ? await EmailLog.aggregate([
          {
            $match: {
              parentId: { $in: threadIds },
              receiverId: new mongoose.Types.ObjectId(userId),
              isRead: false,
            },
          },
          { $group: { _id: "$parentId", count: { $sum: 1 } } },
        ])
      : [];
    const unreadByThread = new Map(
      unreadReplyCounts.map((r) => [r._id.toString(), r.count]),
    );
    const emailsWithUnread = emails.map((e) => ({
      ...e.toObject(),
      hasUnreadReplies: (unreadByThread.get(e._id.toString()) ?? 0) > 0,
    }));

    res.json({
      success: true,
      data: { emails: emailsWithUnread },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// =====================================================
// 🧵 GET EMAIL THREAD
// Returns the root email plus its paginated replies (oldest first),
// exactly mirroring getThread for Messages.
// =====================================================
export const getEmailThread = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;
    const { page, limit } = parsePage(req.query as Record<string, string>);
    const skip = (page - 1) * limit;

    const parent = await EmailLog.findById(id)
      .populate("senderId", "name email role")
      .populate("receiverId", "name email role");

    if (!parent) {
      return res
        .status(404)
        .json({ success: false, message: "Email not found" });
    }

    const isParticipant =
      (parent.senderId as any)._id.toString() === userId ||
      (parent.receiverId as any)._id.toString() === userId;
    if (!isParticipant) {
      return res
        .status(403)
        .json({ success: false, message: "Not part of this conversation" });
    }

    const [replies, totalReplies] = await Promise.all([
      EmailLog.find({ parentId: id })
        .populate("senderId", "name email role")
        .populate("receiverId", "name email role")
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit),
      EmailLog.countDocuments({ parentId: id }),
    ]);

    res.json({
      success: true,
      data: { parent, replies },
      pagination: {
        page,
        limit,
        total: totalReplies,
        totalPages: Math.ceil(totalReplies / limit),
      },
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
};

// =====================================================
// ✅ MARK EMAIL READ
// Only the recipient can mark their own inbox email as read.
// =====================================================
export const markEmailRead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const email = await EmailLog.findById(id).select(
      "receiverId isRead readAt",
    );
    if (!email) {
      return res
        .status(404)
        .json({ success: false, message: "Email not found" });
    }
    if (email.receiverId.toString() !== userId) {
      return res
        .status(403)
        .json({ success: false, message: "Not your email" });
    }

    email.isRead = true;
    email.readAt = new Date();
    await email.save();

    res.json({ success: true });
    return;
  } catch (err) {
    next(err);
    return;
  }
};

// =====================================================
// 🔢 UNREAD EMAIL COUNT
// Used to drive the sidebar badge on the (now-separate) Emails page,
// same pattern as Messages' unread-count.
// =====================================================
export const getUnreadEmailCount = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const count = await EmailLog.countDocuments({
      receiverId: req.user!.userId,
      isRead: false,
    });
    res.json({ success: true, data: { unreadCount: count } });
  } catch (err) {
    next(err);
  }
};

export const retryEmail = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;

    const email = await EmailLog.findById(id).populate("senderId receiverId");

    if (!email) {
      return res
        .status(404)
        .json({ success: false, message: "Email not found" });
    }

    if (email.status !== "failed") {
      return res
        .status(400)
        .json({ success: false, message: "Only failed emails can be retried" });
    }

    const result = await sendDirectUserEmail({
      toEmail: email.toEmail,
      toName: (email.receiverId as any).name,
      fromName: "PeakInsights",
      subject: email.subject,
      body: email.body,
    });

    await EmailLog.findByIdAndUpdate(id, {
      status: "sent",
      error: null,
      sentAt: new Date(),
      messageId: result?.messageId,
    });

    res.json({ success: true, message: "Email retried successfully" });
    return;
  } catch (err) {
    next(err);
    return;
  }
};

export const getEmailAnalytics = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const match =
      req.user?.role === "ceo" || req.user?.role === "tech"
        ? {}
        : { senderId: req.user!.userId };

    const stats = await EmailLog.aggregate([
      { $match: match },

      {
        $facet: {
          statusBreakdown: [{ $group: { _id: "$status", count: { $sum: 1 } } }],

          volumeOverTime: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m", date: "$createdAt" },
                },
                sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],

          topSenders: [
            {
              $group: {
                _id: "$senderId",
                total: { $sum: 1 },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
              },
            },
            { $sort: { total: -1 } },
            { $limit: 10 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
          ],

          failureRate: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
              },
            },
            {
              $project: {
                failureRate: {
                  $divide: ["$failed", "$total"],
                },
              },
            },
          ],
        },
      },
    ]);

    res.json({
      success: true,
      data: stats[0],
    });
  } catch (err) {
    next(err);
  }
};
