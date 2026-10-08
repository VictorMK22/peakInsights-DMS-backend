import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";

import {
  sendTrackedEmail,
  sendBroadcastEmail,
} from "../services/emailWorkflowService";
import {
  storeUploadedAttachments,
  toMailAttachments,
  loadMailAttachments,
  presentAttachments,
  resolveCidImages,
  parseUploadRefs,
  resolveDirectUploads,
  discardDirectUploads,
  createAttachmentUploads,
  allowPresign,
  MAX_DIRECT_FILES,
  MAX_DIRECT_TOTAL_BYTES,
} from "../services/emailAttachmentService";
import { canSendTo } from "./messageController";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { EmailLog } from "../models/EmailLog";
import {
  getDefaultFromAddress,
  sendDirectUserEmail,
} from "../services/emailService";
import { syncMyMailbox } from "../services/emailSyncService";

// Roles allowed to email EVERYONE — every role by default, so anyone can
// share general information with the whole company. To restrict it, set
// EMAIL_BROADCAST_ROLES (comma-separated), e.g. "ceo,tech,supervisor".
const BROADCAST_ROLES = (
  process.env.EMAIL_BROADCAST_ROLES ??
  "ceo,tech,supervisor,sales_person,accountant"
)
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const uploadedFiles = (req: AuthRequest) =>
  (req.files as Express.Multer.File[] | undefined) ?? [];

/**
 * Who may be emailed one-to-one. Same rules as Messages (canSendTo) with one
 * addition for email: any staff member may also email the CEO, on top of
 * their own supervisor. Messages keeps its stricter rule untouched.
 */
const canEmail = async (
  senderId: string,
  senderRole: string,
  receiverId: string,
) => {
  const base = await canSendTo(senderId, senderRole, receiverId);
  if (base.allowed) return base;
  const receiver = await User.findById(receiverId).select("role isActive");
  if (receiver?.isActive && receiver.role === "ceo") return { allowed: true };
  return base;
};

/**
 * Gathers everything attached to this request: files uploaded in-body
 * (small, multipart) and files the browser already put in S3 (direct).
 * Call only AFTER the request has passed validation.
 */
const collectAttachments = async (req: AuthRequest) => {
  const userId = req.user!.userId;
  const files = uploadedFiles(req);
  const direct = await resolveDirectUploads(
    userId,
    parseUploadRefs(req.body?.uploads),
  );
  const multipart = files.length ? await storeUploadedAttachments(files) : [];

  const total = [...multipart, ...direct].reduce(
    (sum, a) => sum + (a.size ?? 0),
    0,
  );
  if (total > MAX_DIRECT_TOTAL_BYTES) {
    await discardDirectUploads(userId, parseUploadRefs(req.body?.uploads));
    const err: any = new Error(
      `Attachments can total at most ${Math.round(MAX_DIRECT_TOTAL_BYTES / 1024 / 1024)} MB`,
    );
    err.statusCode = 400;
    throw err;
  }

  const attachments = [...multipart, ...direct];
  const mailAttachments = [
    ...toMailAttachments(files),
    ...(await loadMailAttachments(direct)),
  ];
  return {
    attachments: attachments.length ? attachments : undefined,
    mailAttachments: mailAttachments.length ? mailAttachments : undefined,
  };
};

/** ccIds can arrive as an array (JSON), a JSON string, or one id (multipart). */
const parseIdList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
    } catch {
      return [v];
    }
  }
  return [];
};

/** One announcement = one row: hide every broadcast copy except the lead. */
const notBroadcastDuplicate = {
  $or: [{ broadcastId: { $exists: false } }, { broadcastLead: true }],
};

/** Shapes an email for the API. Thread views get signed URLs + resolved inline images. */
const serializeEmail = (e: any, full = false) => {
  const obj = typeof e.toObject === "function" ? e.toObject() : e;
  const attachments = presentAttachments(obj.attachments, obj.body);
  return {
    ...obj,
    body: full ? resolveCidImages(obj.body, obj.attachments) : obj.body,
    attachments: full
      ? attachments
      : attachments.map(
          ({ _id, filename, mimeType, size, isImage, inline }) => ({
            _id,
            filename,
            mimeType,
            size,
            isImage,
            inline,
          }),
        ),
  };
};

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

    // Anything the browser already uploaded straight to S3 is deleted if this
    // request is rejected, so failed sends don't leave orphan files behind.
    const uploadRefs = parseUploadRefs(req.body?.uploads);
    const bail = async (status: number, message: string) => {
      await discardDirectUploads(senderId, uploadRefs);
      return res.status(status).json({ success: false, message });
    };

    const {
      receiverId: bodyReceiverId,
      subject,
      body,
      parentId,
      ccIds: bodyCcIdsRaw,
    } = req.body;
    const bodyCcIds = parseIdList(bodyCcIdsRaw);

    if (!body?.trim()) {
      return bail(400, "body is required");
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
        return bail(404, "Parent email not found");
      }
      const isParticipant =
        parent.senderId.toString() === senderId ||
        parent.receiverId.toString() === senderId;
      if (!isParticipant) {
        return bail(403, "Not part of this conversation");
      }
      receiverId = (
        parent.senderId.toString() === senderId
          ? parent.receiverId
          : parent.senderId
      ).toString();
    } else {
      if (!receiverId) {
        return bail(400, "receiverId and body required");
      }
      const { allowed, message } = await canEmail(
        senderId,
        senderRole,
        receiverId,
      );
      if (!allowed) return bail(403, message ?? "Not allowed");
    }

    const [sender, receiver] = await Promise.all([
      User.findById(senderId).select("name email supervisorId").lean(),
      User.findById(receiverId).select("name email").lean(),
    ]);

    if (!receiver?.email) {
      return bail(404, "Recipient not found");
    }

    // ── CC ────────────────────────────────────────────────────────
    // Every CC'd person goes through the SAME canSendTo gate as the
    // main recipient — CC must not become a way around the RBAC rules.
    const rawCc: string[] = Array.isArray(bodyCcIds)
      ? [...new Set(bodyCcIds.map(String))]
      : [];
    const ccFiltered = rawCc.filter(
      (id) =>
        mongoose.Types.ObjectId.isValid(id) &&
        id !== senderId &&
        id !== String(receiverId),
    );
    if (ccFiltered.length > 10) {
      return bail(400, "You can CC at most 10 people");
    }
    for (const ccId of ccFiltered) {
      const { allowed, message } = await canEmail(senderId, senderRole, ccId);
      if (!allowed) {
        return bail(403, `Cannot CC this person: ${message}`);
      }
    }
    const ccUsers = ccFiltered.length
      ? (
          await User.find({ _id: { $in: ccFiltered } })
            .select("name email")
            .lean()
        )
          .filter((u) => !!u.email)
          .map((u) => ({ _id: String(u._id), email: u.email as string }))
      : [];

    // IMPORTANT (Vercel): this MUST be awaited. A serverless function
    // is frozen the moment the response is sent, so the old
    // fire-and-forget `sendTrackedEmail(...).catch(...)` was routinely
    // killed mid-SMTP-handshake — leaving emails stuck on "Queued" or
    // marked failed with "SMTP send failed". sendTrackedEmail already
    // records success/failure on the EmailLog, so we just report it.
    // Upload attachments only now that every check has passed, so a
    // rejected email never leaves orphan files in S3.
    const { attachments, mailAttachments } = await collectAttachments(req);

    let delivered = true;
    let failureReason: string | undefined;
    try {
      await sendTrackedEmail({
        senderId,
        receiverId,
        receiverEmail: receiver.email,
        receiverName: receiver.name,
        ccUsers,
        senderName: sender?.name,
        senderEmail: sender?.email,
        subject: subject?.trim() || "(No subject)",
        body: body.trim(),
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        supervisorId: sender?.supervisorId,
        parentId: parentId || undefined,
        attachments,
        mailAttachments,
      });
    } catch (err: any) {
      delivered = false;
      failureReason = err?.message || "Unknown email error";
      console.error("Email send failed:", err);
    }

    return res.json({
      success: true,
      data: { status: delivered ? "sent" : "failed", error: failureReason },
      message: delivered
        ? parentId
          ? `Reply sent to ${receiver.name}`
          : `Email sent to ${receiver.name}`
        : `Saved, but delivery failed: ${failureReason}. Use Retry in Sent.`,
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

    const rootFilter = {
      senderId: userId,
      parentId: null,
      ...notBroadcastDuplicate,
    };

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
        .populate("ccIds", "name email role")
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit),
      EmailLog.countDocuments(rootFilter),
    ]);

    res.json({
      success: true,
      data: { emails: emails.map((e) => serializeEmail(e)) },
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
        // Own sent mail shows up here too — but an announcement only once
        // (the lead copy), plus any recipient copy that got a reply so the
        // broadcaster can actually see and answer it.
        {
          senderId: userId,
          parentId: null,
          $or: [
            { broadcastId: { $exists: false } },
            { broadcastLead: true },
            { hasReplies: true },
          ],
        },
        { ccIds: userId, parentId: null },
      ],
    };

    const [emails, total] = await Promise.all([
      EmailLog.find(rootFilter)
        .populate("senderId", "name email role")
        .populate("receiverId", "name email role")
        .populate("ccIds", "name email role")
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
      ...serializeEmail(e),
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
      .populate("receiverId", "name email role")
      .populate("ccIds", "name email role");

    if (!parent) {
      return res
        .status(404)
        .json({ success: false, message: "Email not found" });
    }

    const isParticipant =
      (parent.senderId as any)._id.toString() === userId ||
      (parent.receiverId as any)._id.toString() === userId ||
      ((parent.ccIds as any[]) ?? []).some(
        (c) => String(c?._id ?? c) === userId,
      );
    if (!isParticipant) {
      return res
        .status(403)
        .json({ success: false, message: "Not part of this conversation" });
    }

    const [replies, totalReplies] = await Promise.all([
      EmailLog.find({ parentId: id })
        .populate("senderId", "name email role")
        .populate("receiverId", "name email role")
        .populate("ccIds", "name email role")
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit),
      EmailLog.countDocuments({ parentId: id }),
    ]);

    res.json({
      success: true,
      data: {
        parent: serializeEmail(parent, true),
        replies: replies.map((r) => serializeEmail(r, true)),
      },
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

    // Only the original sender (or CEO) may retry — previously any
    // logged-in user who guessed an id could re-fire someone's email.
    const retrier = req.user!;
    const senderOwnerId = String(
      (email.senderId as any)?._id ?? email.senderId,
    );
    if (retrier.role !== "ceo" && senderOwnerId !== retrier.userId) {
      return res
        .status(403)
        .json({ success: false, message: "Not your email" });
    }

    if (email.status !== "failed") {
      return res
        .status(400)
        .json({ success: false, message: "Only failed emails can be retried" });
    }

    // Announcement: retry every copy that failed, in one BCC send.
    if (email.broadcastId) {
      const failedCopies = await EmailLog.find({
        broadcastId: email.broadcastId,
        status: "failed",
      }).select("_id toEmail");
      try {
        const result = await sendDirectUserEmail({
          toEmail:
            (email.senderId as any)?.email || getDefaultFromAddress(),
          bccEmails: failedCopies.map((c) => c.toEmail),
          fromName: (email.senderId as any)?.name ?? "PeakInsights",
          fromEmail: (email.senderId as any)?.email,
          subject: email.subject,
          body: email.body,
          attachments: await loadMailAttachments(email.attachments),
          broadcast: true,
        });
        await EmailLog.updateMany(
          { _id: { $in: failedCopies.map((c) => c._id) } },
          {
            status: "sent",
            error: null,
            sentAt: new Date(),
            messageId: result?.messageId,
          },
        );
        res.json({
          success: true,
          message: `Announcement re-sent to ${failedCopies.length} recipient(s)`,
        });
        return;
      } catch (sendErr: any) {
        const reason = sendErr?.message || "Unknown email error";
        await EmailLog.updateMany(
          { _id: { $in: failedCopies.map((c) => c._id) } },
          { error: reason },
        );
        return res
          .status(502)
          .json({ success: false, message: `Retry failed: ${reason}` });
      }
    }

    let result: { messageId?: string };
    try {
      result = await sendDirectUserEmail({
        toEmail: email.toEmail,
        ccEmails: email.ccEmails ?? undefined,
        toName: (email.receiverId as any).name,
        fromName: (email.senderId as any)?.name ?? "PeakInsights",
        fromEmail: (email.senderId as any)?.email,
        subject: email.subject,
        body: email.body,
        attachments: await loadMailAttachments(email.attachments),
      });
    } catch (sendErr: any) {
      const reason = sendErr?.message || "Unknown email error";
      await EmailLog.findByIdAndUpdate(id, { error: reason });
      return res.status(502).json({
        success: false,
        message: `Retry failed: ${reason}`,
      });
    }

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

// =====================================================
// 🔄 SYNC NOW
// Pulls the caller's own connected mailbox immediately instead of
// waiting for the next scheduled run. Throttled per user so the button
// can't hammer the mail provider.
// =====================================================
const lastManualSync = new Map<string, number>();
const MANUAL_SYNC_COOLDOWN_MS = 20_000;

export const syncEmailsNow = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.userId;
    const last = lastManualSync.get(userId) ?? 0;
    if (Date.now() - last < MANUAL_SYNC_COOLDOWN_MS) {
      return res.json({
        success: true,
        data: { throttled: true, connected: true },
        message: "Just synced — try again in a few seconds",
      });
    }
    lastManualSync.set(userId, Date.now());

    const result = await syncMyMailbox(userId);
    if (!result) {
      return res.json({
        success: true,
        data: { connected: false },
        message: "No mailbox connected — connect Zoho in your profile to sync",
      });
    }
    return res.json({
      success: true,
      data: { connected: true, ...result },
      message: `Synced — ${result.messagesSynced} new email(s)`,
    });
  } catch (err) {
    next(err);
    return;
  }
};

// =====================================================
// 📣 ANNOUNCEMENT AUDIENCE
// Tells the compose screen whether to offer "Send to everyone"
// and how many people it would reach.
// =====================================================
const getBroadcastAudienceUsers = (senderId: string) =>
  User.find({
    _id: { $ne: senderId },
    isActive: true,
    email: { $exists: true, $ne: "" },
  })
    .select("name email")
    .lean();

export const getBroadcastAudience = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const allowed = BROADCAST_ROLES.includes(req.user!.role);
    const recipientCount = allowed
      ? await User.countDocuments({
          _id: { $ne: req.user!.userId },
          isActive: true,
          email: { $exists: true, $ne: "" },
        })
      : 0;
    res.json({ success: true, data: { allowed, recipientCount } });
  } catch (err) {
    next(err);
  }
};

// =====================================================
// 📣 SEND TO EVERYONE
// General information for all users. Each person gets their own
// inbox copy (so they can read, and reply privately to the sender);
// delivery is one BCC email per batch so addresses aren't exposed.
// =====================================================
// Announcements per user per hour. Keeps one person from flooding everyone —
// and from getting the shared SMTP account flagged. 0 disables the limit.
const BROADCAST_MAX_PER_HOUR = Number(
  process.env.EMAIL_BROADCAST_MAX_PER_HOUR ?? 10,
);

export const sendBroadcast = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const senderId = req.user!.userId;
    const uploadRefs = parseUploadRefs(req.body?.uploads);
    const bail = async (status: number, message: string) => {
      await discardDirectUploads(senderId, uploadRefs);
      return res.status(status).json({ success: false, message });
    };
    if (!BROADCAST_ROLES.includes(req.user!.role)) {
      return bail(403, "You are not allowed to email all users");
    }

    const { subject, body } = req.body;
    if (!subject?.trim() || !body?.trim()) {
      return bail(400, "Subject and message are required");
    }

    if (BROADCAST_MAX_PER_HOUR > 0) {
      const recent = await EmailLog.countDocuments({
        senderId,
        broadcastLead: true,
        createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
      });
      if (recent >= BROADCAST_MAX_PER_HOUR) {
        return bail(
          429,
          `You can send at most ${BROADCAST_MAX_PER_HOUR} announcements per hour`,
        );
      }
    }

    const [sender, users] = await Promise.all([
      User.findById(senderId).select("name email supervisorId").lean(),
      getBroadcastAudienceUsers(senderId),
    ]);
    if (users.length === 0) {
      return bail(400, "There is nobody to send this to");
    }

    const { attachments, mailAttachments } = await collectAttachments(req);

    const result = await sendBroadcastEmail({
      senderId,
      senderName: sender?.name,
      senderEmail: sender?.email,
      recipients: users.map((u) => ({
        _id: String(u._id),
        email: u.email as string,
      })),
      subject: subject.trim(),
      body: body.trim(),
      attachments,
      mailAttachments,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      supervisorId: sender?.supervisorId,
    });

    const allFailed = result.sent === 0;
    return res.json({
      success: true,
      data: {
        status: allFailed ? "failed" : result.failed ? "partial" : "sent",
        total: result.total,
        sent: result.sent,
        failed: result.failed,
        error: result.firstError,
      },
      message: allFailed
        ? `Saved, but delivery failed: ${result.firstError}. Use Retry in Sent.`
        : result.failed
          ? `Sent to ${result.sent} of ${result.total} people — ${result.failed} failed. Use Retry in Sent.`
          : `Announcement sent to ${result.total} people`,
    });
  } catch (err) {
    next(err);
    return;
  }
};

// =====================================================
// 📎 DIRECT-TO-S3 ATTACHMENT UPLOADS
// Step 1 of 2: the browser asks for upload slots, PUTs the files straight to
// S3, then sends the email with the returned references (`uploads`).
// =====================================================
export const getAttachmentLimits = (_req: AuthRequest, res: Response) => {
  res.json({
    success: true,
    data: {
      maxFiles: MAX_DIRECT_FILES,
      maxTotalBytes: MAX_DIRECT_TOTAL_BYTES,
    },
  });
};

export const presignAttachmentUploads = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!allowPresign(req.user!.userId)) {
      return res.status(429).json({
        success: false,
        message: "Too many upload requests — try again in a few minutes",
      });
    }
    const uploads = await createAttachmentUploads(
      req.user!.userId,
      req.body?.files,
    );
    return res.json({ success: true, data: { uploads } });
  } catch (err) {
    next(err);
    return;
  }
};

// =====================================================
// 👥 EMAIL CONTACTS
// People the caller can email one-to-one. Matches canEmail: admins see
// everyone, supervisors see their team + admins, and every other staff
// role sees their supervisor AND the CEO.
// =====================================================
export const getEmailContacts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const fields = "_id name email role profilePicture department";
    let contacts: any[] = [];

    if (role === "ceo" || role === "tech") {
      contacts = await User.find({ _id: { $ne: userId }, isActive: true })
        .select(fields)
        .lean();
    } else if (role === "supervisor") {
      const [mappings, admins] = await Promise.all([
        SupervisorMapping.find({ supervisorId: userId, status: "active" })
          .populate("subordinateId", fields)
          .lean(),
        User.find({ role: { $in: ["ceo", "tech"] }, isActive: true })
          .select(fields)
          .lean(),
      ]);
      contacts = [...admins, ...mappings.map((m: any) => m.subordinateId)];
    } else {
      const [mapping, ceos] = await Promise.all([
        SupervisorMapping.findOne({ subordinateId: userId, status: "active" })
          .populate("supervisorId", fields)
          .lean(),
        User.find({ role: "ceo", isActive: true }).select(fields).lean(),
      ]);
      contacts = [
        ...(mapping?.supervisorId ? [mapping.supervisorId] : []),
        ...ceos,
      ];
    }

    // De-duplicate (a supervisor can also be the CEO's report, etc.) and drop self.
    const seen = new Set<string>();
    const unique = contacts.filter((c) => {
      if (!c?._id) return false;
      const id = String(c._id);
      if (id === userId || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    res.json({ success: true, data: { contacts: unique } });
  } catch (err) {
    next(err);
  }
};