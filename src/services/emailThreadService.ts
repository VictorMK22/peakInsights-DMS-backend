import mongoose from "mongoose";
import { EmailLog } from "../models/EmailLog";

/**
 * Email threads: who is in a conversation, and who a reply goes to.
 *
 * A thread behaves like a normal "reply all" email conversation:
 *   - Everyone on the thread (sender, recipient, every CC, and anyone added
 *     to the CC of a later reply) can open it, follow it and reply.
 *   - A reply goes To the person who wrote the last email and Cc's everyone
 *     else on the thread, so nobody drops out of the conversation.
 *   - The replier may add more people to the CC; they join the thread.
 *
 * `threadParticipantIds` on the root email is the stored participant list.
 * Threads created before it existed fall back to sender + recipient + the
 * root's CC list, so nothing needs migrating.
 */

/** The id of a value that may be an ObjectId, a string, or a populated doc. */
export const idOf = (v: any): string =>
  String(v && typeof v === "object" && v._id ? v._id : v);

/** Every user in the thread, as strings (root email document or lean object). */
export const participantIdsOf = (root: any): string[] => {
  const ids = new Set<string>();
  ids.add(idOf(root.senderId));
  ids.add(idOf(root.receiverId));
  for (const c of root.ccIds ?? []) ids.add(idOf(c));
  for (const p of root.threadParticipantIds ?? []) ids.add(idOf(p));
  return [...ids];
};

export const isThreadParticipant = (root: any, userId: string): boolean =>
  participantIdsOf(root).includes(String(userId));

/**
 * Works out who a reply from `replierId` goes To and who is Cc'd.
 * `lastEmail` is the newest email in the thread (the root if nobody has
 * replied yet).
 */
export async function resolveReplyRecipients(
  root: any,
  replierId: string,
): Promise<{
  toId: string;
  ccIds: string[];
  replyToEmailId: string;
}> {
  const last = await EmailLog.findOne({
    $or: [{ _id: root._id }, { parentId: root._id }],
  })
    .sort({ createdAt: -1 })
    .select("_id senderId receiverId")
    .lean();

  const lastSender = idOf(last?.senderId ?? root.senderId);
  const lastReceiver = idOf(last?.receiverId ?? root.receiverId);

  // Reply to whoever wrote the last email; if that was me, keep talking to
  // the person I last wrote to.
  const toId = lastSender !== String(replierId) ? lastSender : lastReceiver;

  const ccIds = participantIdsOf(root).filter(
    (id) => id !== String(replierId) && id !== toId,
  );

  return {
    toId,
    ccIds,
    replyToEmailId: String(last?._id ?? root._id),
  };
}

/** Adds people to a thread's stored participant list (no-op for empty input). */
export async function addThreadParticipants(
  rootId: unknown,
  userIds: string[],
): Promise<void> {
  const valid = [...new Set(userIds.map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id),
  );
  if (!valid.length) return;
  await EmailLog.updateOne(
    { _id: rootId },
    { $addToSet: { threadParticipantIds: { $each: valid } } },
  );
}