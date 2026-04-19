import Notification, { INotification } from '../models/Notification';
import { Types } from 'mongoose';

/**
 * Creates a persistent notification in the database and, if the
 * socket server is initialised, delivers it in real-time to the
 * target user's socket room.
 *
 * Used by: taskController, messageController, documentController.
 */
export const createNotification = async (
  userId: string,
  message: string,
  type: string,
  meta?: Record<string, any>
): Promise<INotification | null> => {
  if (!userId || !message || !type) {
    throw new Error('Invalid notification payload');
  }

  try {
    const notification = await Notification.create({
      userId: new Types.ObjectId(userId), 
      message,
      type,
      meta,
      read: false,
    });

    try {
      const { getIO } = await import('../socket/socketServer');
      const io = getIO?.();

      if (io) {
        io.to(`user:${userId}`).emit('notification', {
          _id: notification._id,
          message,
          type,
          read: false,
          createdAt: notification.createdAt,
        });
      }
    } catch {
      // socket optional
    }

    return notification;
  } catch (err) {
    console.error('[Notification] Failed to create notification:', err);
    return null;
  }
};