// What happens to a client's relationship when the staff member serving them
// leaves the company.
//
// Principle: a client's communication history belongs to the CLIENT, not to
// whoever happened to be serving them. Every email, WhatsApp message, note,
// call and meeting is keyed on clientId, so none of it is touched here — and
// whoever is assigned next sees all of it.
//
// When someone is deactivated or deleted we therefore:
//   1. stamp their name on everything they wrote (so the timeline can still say
//      who wrote it after the account is gone),
//   2. take them off every client and, where nobody else is serving that
//      client, put it in the CEO's allocation queue (needsReallocation) and
//      notify the CEO,
//   3. cut off their connected mailbox (and erase its tokens on hard delete).
//
// Nothing the person wrote is ever deleted.

import mongoose from "mongoose";
import { User } from "../models/User";
import { ClientModel } from "../models/Client";
import { ClientEmailModel } from "../models/ClientEmail";
import { ClientNoteModel } from "../models/ClientNote";
import { ClientCallModel } from "../models/ClientCall";
import { ClientMeetingModel } from "../models/ClientMeeting";
import { ClientWhatsappMessageModel } from "../models/ClientWhatsappMessage";
import { EmailIntegrationModel } from "../models/EmailIntegration";
import { createNotification } from "./notificationService";
import { getAccountantSupervisorIds } from "../utils/accountantSupervisors";

export const FORMER_STAFF_LABEL = "Former team member";

/**
 * Makes a record safe to show after its author's account has been deleted:
 * when `authorId` no longer resolves, substitutes the snapshot (or a generic
 * label) so the UI never has to deal with a null author.
 *
 * `required` = the model always has an author (emails, notes, calls…). For
 * WhatsApp an empty author legitimately means "the client sent this", so
 * there we only substitute when a snapshot exists.
 */
export const withAuthorFallback = <T extends Record<string, any>>(
  doc: T,
  required = true,
): T => {
  if (doc.authorId) return doc;
  if (!doc.formerAuthor && !required) return doc;
  return {
    ...doc,
    authorId: {
      _id: null,
      name: doc.formerAuthor?.name ?? FORMER_STAFF_LABEL,
      email: doc.formerAuthor?.email,
      role: doc.formerAuthor?.role ?? "accountant",
      former: true,
    },
  };
};

/** Stamps the person's name/role on every client record they authored. */
export async function snapshotAuthorship(
  user: { _id: any; name: string; email?: string; role?: string },
): Promise<void> {
  const formerAuthor = {
    name: user.name,
    email: user.email,
    role: user.role,
  };
  const filter = { authorId: user._id, formerAuthor: { $exists: false } };
  await Promise.all(
    [
      ClientEmailModel,
      ClientNoteModel,
      ClientCallModel,
      ClientMeetingModel,
      ClientWhatsappMessageModel,
    ].map((m: any) => m.updateMany(filter, { $set: { formerAuthor } })),
  );
}

export interface ReleaseResult {
  /** Clients the person was taken off. */
  released: number;
  /** Of those, how many now have nobody serving them (CEO must reallocate). */
  needReallocation: number;
}

/**
 * Takes the person off every client they were assigned to. Clients that are
 * left with nobody serving them are flagged for the CEO's allocation queue.
 */
export async function releaseClientsOfUser(
  userId: string,
): Promise<ReleaseResult> {
  const uid = new mongoose.Types.ObjectId(userId);
  const user = await User.findById(uid).select("name role").lean();
  if (!user) return { released: 0, needReallocation: 0 };

  const clients = await ClientModel.find({ assignedTo: uid })
    .select("name assignedTo allocatedAccountant")
    .lean();
  if (clients.length === 0) return { released: 0, needReallocation: 0 };

  // Who is still serving a client after this person goes? An accountant, an
  // accountant supervisor, or the CEO (who may serve a client personally).
  const remainingIds = new Set<string>();
  for (const c of clients)
    for (const id of c.assignedTo)
      if (String(id) !== userId) remainingIds.add(String(id));
  const [remaining, supervisorIds] = await Promise.all([
    remainingIds.size
      ? User.find({ _id: { $in: [...remainingIds] }, isActive: true })
          .select("role")
          .lean()
      : Promise.resolve([] as { _id: any; role: string }[]),
    getAccountantSupervisorIds(),
  ]);
  const servingNow = new Set(
    remaining
      .filter(
        (u) =>
          u.role === "accountant" ||
          u.role === "ceo" ||
          supervisorIds.has(String(u._id)),
      )
      .map((u) => String(u._id)),
  );

  // Only people who serve clients create a gap; a departing sales person's
  // prospects simply become unassigned (the CEO already has a view for those).
  // (A supervisor can only hold a client if they are an accountant supervisor,
  // so any supervisor with clients counts — and this must not depend on the
  // supervisor lookup above, which already ignores people being deactivated.)
  const wasServing = user.role === "accountant" || user.role === "supervisor";

  const now = new Date();
  const ops: mongoose.AnyBulkWriteOperation<any>[] = [];
  let needReallocation = 0;

  for (const c of clients) {
    const stillServed = c.assignedTo.some((id) => servingNow.has(String(id)));
    const flag = wasServing && !stillServed;
    if (flag) needReallocation++;

    const update: Record<string, any> = {
      $pull: { assignedTo: uid },
      $push: {
        formerAssignees: {
          userId: uid,
          name: user.name,
          role: user.role,
          releasedAt: now,
        },
      },
    };
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    if (String(c.allocatedAccountant ?? "") === userId) {
      $unset.allocatedAccountant = 1;
      $unset.allocatedAt = 1;
      $unset.allocatedBy = 1;
    }
    if (flag) {
      $set.needsReallocation = true;
      $set.releasedAt = now;
    }
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    ops.push({ updateOne: { filter: { _id: c._id }, update } });
  }
  await ClientModel.bulkWrite(ops);

  if (needReallocation > 0) {
    try {
      const ceos = await User.find({ role: "ceo", isActive: true })
        .select("_id")
        .lean();
      const msg =
        needReallocation === 1
          ? `${user.name} has left — 1 client needs a new accountant`
          : `${user.name} has left — ${needReallocation} clients need a new accountant`;
      for (const ceo of ceos)
        await createNotification(String(ceo._id), msg, "client_needs_reallocation");
    } catch (err) {
      console.error("❌ reallocation notify failed:", err);
    }
  }

  return { released: clients.length, needReallocation };
}

/**
 * Stops syncing the person's mailbox. On permanent deletion the stored
 * OAuth tokens are erased too — they must not outlive the account. Emails
 * already synced into client timelines are NOT removed.
 */
export async function disconnectMailbox(
  userId: string,
  opts: { erase?: boolean } = {},
): Promise<void> {
  if (opts.erase) await EmailIntegrationModel.deleteOne({ userId });
  else
    await EmailIntegrationModel.updateOne(
      { userId },
      { status: "disconnected" },
    );
}

/** Everything that happens when a staff member's account is taken away. */
export async function offboardStaff(
  userId: string,
  opts: { erase?: boolean } = {},
): Promise<ReleaseResult> {
  const user = await User.findById(userId).select("name email role").lean();
  if (user) await snapshotAuthorship(user as any);
  const result = await releaseClientsOfUser(userId);
  await disconnectMailbox(userId, opts);
  return result;
}
