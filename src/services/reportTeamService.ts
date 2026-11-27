import { Types } from "mongoose";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { IClient } from "../models/Client";
import {
  ReportAuditEvent,
  ReportAuditAction,
} from "../models/ReportAuditEvent";
import { getAccountantSupervisorIds } from "../utils/accountantSupervisors";
import { createNotification } from "./notificationService";
import { assertCeoCanSendAs } from "./emailService";

// ═════════════════════════════════════════════════════════════════
// Who is who in the Management Accounts / Reports workflow.
// Everything is derived from the existing client assignment structure and
// the role/mapping tables — nothing here hardcodes a person.
// ═════════════════════════════════════════════════════════════════

export interface PersonLite {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: string;
}

const LITE = "name email role isActive";

export interface ClientTeam {
  primary: PersonLite | null;
  secondaries: PersonLite[];
}

/**
 * Primary accountant = the client's allocated accountant (the CEO's
 * allocation, which may be the CEO or an accountant supervisor); if none, the
 * first assigned accountant. Secondaries are the other people serving the
 * client: accountants and accountant supervisors (the same set the client
 * screens allow). Sales people on `assignedTo` never count, and the CEO only
 * counts when allocated as the primary.
 */
export async function resolveClientTeam(
  client: Pick<IClient, "assignedTo" | "allocatedAccountant">,
): Promise<ClientTeam> {
  const ids = [
    ...(client.assignedTo ?? []).map((i) => String(i)),
    ...(client.allocatedAccountant ? [String(client.allocatedAccountant)] : []),
  ];
  if (ids.length === 0) return { primary: null, secondaries: [] };

  const supervisorIds = await getAccountantSupervisorIds();
  const users = (await User.find({
    _id: { $in: [...new Set(ids)] },
    isActive: true,
  })
    .select(LITE)
    .lean()) as unknown as (PersonLite & { isActive: boolean })[];
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const accountantsInOrder = (client.assignedTo ?? [])
    .map((i) => byId.get(String(i)))
    .filter((u): u is PersonLite & { isActive: boolean } => !!u)
    .filter(
      (u) =>
        u.role === "accountant" ||
        (u.role === "supervisor" && supervisorIds.has(String(u._id))),
    );

  const allocated = client.allocatedAccountant
    ? byId.get(String(client.allocatedAccountant))
    : undefined;

  const primary = allocated ?? accountantsInOrder[0] ?? null;
  const secondaries = accountantsInOrder.filter(
    (u) => !primary || String(u._id) !== String(primary._id),
  );
  return { primary, secondaries };
}

/** Does this user serve the client as its primary or secondary accountant? */
export async function isClientAccountant(
  client: Pick<IClient, "assignedTo" | "allocatedAccountant">,
  userId: string,
): Promise<boolean> {
  const t = await resolveClientTeam(client);
  return (
    (!!t.primary && String(t.primary._id) === userId) ||
    t.secondaries.some((s) => String(s._id) === userId)
  );
}

/** Active users who hold the Accountant Supervisor role (see utils/accountantSupervisors). */
export async function getAccountantSupervisors(): Promise<PersonLite[]> {
  const ids = [...(await getAccountantSupervisorIds())];
  if (ids.length === 0) return [];
  return (await User.find({ _id: { $in: ids }, isActive: true })
    .select(LITE)
    .lean()) as unknown as PersonLite[];
}

export async function isAccountantSupervisor(userId: string): Promise<boolean> {
  return (await getAccountantSupervisorIds()).has(userId);
}

/**
 * Supervisors responsible for reviewing this accountant's work: the active
 * accountant-supervisors the accountant is mapped to; if the accountant has no
 * mapped supervisor, every accountant-supervisor may review.
 */
export async function resolveReviewers(
  primaryAccountantId: Types.ObjectId | string,
  /** People working on the report — they can never review it. */
  excludeIds: (Types.ObjectId | string)[] = [],
): Promise<PersonLite[]> {
  const skip = new Set(excludeIds.map(String));
  const all = (await getAccountantSupervisors()).filter(
    (s) => !skip.has(String(s._id)),
  );
  if (all.length === 0) return [];
  const mapped = await SupervisorMapping.find({
    subordinateId: primaryAccountantId,
    status: "active",
  })
    .select("supervisorId")
    .lean();
  const mappedIds = new Set(mapped.map((m) => String(m.supervisorId)));
  const narrowed = all.filter((s) => mappedIds.has(String(s._id)));
  return narrowed.length ? narrowed : all;
}

/** Everyone who can serve clients as an accountant: accountants, accountant supervisors and the CEO. */
export async function accountingStaffIds(): Promise<string[]> {
  const supIds = [...(await getAccountantSupervisorIds())];
  const staff = await User.find({
    isActive: true,
    $or: [{ role: "accountant" }, { role: "ceo" }, { _id: { $in: supIds } }],
  })
    .select("_id")
    .lean();
  return staff.map((u) => String(u._id));
}

/** Accountants a supervisor oversees (their active mapped accountants; all accountants if none mapped). */
export async function supervisedAccountantIds(
  supervisorId: string,
): Promise<string[]> {
  const mapped = await SupervisorMapping.find({
    supervisorId,
    status: "active",
  })
    .select("subordinateId")
    .lean();
  const subs = await User.find({
    _id: { $in: mapped.map((m) => m.subordinateId) },
    role: "accountant",
    isActive: true,
  })
    .select("_id")
    .lean();
  if (subs.length) return subs.map((s) => String(s._id));
  const all = await User.find({ role: "accountant", isActive: true })
    .select("_id")
    .lean();
  return all.map((s) => String(s._id));
}

// ─── CEO official sending identity ────────────────────────────────

export interface CeoSender {
  userId: Types.ObjectId;
  name: string;
  email: string;
}

/**
 * The CEO whose official identity client emails go out under. Set
 * CEO_SENDER_EMAIL when there is more than one CEO account; otherwise the
 * (oldest) active CEO is used. Throws CeoSenderNotConfiguredError when there
 * is no CEO or the address is not authorised for sending — never falls back to
 * another person's address.
 */
export async function getCeoSender(): Promise<CeoSender> {
  // CEO_SENDER_EMAIL is the CEO's official address when it differs from his
  // login email (e.g. ceo@company.com). Naming it is the administrator's
  // explicit authorisation.
  const override = process.env.CEO_SENDER_EMAIL?.trim().toLowerCase();
  const ceo =
    (override
      ? await User.findOne({ email: override, role: "ceo", isActive: true })
          .select("name email")
          .lean()
      : null) ??
    (await User.findOne({ role: "ceo", isActive: true })
      .sort({ createdAt: 1 })
      .select("name email")
      .lean());
  if (!ceo) assertCeoCanSendAs(null); // throws the "not set up" error
  const email = assertCeoCanSendAs(override || ceo!.email, {
    explicit: !!override,
  });
  return {
    userId: ceo!._id,
    name: process.env.CEO_SENDER_NAME?.trim() || ceo!.name,
    email,
  };
}

/** Non-throwing variant for the UI ("is delivery configured?"). */
export async function ceoSenderStatus(): Promise<{
  configured: boolean;
  email?: string;
  message?: string;
}> {
  try {
    const s = await getCeoSender();
    return { configured: true, email: s.email };
  } catch (err: any) {
    return { configured: false, message: err?.message };
  }
}

// ─── Audit + notifications ────────────────────────────────────────

export async function logReportEvent(e: {
  submissionId?: Types.ObjectId | string;
  clientId: Types.ObjectId | string;
  periodKey?: string;
  action: ReportAuditAction;
  actorId?: Types.ObjectId | string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    // Stamp explicitly so the trail uses the same clock as the workflow
    // (delay attribution compares these times with submission/approval times).
    await ReportAuditEvent.create({ at: new Date(), ...e });
  } catch (err) {
    // The audit trail must never take the workflow down, but must be loud.
    console.error("[ReportAudit] failed to record event", e.action, err);
  }
}

/** In-app notification to each distinct user (skipping `exceptUserId`). */
export async function notifyUsers(
  userIds: (Types.ObjectId | string)[],
  message: string,
  type: string,
  meta: Record<string, unknown>,
  exceptUserId?: string,
): Promise<void> {
  const unique = [...new Set(userIds.map(String))].filter(
    (id) => id && id !== exceptUserId,
  );
  await Promise.all(
    unique.map((id) =>
      createNotification(id, message, type, meta).catch((err) =>
        console.error("[ReportNotify] failed", type, id, err),
      ),
    ),
  );
}

/** id → display name for a set of users (one query). */
export async function userNames(
  ids: (Types.ObjectId | string | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } })
    .select("name")
    .lean();
  return new Map(users.map((u) => [String(u._id), u.name]));
}