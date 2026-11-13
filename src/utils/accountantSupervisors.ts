import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { workspacesForTeam } from "../controllers/userController";

/**
 * "Accountant supervisors": active supervisors who work in the accountant
 * workspace — i.e. the same rule the app already uses to decide which
 * workspaces a supervisor may enter (workspacesForTeam):
 *   - their active team includes accountants, or
 *   - they have no team yet and sit in an Accounting / Finance department.
 *
 * Returns their ids. One round of queries regardless of how many
 * supervisors there are, so it is cheap enough to call per request.
 */
export const getAccountantSupervisorIds = async (): Promise<Set<string>> => {
  const supervisors = await User.find({ role: "supervisor", isActive: true })
    .select("_id department")
    .lean();
  if (supervisors.length === 0) return new Set();

  const mappings = await SupervisorMapping.find({
    supervisorId: { $in: supervisors.map((s) => s._id) },
    status: "active",
  })
    .select("supervisorId subordinateId")
    .lean();

  const subs = await User.find({
    _id: { $in: mappings.map((m) => m.subordinateId) },
    isActive: true,
  })
    .select("role")
    .lean();
  const roleById = new Map(subs.map((u) => [String(u._id), u.role as string]));

  const rolesBySupervisor = new Map<string, string[]>();
  for (const m of mappings) {
    const role = roleById.get(String(m.subordinateId));
    if (!role) continue; // inactive / missing subordinate
    const key = String(m.supervisorId);
    rolesBySupervisor.set(key, [...(rolesBySupervisor.get(key) ?? []), role]);
  }

  const ids = new Set<string>();
  for (const s of supervisors) {
    const roles = rolesBySupervisor.get(String(s._id)) ?? [];
    if (workspacesForTeam(roles, s.department).includes("accountant")) {
      ids.add(String(s._id));
    }
  }
  return ids;
};
