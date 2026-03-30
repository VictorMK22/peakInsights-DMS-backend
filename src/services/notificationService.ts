import Notification from '../models/Notification';

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
  type: string
): Promise<void> => {
  try {
    const notification = await Notification.create({ userId, message, type });

    // Real-time delivery — safe to fail silently (socket may not be
    // initialised in test environments)
    try {
      const { getIO } = await import('../socket/socketServer');
      const io = getIO();
      io.to(`user:${userId}`).emit('notification', {
        _id:     notification._id,
        message,
        type,
        read:    false,
        createdAt: notification.createdAt,
      });
    } catch {
      // Socket not available — notification still persisted in DB
    }
  } catch (err) {
    // Never let notification failures crash the calling operation
    console.error('[Notification] Failed to create notification:', err);
  }
};