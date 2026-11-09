import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { MessageModel } from "../models/Message";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { createNotification } from "../services/notificationService";
import { sendNewMessageEmail } from "../services/emailService";
import { getIO } from "../socket/socketServer";
import { waitUntil } from "@vercel/functions";

export const canSendTo = async (
  senderId: string,
  senderRole: string,
  receiverId: string,
) => {
  const receiver = await User.findById(receiverId).select("role isActive");
  if (!receiver || !receiver.isActive)
    return { allowed: false, message: "Recipient not found or inactive" };
  if (senderRole === "ceo" || senderRole === "tech") return { allowed: true };
  if (senderRole === "supervisor") {
    if (receiver.role === "ceo" || receiver.role === "tech")
      return { allowed: true };
    // Any staff role (sales_person, accountant, or a tech/accountant
    // assigned under this supervisor) can be a subordinate — there's
    // no single "normal user" role anymore, so the mapping itself
    // (not the receiver's specific role) is what decides this.
    const mapping = await SupervisorMapping.findOne({
      supervisorId: senderId,
      subordinateId: receiverId,
      status: "active",
    });
    if (mapping) return { allowed: true };
    return { allowed: false, message: "You can only message your team or CEO" };
  }
  // Every other staff role (sales_person, accountant — tech already
  // bypassed above) can only message the supervisor they're mapped to.
  const mapping = await SupervisorMapping.findOne({
    subordinateId: senderId,
    supervisorId: receiverId,
    status: "active",
  });
  if (mapping) return { allowed: true };
  return { allowed: false, message: "You can only message your supervisor" };
};

// Roles allowed to message EVERYONE. Mirrors the email setting: every role by
// default; restrict with MESSAGE_BROADCAST_ROLES (falls back to
// EMAIL_BROADCAST_ROLES), e.g. "ceo,tech,supervisor".
const BROADCAST_ROLES = (
  process.env.MESSAGE_BROADCAST_ROLES ??
  process.env.EMAIL_BROADCAST_ROLES ??
  "ceo,tech,supervisor,sales_person,accountant"
)
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const GROUP_MAX_RECIPIENTS = Number(
  process.env.MESSAGE_GROUP_MAX_RECIPIENTS ?? 50,
);
const BROADCAST_MAX_PER_HOUR = Number(
  process.env.MESSAGE_BROADCAST_MAX_PER_HOUR ?? 10,
);

// Sender-side list filter: hide the extra per-recipient copies of a group
// send (keep the lead), but still surface any copy somebody replied to.
const hideBroadcastCopies = {
  $or: [
    { broadcastId: { $exists: false } },
    { broadcastLead: true },
    { hasReplies: true },
  ],
};
// "Sent" shows only what I sent — one entry per group send.
const sentOnlyOnce = {
  $or: [{ broadcastId: { $exists: false } }, { broadcastLead: true }],
};

const parseIds = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((v) => String(v).trim())
        .filter((v) => mongoose.Types.ObjectId.isValid(v)),
    ),
  ];
};

/** Group send: audience "selected" (recipientIds) or "everyone". */
const sendGroupMessage = async (
  req: AuthRequest,
  res: Response,
  audience: "selected" | "everyone",
) => {
  const senderId = req.user!.userId;
  const senderRole = req.user!.role;
  const { subject, body } = req.body;

  let recipients: { _id: any; name: string; email?: string }[] = [];

  if (audience === "everyone") {
    if (!BROADCAST_ROLES.includes(senderRole)) {
      return res
        .status(403)
        .json({ success: false, message: "You are not allowed to message all users" });
    }
    recipients = await User.find({ _id: { $ne: senderId }, isActive: true })
      .select("name email")
      .lean();
  } else {
    const ids = parseIds(req.body.recipientIds).filter((id) => id !== senderId);
    if (ids.length < 2)
      return res
        .status(400)
        .json({ success: false, message: "Select at least two people" });
    if (GROUP_MAX_RECIPIENTS > 0 && ids.length > GROUP_MAX_RECIPIENTS)
      return res.status(400).json({
        success: false,
        message: `You can message at most ${GROUP_MAX_RECIPIENTS} people at once`,
      });
    const users = await User.find({ _id: { $in: ids }, isActive: true })
      .select("name email")
      .lean();
    if (users.length !== ids.length)
      return res.status(400).json({
        success: false,
        message: "Some selected people were not found or are inactive",
      });
    const checks = await Promise.all(
      users.map(async (u) => ({
        name: u.name,
        ...(await canSendTo(senderId, senderRole, String(u._id))),
      })),
    );
    const denied = checks.filter((c) => !c.allowed).map((c) => c.name);
    if (denied.length)
      return res
        .status(403)
        .json({ success: false, message: `You can't message: ${denied.join(", ")}` });
    recipients = users;
  }

  if (recipients.length === 0)
    return res
      .status(400)
      .json({ success: false, message: "There is nobody to send this to" });

  if (BROADCAST_MAX_PER_HOUR > 0) {
    const recent = await MessageModel.countDocuments({
      senderId,
      broadcastLead: true,
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
    });
    if (recent >= BROADCAST_MAX_PER_HOUR)
      return res.status(429).json({
        success: false,
        message: `You can send at most ${BROADCAST_MAX_PER_HOUR} group messages per hour`,
      });
  }

  const now = new Date();
  const broadcastId = new mongoose.Types.ObjectId();
  const docs = await MessageModel.insertMany(
    recipients.map((r, i) => ({
      senderId,
      receiverId: r._id,
      subject,
      body,
      parentId: null,
      isRead: false,
      lastMessageAt: now,
      broadcastId,
      broadcastLead: i === 0,
      broadcastRecipientCount: recipients.length,
      broadcastAudience: audience,
    })),
  );

  const sender = await User.findById(senderId).select("name email");
  const senderName = sender?.name ?? "Someone";

  // Notify everyone in the background so a big audience can't slow the
  // response; waitUntil keeps it alive on Vercel after we reply.
  const notifyAll = (async () => {
    for (const [i, r] of recipients.entries()) {
      try {
        await createNotification(
          String(r._id),
          `New message from ${senderName}: ${subject ?? body.slice(0, 60)}`,
          "new_message",
          { senderName, messageSubject: subject, messageBody: body },
        );
        try {
          getIO().to(`user:${r._id}`).emit("new-message", {
            _id: docs[i]._id,
            senderId: { _id: senderId, name: senderName, role: senderRole },
            subject,
            body,
            isRead: false,
            createdAt: now,
            parentId: null,
          });
        } catch {}
        if (r.email) {
          await sendNewMessageEmail(
            r.email,
            r.name,
            senderName,
            subject,
            body,
            sender?.email,
          );
        }
      } catch (err) {
        console.error("❌ group message notify failed for", String(r._id), err);
      }
    }
  })();
  try {
    waitUntil(notifyAll);
  } catch {
    notifyAll.catch(() => {});
  }

  const lead = await MessageModel.findById(docs[0]._id)
    .select(
      "senderId receiverId subject body isRead createdAt parentId broadcastId broadcastRecipientCount broadcastAudience",
    )
    .populate("senderId", "name role profilePicture")
    .populate("receiverId", "name role");

  return res.status(201).json({
    success: true,
    data: { message: lead, total: recipients.length },
    message:
      audience === "everyone"
        ? `Message sent to ${recipients.length} people`
        : `Message sent to ${recipients.length} people`,
  });
};

export const getBroadcastAudience = async (req: AuthRequest, res: Response) => {
  try {
    const allowed = BROADCAST_ROLES.includes(req.user!.role);
    const recipientCount = allowed
      ? await User.countDocuments({ _id: { $ne: req.user!.userId }, isActive: true })
      : 0;
    res.json({ success: true, data: { allowed, recipientCount } });
  } catch {
    res.status(500).json({ success: false });
  }
};

export const sendMessage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const senderId = req.user!.userId;
    const senderRole = req.user!.role;
    const { receiverId: bodyReceiverId, subject, body, parentId } = req.body;

    // The actual recipient. For a reply, this is ALWAYS derived from the
    // parent thread server-side — never trust the client-supplied
    // receiverId here, or anyone in any thread could redirect a "reply"
    // to an arbitrary third party and bypass canSendTo entirely.
    let receiverId = bodyReceiverId;

    if (!body) {
      return res
        .status(400)
        .json({ success: false, message: "body is required" });
    }

    // New top-level message to a group. Replies are always one-to-one.
    const audience = req.body.audience;
    if (!parentId && (audience === "selected" || audience === "everyone")) {
      return await sendGroupMessage(req, res, audience);
    }

    if (parentId) {
      const parent = await MessageModel.findById(parentId).select(
        "senderId receiverId",
      );
      if (!parent)
        return res
          .status(404)
          .json({ success: false, message: "Parent not found" });
      const isParticipant =
        parent.senderId.toString() === senderId ||
        parent.receiverId.toString() === senderId;
      if (!isParticipant)
        return res
          .status(403)
          .json({ success: false, message: "Not part of this conversation" });

      // The other participant in the thread — regardless of what the
      // client sent as receiverId.
      receiverId = (
        parent.senderId.toString() === senderId
          ? parent.receiverId
          : parent.senderId
      ).toString();
    } else {
      if (!receiverId) {
        return res
          .status(400)
          .json({ success: false, message: "receiverId is required" });
      }
      const { allowed, message } = await canSendTo(
        senderId,
        senderRole,
        receiverId,
      );
      if (!allowed) return res.status(403).json({ success: false, message });
    }

    const now = new Date();
    const message = await MessageModel.create({
      senderId,
      receiverId,
      subject,
      body,
      parentId: parentId || null,
      isRead: false,
      lastMessageAt: now,
    });

    // A reply landed — bump the root thread's lastMessageAt so the
    // conversation resurfaces to the top of the inbox/sent list instead
    // of staying stuck wherever the original message's date put it.
    if (parentId) {
      await MessageModel.findByIdAndUpdate(parentId, {
        lastMessageAt: now,
        hasReplies: true,
      });
    }

    // Only select the fields the frontend actually needs
    const populated = await MessageModel.findById(message._id)
      .select("senderId receiverId subject body isRead createdAt parentId")
      .populate("senderId", "name role profilePicture")
      .populate("receiverId", "name role");

    try {
      const io = getIO();
      io.to(`user:${receiverId}`).emit("new-message", populated);
    } catch {}

    const sender = await User.findById(senderId).select("name email");
    const receiver = await User.findById(receiverId).select("name email");
    await createNotification(
      receiverId,
      `New message from ${sender?.name ?? "Someone"}: ${subject ?? body.slice(0, 60)}`,
      "new_message",
      {
        senderName: sender?.name ?? "Someone",
        messageSubject: subject,
        messageBody: body,
      },
    );

    // Best-effort email — in-app notifications have no visible UI yet,
    // so email is currently the only way someone actually finds out
    // they got a message unless they happen to have this page open.
    if (receiver?.email) {
      sendNewMessageEmail(
        receiver.email,
        receiver.name,
        sender?.name ?? "Someone",
        subject,
        body,
        sender?.email,
      ).catch((err) =>
        console.error(
          "❌ sendNewMessageEmail failed (message still saved):",
          err,
        ),
      );
    }

    res.status(201).json({ success: true, data: { message: populated } });
    return;
  } catch (err) {
    console.error("❌ sendMessage:", err);
    next(err);
    return;
  }
};

// ── Shared pagination helper ───────────────────────────────────────
const parsePage = (q: Record<string, string>) => ({
  page: Math.max(1, parseInt(q.page ?? "1", 10)),
  limit: Math.min(50, parseInt(q.limit ?? "20", 10)), // cap at 50
});

export const getInbox = async (req: AuthRequest, res: Response) => {
  try {
    const { page, limit } = parsePage(req.query as Record<string, string>);
    const skip = (page - 1) * limit;
    const userId = req.user!.userId;

    // Find all root messages where this user is involved (sent or received)
    // Then for each, get the latest activity (reply or the message itself)
    const rootFilter = {
      $or: [
        { receiverId: userId, parentId: null }, // received top-level
        // sent top-level (so replies to them show) — minus the duplicate
        // per-recipient copies of group sends
        { senderId: userId, parentId: null, ...hideBroadcastCopies },
      ],
    };

    const [messages, total] = await Promise.all([
      MessageModel.find(rootFilter)
        .select(
          "senderId receiverId subject body isRead createdAt lastMessageAt broadcastId broadcastRecipientCount broadcastAudience",
        )
        .populate("senderId", "name role profilePicture")
        .populate("receiverId", "name role")
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MessageModel.countDocuments(rootFilter),
    ]);

    // A thread can have unread *replies* even when its root message is
    // already marked read — flag those so the list doesn't look stale
    // just because the very first message in it was read ages ago.
    const threadIds = messages.map((m) => m._id);
    const unreadReplyCounts = threadIds.length
      ? await MessageModel.aggregate([
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
    const messagesWithUnread = messages.map((m) => ({
      ...m,
      hasUnreadReplies: (unreadByThread.get(m._id.toString()) ?? 0) > 0,
    }));

    res.json({
      success: true,
      data: { messages: messagesWithUnread },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("❌ getInbox:", err);
    res.status(500).json({ success: false });
  }
};

export const getSent = async (req: AuthRequest, res: Response) => {
  try {
    const { page, limit } = parsePage(req.query as Record<string, string>);
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      MessageModel.find({
        senderId: req.user!.userId,
        parentId: null,
        ...sentOnlyOnce,
      })
        .select(
          "senderId receiverId subject body isRead createdAt lastMessageAt broadcastId broadcastRecipientCount broadcastAudience",
        )
        .populate("senderId", "name role profilePicture")
        .populate("receiverId", "name role")
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MessageModel.countDocuments({
        senderId: req.user!.userId,
        parentId: null,
        ...sentOnlyOnce,
      }),
    ]);

    res.json({
      success: true,
      data: { messages },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("❌ getSent:", err);
    res.status(500).json({ success: false });
  }
};

export const getThread = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;
    const { page, limit } = parsePage(req.query as Record<string, string>);
    const skip = (page - 1) * limit;

    // Fetch parent with minimal fields — no lean() so _id toString works
    const parent = await MessageModel.findById(id)
      .select("senderId receiverId subject body isRead createdAt")
      .populate("senderId", "name role profilePicture")
      .populate("receiverId", "name role");

    if (!parent) return res.status(404).json({ success: false });

    const isParticipant =
      parent.senderId._id.toString() === userId ||
      parent.receiverId._id.toString() === userId;
    if (!isParticipant) return res.status(403).json({ success: false });

    // Paginate replies — oldest first (natural chat order)
    const [replies, totalReplies] = await Promise.all([
      MessageModel.find({ parentId: id })
        .select("senderId receiverId body isRead createdAt parentId")
        .populate("senderId", "name role profilePicture")
        .populate("receiverId", "name role")
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MessageModel.countDocuments({ parentId: id }),
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
    console.error("❌ getThread:", err);
    res.status(500).json({ success: false });
    return;
  }
};

export const markRead = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const msg = await MessageModel.findById(id).select(
      "receiverId senderId isRead readAt",
    );
    if (!msg) return res.status(404).json({ success: false });
    if (msg.receiverId.toString() !== userId)
      return res.status(403).json({ success: false });

    msg.isRead = true;
    msg.readAt = new Date();
    await msg.save();

    try {
      const io = getIO();
      io.to(`user:${msg.senderId.toString()}`).emit("chat:read", {
        messageId: id,
        readAt: msg.readAt,
      });
    } catch {}

    res.json({ success: true });
    return;
  } catch (err) {
    console.error("❌ markRead:", err);
    res.status(500).json({ success: false });
    return;
  }
};

export const getUnreadCount = async (req: AuthRequest, res: Response) => {
  try {
    const count = await MessageModel.countDocuments({
      receiverId: req.user!.userId,
      isRead: false,
    });
    res.json({ success: true, data: { unreadCount: count } });
  } catch (err) {
    console.error("❌ unreadCount:", err);
    res.status(500).json({ success: false });
  }
};

export const getContacts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    let contacts: any[] = [];

    if (role === "ceo" || role === "tech") {
      contacts = await User.find({ _id: { $ne: userId }, isActive: true })
        .select("_id name email role profilePicture department")
        .lean();
    }
    if (role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: userId,
        status: "active",
      }).populate(
        "subordinateId",
        "_id name email role profilePicture department",
      );
      const admins = await User.find({ role: { $in: ["ceo", "tech"] } })
        .select("_id name email role profilePicture department")
        .lean();
      contacts = [...admins, ...mappings.map((m: any) => m.subordinateId)];
    }
    // Any non-admin, non-supervisor staff role (sales_person,
    // accountant — tech is covered by the ceo/tech branch above)
    // only has their own supervisor as a contact.
    if (role === "sales_person" || role === "accountant") {
      const mapping = await SupervisorMapping.findOne({
        subordinateId: userId,
        status: "active",
      }).populate(
        "supervisorId",
        "_id name email role profilePicture department",
      );
      if (mapping?.supervisorId) contacts = [mapping.supervisorId];
    }

    res.json({ success: true, data: { contacts } });
  } catch (err) {
    console.error("❌ getContacts:", err);
    res.status(500).json({ success: false });
  }
};