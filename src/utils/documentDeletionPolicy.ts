import mongoose from "mongoose";
import { AppSettingModel } from "../models/AppSetting";
import { ClientModel } from "../models/Client";
import { User } from "../models/User";
import { isTechDepartmentName } from "../middleware/auth";

/**
 * Who may delete documents.
 *
 *   CEO               Always. Any document, regardless of the switch.
 *   Tech supervisor   Always, but only their OWN documents (plus the
 *                     learning material every supervisor already
 *                     maintains). Never affected by the switch.
 *   Everyone else     Only while the company-wide switch is ON, and then
 *   (sales, accountant, only (a) documents they own, or (b) documents that
 *   tech, other         belong to a client they are directly assigned to.
 *   supervisors)
 *
 * The switch is flipped by the CEO or a Tech supervisor
 * (PUT /api/settings/document-deletion). It defaults to OFF.
 */

const SETTING_KEY = "documentDeletion";

export const USER_DELETE_OFF_MESSAGE =
  "Document deletion is currently turned off for your role. Ask the CEO or the Tech supervisor to enable it.";

export interface DocumentDeletionSetting {
  userDeleteEnabled: boolean;
  updatedAt?: Date;
  updatedBy?: string;
}

export const getDocumentDeletionSetting =
  async (): Promise<DocumentDeletionSetting> => {
    const row = await AppSettingModel.findOne({ key: SETTING_KEY }).lean();
    return {
      userDeleteEnabled: row?.value?.["userDeleteEnabled"] === true,
      updatedAt: row?.updatedAt,
      updatedBy: row?.updatedBy ? String(row.updatedBy) : undefined,
    };
  };

export const setUserDeleteEnabled = async (
  enabled: boolean,
  updatedBy: string,
): Promise<DocumentDeletionSetting> => {
  await AppSettingModel.findOneAndUpdate(
    { key: SETTING_KEY },
    {
      $set: {
        value: { userDeleteEnabled: enabled },
        updatedBy: new mongoose.Types.ObjectId(updatedBy),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return getDocumentDeletionSetting();
};

/** True when the user is a supervisor whose own department is Tech. */
export const isTechSupervisorUser = async (
  userId: string,
  role: string,
): Promise<boolean> => {
  if (role !== "supervisor") return false;
  const me = await User.findById(userId).select("department").lean();
  return isTechDepartmentName(me?.department);
};

/** Who may flip the switch: the CEO and Tech supervisors. */
export const canToggleDeletion = async (
  userId: string,
  role: string,
): Promise<boolean> =>
  role === "ceo" || (await isTechSupervisorUser(userId, role));

type DocLike = {
  ownerId: mongoose.Types.ObjectId | string | { _id: unknown };
  clientId?: mongoose.Types.ObjectId | string | null;
  documentType?: string;
};

const idStr = (v: unknown): string =>
  v && typeof v === "object" && "_id" in (v as Record<string, unknown>)
    ? String((v as { _id: unknown })._id)
    : String(v ?? "");

export interface DeletePolicy {
  /** Synchronous check, safe to use inside .filter(). */
  canDelete: (doc: DocLike) => boolean;
  /** Human-readable reason for a refusal (for 403 messages). */
  reasonFor: (doc: DocLike) => string;
  /** Whether the switch is on (informational). */
  userDeleteEnabled: boolean;
}

/**
 * Resolves everything async up front (the switch, the actor's department,
 * which of the documents' clients the actor is assigned to) so callers can
 * then test any number of documents synchronously.
 *
 * `permanent` = removing from Trash for good. Accountants keep their
 * existing restriction there: they can move documents to Trash but only the
 * CEO can destroy them.
 */
export const buildDeletePolicy = async (
  actor: { userId: string; role: string },
  docs: DocLike[],
  opts: { permanent?: boolean } = {},
): Promise<DeletePolicy> => {
  const { userId, role } = actor;

  if (role === "ceo") {
    return {
      canDelete: () => true,
      reasonFor: () => "",
      userDeleteEnabled: true,
    };
  }

  const setting = await getDocumentDeletionSetting();
  const techSup = await isTechSupervisorUser(userId, role);
  const permanentBlocked = !!opts.permanent && role === "accountant";

  // Clients (among these docs) the actor is directly assigned to.
  let assigned = new Set<string>();
  const clientIds = [
    ...new Set(docs.map((d) => (d.clientId ? idStr(d.clientId) : ""))),
  ].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!techSup && setting.userDeleteEnabled && clientIds.length) {
    const rows = await ClientModel.find({
      _id: { $in: clientIds },
      assignedTo: new mongoose.Types.ObjectId(userId),
    }).select("_id");
    assigned = new Set(rows.map((r) => String(r._id)));
  }

  const own = (d: DocLike) => idStr(d.ownerId) === userId;
  const learning = (d: DocLike) =>
    role === "supervisor" && d.documentType === "learning";

  const canDelete = (d: DocLike): boolean => {
    if (techSup) return own(d) || learning(d); // switch never applies to them
    if (!setting.userDeleteEnabled) return false;
    if (permanentBlocked) return false;
    if (own(d) || learning(d)) return true;
    return !!d.clientId && assigned.has(idStr(d.clientId));
  };

  const reasonFor = (d: DocLike): string => {
    if (canDelete(d)) return "";
    if (techSup)
      return "Tech supervisors can delete their own documents only";
    if (!setting.userDeleteEnabled) return USER_DELETE_OFF_MESSAGE;
    if (permanentBlocked)
      return "Accountants can move documents to Trash, but only the CEO can delete them permanently";
    return "You can only delete documents you own or that belong to a client you're assigned to";
  };

  return { canDelete, reasonFor, userDeleteEnabled: setting.userDeleteEnabled };
};