import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";

/**
 * A person's "team members": the people they supervise, plus — if they have a
 * supervisor — that supervisor and their peers under the same supervisor.
 * Only active users, never the person themselves. Both the supervisor mapping
 * and the supervisorId on the user are honoured, since either may be the one
 * that's populated.
 */
export const getTeamMembers = async (userId: string) => {
  const me = await User.findById(userId).select("supervisorId").lean();

  const [mappings, reports] = await Promise.all([
    SupervisorMapping.find({ supervisorId: userId, status: "active" })
      .select("subordinateId")
      .lean(),
    User.find({ supervisorId: userId }).select("_id").lean(),
  ]);

  const ids = new Set<string>();
  mappings.forEach((m) => ids.add(String(m.subordinateId)));
  reports.forEach((u) => ids.add(String(u._id)));

  if (me?.supervisorId) {
    const supervisorId = String(me.supervisorId);
    ids.add(supervisorId);
    const peers = await User.find({ supervisorId }).select("_id").lean();
    peers.forEach((u) => ids.add(String(u._id)));
  }
  ids.delete(String(userId));
  if (ids.size === 0) return [];

  return User.find({ _id: { $in: [...ids] }, isActive: true })
    .select("name email role department")
    .sort({ name: 1 })
    .lean();
};