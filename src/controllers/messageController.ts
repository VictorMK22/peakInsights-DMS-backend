import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import { MessageModel } from '../models/Message';
import { User } from '../models/User';
import { SupervisorMapping } from '../models/SupervisorMapping';
import { getIO } from '../socket/socketServer';
import mongoose from 'mongoose';

/**
 * 🔒 RBAC Messaging Rules
 */
const canSendTo = async (
  senderId: string,
  senderRole: string,
  receiverId: string
) => {
  const receiver = await User.findById(receiverId).select('role isActive');
  if (!receiver || !receiver.isActive) {
    return { allowed: false, message: 'Recipient not found or inactive' };
  }

  if (senderRole === 'ceo') return { allowed: true };

  if (senderRole === 'supervisor') {
    if (receiver.role === 'ceo') return { allowed: true };

    if (receiver.role === 'user') {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: senderId,
        subordinateId: receiverId,
        status: 'active',
      });
      if (mapping) return { allowed: true };
    }

    return { allowed: false, message: 'You can only message your team or CEO' };
  }

  if (senderRole === 'user') {
    const mapping = await SupervisorMapping.findOne({
      subordinateId: senderId,
      supervisorId: receiverId,
      status: 'active',
    });

    if (mapping) return { allowed: true };

    return { allowed: false, message: 'You can only message your supervisor' };
  }

  return { allowed: false, message: 'Not allowed' };
};


// =====================================================
// 📩 SEND MESSAGE
// =====================================================
export const sendMessage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const senderId = req.user!.userId;
    const senderRole = req.user!.role;

    const { receiverId, subject, body, parentId } = req.body;

    if (!receiverId || !body) {
      return res.status(400).json({
        success: false,
        message: 'receiverId and body are required',
      });
    }

    // 🔒 THREAD REPLY LOGIC
    if (parentId) {
      const parent = await MessageModel.findById(parentId);
      if (!parent) {
        return res.status(404).json({ success: false, message: 'Parent not found' });
      }

      const isParticipant =
        parent.senderId.toString() === senderId ||
        parent.receiverId.toString() === senderId;

      if (!isParticipant) {
        return res.status(403).json({
          success: false,
          message: 'Not part of this conversation',
        });
      }
    } else {
      const { allowed, message } = await canSendTo(
        senderId,
        senderRole,
        receiverId
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message,
        });
      }
    }

    const message = await MessageModel.create({
      senderId,
      receiverId,
      subject,
      body,
      parentId: parentId || null,
      isRead: false,
    });

    const populated = await MessageModel.findById(message._id)
      .populate('senderId', 'name role profilePicture')
      .populate('receiverId', 'name role profilePicture');

    // 🔌 SOCKET
    try {
      const io = getIO();
      io.to(`user:${receiverId}`).emit('new-message', populated);
    } catch {}

    res.status(201).json({
      success: true,
      data: { message: populated },
    });
  } catch (err) {
    console.error('❌ sendMessage:', err);
    next(err);
  }
};


// =====================================================
// 📥 INBOX
// =====================================================
export const getInbox = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const messages = await MessageModel.find({
      receiverId: userId,
      parentId: null,
    })
      .populate('senderId', 'name role profilePicture')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: { messages },
    });
  } catch (err) {
    console.error('❌ getInbox:', err);
    res.status(500).json({ success: false });
  }
};


// =====================================================
// 📤 SENT
// =====================================================
export const getSent = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const messages = await MessageModel.find({
      senderId: userId,
      parentId: null,
    })
      .populate('receiverId', 'name role profilePicture')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: { messages },
    });
  } catch (err) {
    console.error('❌ getSent:', err);
    res.status(500).json({ success: false });
  }
};


// =====================================================
// 🧵 THREAD
// =====================================================
export const getThread = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const parent = await MessageModel.findById(id)
      .populate('senderId', 'name role profilePicture')
      .populate('receiverId', 'name role profilePicture');

    if (!parent) {
      return res.status(404).json({ success: false });
    }

    const isParticipant =
      parent.senderId._id.toString() === userId ||
      parent.receiverId._id.toString() === userId;

    if (!isParticipant) {
      return res.status(403).json({ success: false });
    }

    const replies = await MessageModel.find({ parentId: id })
      .populate('senderId', 'name role profilePicture')
      .sort({ createdAt: 1 });

    res.json({
      success: true,
      data: {
        parent,
        replies,
      },
    });
  } catch (err) {
    console.error('❌ getThread:', err);
    res.status(500).json({ success: false });
  }
};


// =====================================================
// ✅ MARK READ
// =====================================================
export const markRead = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const msg = await MessageModel.findById(id);
    if (!msg) return res.status(404).json({ success: false });

    if (msg.receiverId.toString() !== userId) {
      return res.status(403).json({ success: false });
    }

    msg.isRead = true;
    msg.readAt = new Date();
    await msg.save();

    res.json({ success: true });
  } catch (err) {
    console.error('❌ markRead:', err);
    res.status(500).json({ success: false });
  }
};


// =====================================================
// 🔢 UNREAD COUNT
// =====================================================
export const getUnreadCount = async (req: AuthRequest, res: Response) => {
  try {
    const count = await MessageModel.countDocuments({
      receiverId: req.user!.userId,
      isRead: false,
    });

    res.json({
      success: true,
      data: { count },
    });
  } catch (err) {
    console.error('❌ unreadCount:', err);
    res.status(500).json({ success: false });
  }
};


// =====================================================
// 👥 CONTACTS (FIXED FOR UI)
// =====================================================
export const getContacts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;

    let contacts: any[] = [];

    if (role === 'ceo') {
      contacts = await User.find({ _id: { $ne: userId } }).select(
        '_id name email role profilePicture department'
      );
    }

    if (role === 'supervisor') {
      const mappings = await SupervisorMapping.find({
        supervisorId: userId,
        status: 'active',
      }).populate('subordinateId');

      const ceo = await User.findOne({ role: 'ceo' });

      contacts = [
        ...(ceo ? [ceo] : []),
        ...mappings.map((m: any) => m.subordinateId),
      ];
    }

    if (role === 'user') {
      const mapping = await SupervisorMapping.findOne({
        subordinateId: userId,
        status: 'active',
      }).populate('supervisorId');

      if (mapping?.supervisorId) {
        contacts = [mapping.supervisorId];
      }
    }

    res.json({
      success: true,
      data: { contacts },
    });
  } catch (err) {
    console.error('❌ getContacts:', err);
    res.status(500).json({ success: false });
  }
};