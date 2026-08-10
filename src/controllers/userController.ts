import { Response, NextFunction } from "express";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { DocumentModel } from "../models/Document";
import { FolderModel } from "../models/Folder";
import { AuthRequest } from "../types/auth";
import { generateToken } from "../services/authService";
import { sendAccountCreatedByCEOEmail } from "../services/emailService";
import mongoose from "mongoose";
import Notification from "../models/Notification";

/**
 * There is no generic "normal user" role in this system — every
 * account is one of: ceo, supervisor, sales_person, accountant, tech.
 * When a supervisor is demoted, they don't fall back to a blank
 * catch-all role; they fall back to whichever *staff* role matches
 * the department they're already in. This is the single place that
 * mapping lives, shared by demoteSupervisor and the one-off
 * migration script (scripts/migrateNormalUsers.ts) that moved any
 * pre-existing "user"-role accounts onto a real role.
 *
 * Falls back to "sales_person" when the department doesn't match a
 * known pattern (or is blank) — sales_person is the closest thing
 * this system has to a general-purpose staff role.
 */
export function roleForDepartment(
  department?: string,
): "accountant" | "tech" | "sales_person" {
  const dept = (department ?? "").trim();
  if (/account(ing|s)?|finance/i.test(dept)) return "accountant";
  if (/^ict$|information\s*technology|\btech\b/i.test(dept)) return "tech";
  return "sales_person";
}

/**
 * CEO ONLY — creates a supervisor account directly.
 * Middleware: requireCEO must be applied on the route.
 */
export const createSupervisor = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can create supervisor accounts",
      });
      return;
    }

    const { name, email, password, department } = req.body as {
      name: string;
      email: string;
      password: string;
      department?: string;
    };

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "Email already registered",
      });
      return;
    }

    const user = await User.create({
      name,
      email,
      password,
      role: "supervisor",
      department,
      createdBy: req.user?.userId,
      accountStatus: "active",
      isActive: true,
      approvedBy: req.user?.userId as unknown as mongoose.Types.ObjectId,
      approvedAt: new Date(),
    });

    const token = generateToken(user);

    sendAccountCreatedByCEOEmail(
      user.email,
      user.name,
      password,
      "supervisor",
    ).catch((err) =>
      console.error(
        "❌ sendAccountCreatedByCEOEmail failed (account still created):",
        err,
      ),
    );

    res.status(201).json({
      success: true,
      message: "Supervisor account created",
      data: { user, token },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — creates a sales person / Business Development Officer (BD)
 * account directly. Sales persons can create their own client leads and
 * move them through the sales pipeline (see clientController).
 */
export const createSalesPerson = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can create sales person accounts",
      });
      return;
    }

    const { name, email, password, department } = req.body as {
      name: string;
      email: string;
      password: string;
      department?: string;
    };

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "Email already registered",
      });
      return;
    }

    const user = await User.create({
      name,
      email,
      password,
      role: "sales_person",
      department,
      createdBy: req.user?.userId,
      accountStatus: "active",
      isActive: true,
      approvedBy: req.user?.userId as unknown as mongoose.Types.ObjectId,
      approvedAt: new Date(),
    });

    const token = generateToken(user);

    sendAccountCreatedByCEOEmail(
      user.email,
      user.name,
      password,
      "sales_person",
    ).catch((err) =>
      console.error(
        "❌ sendAccountCreatedByCEOEmail failed (account still created):",
        err,
      ),
    );

    res.status(201).json({
      success: true,
      message: "Sales person account created",
      data: { user, token },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — creates an accountant account directly. Accountants serve
 * clients assigned to them by the CEO — both existing clients and
 * clients won by the sales team — and communicate with those clients
 * (messages, email, WhatsApp) the same way a sales person or regular
 * user does, scoped by Client.assignedTo (see clientController.canAccess).
 */
export const createAccountant = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can create accountant accounts",
      });
      return;
    }

    const { name, email, password } = req.body as {
      name: string;
      email: string;
      password: string;
      department?: string;
    };

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "Email already registered",
      });
      return;
    }

    // Accountants are always placed in the Accounting department —
    // hardcoded server-side (not just defaulted client-side) so this
    // can never drift, whether from a stale frontend, a direct API
    // call, or a future form change. Any `department` sent in the
    // request body is intentionally ignored.
    const user = await User.create({
      name,
      email,
      password,
      role: "accountant",
      department: "Accounting",
      createdBy: req.user?.userId,
      accountStatus: "active",
      isActive: true,
      approvedBy: req.user?.userId as unknown as mongoose.Types.ObjectId,
      approvedAt: new Date(),
    });

    const token = generateToken(user);

    sendAccountCreatedByCEOEmail(
      user.email,
      user.name,
      password,
      "accountant",
    ).catch((err) =>
      console.error(
        "❌ sendAccountCreatedByCEOEmail failed (account still created):",
        err,
      ),
    );

    res.status(201).json({
      success: true,
      message: "Accountant account created",
      data: { user, token },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — creates a "tech" (admin) account. Tech accounts have
 * near-CEO level access: user management, all clients/documents, and
 * system configuration (departments, learning categories, email
 * integrations). See every `role === "ceo" || role === "tech"` check
 * across the controllers/routes for the exact scope. Tech accounts are
 * protected from deletion/demotion the same way CEO accounts are.
 */
export const createTech = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can create tech/admin accounts",
      });
      return;
    }

    const { name, email, password } = req.body as {
      name: string;
      email: string;
      password: string;
      department?: string;
    };

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "Email already registered",
      });
      return;
    }

    // Tech accounts are always placed in the ICT department — same
    // hardcoded-server-side rule as createAccountant/Accounting. Any
    // `department` sent in the request body is intentionally ignored.
    const user = await User.create({
      name,
      email,
      password,
      role: "tech",
      department: "ICT",
      createdBy: req.user?.userId,
      accountStatus: "active",
      isActive: true,
      approvedBy: req.user?.userId as unknown as mongoose.Types.ObjectId,
      approvedAt: new Date(),
    });

    const token = generateToken(user);

    sendAccountCreatedByCEOEmail(user.email, user.name, password, "tech").catch(
      (err) =>
        console.error(
          "❌ sendAccountCreatedByCEOEmail failed (account still created):",
          err,
        ),
    );

    res.status(201).json({
      success: true,
      message: "Tech/admin account created",
      data: { user, token },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — promotes an existing user to supervisor. Any non-CEO role
 * (normal user, tech, accountant) is eligible — the only account that
 * can never be promoted/demoted is the CEO's own.
 */
export const promoteToSupervisor = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res
        .status(403)
        .json({ success: false, message: "Only the CEO can promote users" });
      return;
    }

    const { id } = req.params as { id: string };
    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    if (user.role === "ceo") {
      res
        .status(403)
        .json({ success: false, message: "Cannot change the CEO's role" });
      return;
    }
    if (user.role === "supervisor") {
      res
        .status(400)
        .json({ success: false, message: "User is already a supervisor" });
      return;
    }

    await SupervisorMapping.updateMany(
      { subordinateId: user._id, status: "active" },
      { status: "historical", deactivationDate: new Date() },
    );

    user.role = "supervisor";
    await user.save();

    res.json({
      success: true,
      message: `${user.name} promoted to Supervisor`,
      data: { user },
    });
  } catch (err) {
    next(err);
  }
};

export const getAllUsers = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      role,
      isActive,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (role) filter["role"] = role;
    if (isActive) filter["isActive"] = isActive === "true";

    // Supervisors can only see their own team members
    if (req.user?.role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: req.user.userId,
        status: "active",
      }).select("subordinateId");
      filter["_id"] = { $in: mappings.map((m) => m.subordinateId) };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [users, total] = await Promise.all([
      User.find(filter)
        // profilePicture can be a multi-MB inline base64 data URI (users
        // upload a photo, it gets stored directly on the document rather
        // than as a file reference). Fine for a single-user fetch, but on
        // a list endpoint even one such user bloats the whole response —
        // slow enough to time out or fail silently client-side, which is
        // exactly what made the Normal Users tab look empty. List views
        // only ever render an initial letter, never the actual image, so
        // there's nothing lost by leaving it out here.
        .select("-password -profilePicture")
        .skip(skip)
        .limit(Number(limit))
        .sort({ createdAt: -1 }),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      message: "Users retrieved",
      data: { users },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

export const updateUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const updates = req.body as Partial<{
      name: string;
      department: string;
      isActive: boolean;
    }>;

    // Accountants and tech accounts always stay in their fixed
    // department (Accounting / ICT respectively) — same rule enforced
    // at creation time (see createAccountant/createTech). An edit
    // should never be able to drift either out of it, so any
    // department change in this request is dropped for those roles.
    if (updates.department !== undefined) {
      const existing = await User.findById(id).select("role");
      if (existing?.role === "accountant" || existing?.role === "tech") {
        delete updates.department;
      }
    }

    const user = await User.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).select("-password");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.json({ success: true, message: "User updated", data: { user } });
  } catch (err) {
    next(err);
  }
};

export const deleteUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const user = await User.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true },
    );
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    await SupervisorMapping.updateMany(
      { $or: [{ supervisorId: id }, { subordinateId: id }], status: "active" },
      { status: "historical", deactivationDate: new Date() },
    );
    res.json({ success: true, message: "User deactivated successfully" });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — permanently and irreversibly deletes a user account.
 * This is deliberately a separate action from deleteUser (deactivate)
 * above, not a replacement for it — deactivation stays the default,
 * reversible way to remove someone's access. This is for the "actually
 * erase the account" case.
 *
 * Guardrails, in order:
 *  1. Can never delete a CEO or tech account — those roles are
 *     edit/deactivate-activate only, protected by their near-CEO
 *     trust level. Accountants CAN be permanently deleted (subject to
 *     the same owned-content check as everyone else below) — the CEO
 *     just needs to reassign/clear their clients and documents first.
 *  2. If they're a supervisor with anyone currently assigned to them,
 *     refuse — those people need to be reassigned first, or they'd be
 *     left pointing at a supervisor that no longer exists.
 *  3. If they own any documents or folders, refuse — those are real
 *     business records (invoices, contracts, etc.) that shouldn't
 *     vanish as a side effect of removing a person. The CEO needs to
 *     explicitly reassign or delete that content first.
 *
 * What DOES get cleaned up automatically: every SupervisorMapping row
 * referencing this user (as supervisor or subordinate, active or
 * historical) — those are meaningless once the account is gone.
 *
 * What deliberately does NOT get touched: tasks, messages, emails,
 * comments, and audit log entries authored by or referencing this
 * user. Those are historical records — audit trail in particular
 * should never disappear just because the actor's account was later
 * deleted — so they're left in place with a dangling userId. Any UI
 * that renders those should already be prepared to show a fallback
 * for a user that no longer resolves (the same situation a populate()
 * against a deleted document produces today).
 */
export const permanentlyDeleteUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    if (user.role === "ceo" || user.role === "tech") {
      res.status(403).json({
        success: false,
        message: "CEO/tech accounts cannot be deleted — deactivate instead",
      });
      return;
    }

    if (user.role === "supervisor") {
      const activeSubordinates = await SupervisorMapping.countDocuments({
        supervisorId: id,
        status: "active",
      });
      if (activeSubordinates > 0) {
        res.status(409).json({
          success: false,
          message: `This supervisor still has ${activeSubordinates} team member${activeSubordinates === 1 ? "" : "s"} assigned to them. Reassign or remove those first.`,
        });
        return;
      }
    }

    const [ownedDocs, ownedFolders] = await Promise.all([
      DocumentModel.countDocuments({ ownerId: id }),
      FolderModel.countDocuments({ ownerId: id }),
    ]);
    if (ownedDocs > 0 || ownedFolders > 0) {
      res.status(409).json({
        success: false,
        message: `This user still owns ${ownedDocs} document${ownedDocs === 1 ? "" : "s"} and ${ownedFolders} folder${ownedFolders === 1 ? "" : "s"}. Reassign or delete their content before deleting the account.`,
      });
      return;
    }

    await SupervisorMapping.deleteMany({
      $or: [{ supervisorId: id }, { subordinateId: id }],
    });
    await user.deleteOne();

    res.json({ success: true, message: "User permanently deleted" });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — assigns a user to a supervisor.
 */
export const assignUserToSupervisor = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can assign users to supervisors",
      });
      return;
    }

    const { supervisorId, userId, departmentName } = req.body as {
      supervisorId: string;
      userId: string;
      departmentName?: string;
    };

    const supervisor = await User.findById(supervisorId).select("department");
    if (!supervisor) {
      res.status(404).json({ success: false, message: "Supervisor not found" });
      return;
    }

    // The department field is required on the mapping — if the client
    // didn't send one (e.g. it was left blank), fall back to the
    // supervisor's own department so a mapping is never created with
    // no department context.
    const effectiveDepartment = departmentName?.trim() || supervisor.department;
    if (!effectiveDepartment) {
      res.status(400).json({
        success: false,
        message:
          "Department is required — the selected supervisor has no department set, so one must be chosen manually",
      });
      return;
    }

    await SupervisorMapping.updateMany(
      { subordinateId: new mongoose.Types.ObjectId(userId), status: "active" },
      { status: "historical", deactivationDate: new Date() },
    );

    const mapping = await SupervisorMapping.create({
      supervisorId: new mongoose.Types.ObjectId(supervisorId),
      subordinateId: new mongoose.Types.ObjectId(userId),
      departmentName: effectiveDepartment,
      assignmentDate: new Date(),
      status: "active",
      assignedBy: req.user?.userId,
    });

    // Keep the subordinate's own `department` field in sync with the
    // department they were just assigned under, so it shows correctly
    // everywhere else (user lists, contacts, dropdowns) without the
    // CEO having to set it twice.
    //
    // Exception: tech and accountant accounts have a fixed department
    // (ICT / Accounting respectively — see createTech/createAccountant
    // and updateUser) that must never drift, even when they're
    // assigned under a supervisor from a different department. So the
    // sync is skipped for those two roles; the mapping itself still
    // records `effectiveDepartment` for reporting purposes.
    const subordinate = await User.findById(userId).select("role");
    if (
      subordinate &&
      subordinate.role !== "tech" &&
      subordinate.role !== "accountant"
    ) {
      await User.findByIdAndUpdate(userId, { department: effectiveDepartment });
    }

    const populated = await SupervisorMapping.findById(mapping._id)
      .populate("supervisorId", "name email department")
      .populate("subordinateId", "name email department");

    res.status(201).json({
      success: true,
      message: "User assigned to supervisor",
      data: { mapping: populated },
    });
  } catch (err) {
    next(err);
  }
};

export const getMappings = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { supervisorId, status } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (supervisorId)
      filter["supervisorId"] = new mongoose.Types.ObjectId(supervisorId);
    if (status) filter["status"] = status;

    if (req.user?.role === "supervisor") {
      filter["supervisorId"] = new mongoose.Types.ObjectId(req.user.userId);
    }

    const mappings = await SupervisorMapping.find(filter)
      .populate("supervisorId", "name email department")
      .populate("subordinateId", "name email department")
      .sort({ assignmentDate: -1 });

    res.json({
      success: true,
      message: "Mappings retrieved",
      data: { mappings },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — archives a single mapping.
 */
export const deleteMapping = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res
        .status(403)
        .json({ success: false, message: "Only the CEO can remove mappings" });
      return;
    }

    const { mappingId } = req.params as { mappingId: string };
    const mapping = await SupervisorMapping.findById(mappingId);
    if (!mapping) {
      res.status(404).json({ success: false, message: "Mapping not found" });
      return;
    }
    if (mapping.status !== "active") {
      res
        .status(400)
        .json({ success: false, message: "Mapping is already archived" });
      return;
    }

    mapping.status = "historical";
    mapping.deactivationDate = new Date();
    await mapping.save();

    res.json({ success: true, message: "Mapping removed", data: { mapping } });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — demotes a supervisor back to normal user.
 */
export const demoteSupervisor = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can demote supervisors",
      });
      return;
    }

    const { id } = req.params as { id: string };
    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    if (user.role === "ceo") {
      res
        .status(403)
        .json({ success: false, message: "Cannot demote the CEO" });
      return;
    }
    if (user.role !== "supervisor") {
      res
        .status(400)
        .json({ success: false, message: "User is not a supervisor" });
      return;
    }

    await SupervisorMapping.updateMany(
      { supervisorId: user._id, status: "active" },
      { status: "historical", deactivationDate: new Date() },
    );

    // A demoted supervisor doesn't fall back to a blank "normal user"
    // role — there isn't one. They land on whichever staff role
    // matches the department they're already in (see
    // roleForDepartment's docstring for the full rationale/mapping).
    const newRole = roleForDepartment(user.department);
    user.role = newRole;
    user.accountStatus = "active";
    await user.save();

    res.json({
      success: true,
      message: `${user.name} demoted to ${newRole.replace("_", " ")}`,
      data: { user },
    });
  } catch (err) {
    next(err);
  }
};

export const getMyProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = await User.findById(req.user?.userId).select("-password");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
};

export const updateMyProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { name, bio, phone, department, profilePicture } = req.body as {
      name?: string;
      bio?: string;
      phone?: string;
      department?: string;
      profilePicture?: string;
    };
    const user = await User.findById(req.user?.userId);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    if (name) user.name = name;
    if (bio !== undefined) user.bio = bio;
    if (phone !== undefined) user.phone = phone;
    if (department !== undefined) user.department = department;
    if (profilePicture !== undefined) {
      // Defense-in-depth: the frontend resizes/compresses before sending,
      // but this endpoint can be called directly (Postman, another
      // client), so don't trust that alone. ~500KB is generous for a
      // 400px JPEG avatar (typically tens of KB) while still catching
      // anything that would reproduce the original list-query bloat.
      if (profilePicture.length > 500_000) {
        res.status(400).json({
          success: false,
          message: "Profile picture is too large — please use a smaller image",
        });
        return;
      }
      user.profilePicture = profilePicture;
    }
    await user.save();
    res.json({ success: true, message: "Profile updated", data: { user } });
  } catch (err) {
    next(err);
  }
};

export const getUserProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const viewer = req.user!;
    const user = await User.findById(id).select("-password");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    if (viewer.role === "supervisor") {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: viewer.userId,
        subordinateId: id,
        status: "active",
      });
      if (!mapping) {
        res.status(403).json({
          success: false,
          message: "You can only view profiles of your team members",
        });
        return;
      }
    }

    res.json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
};

export const getNotifications = async (req: AuthRequest, res: Response) => {
  const notifications = await Notification.find({
    userId: req.user!.userId,
  }).sort({ createdAt: -1 });
  res.json({ success: true, data: notifications });
};

/**
 * GET /users/teammates
 *
 * Returns the other active users who report to the same supervisor as
 * the requester — i.e. their peers/teammates. Any authenticated role
 * can call this (unlike /users and /users/mappings, which are
 * management-only) — it's what the task-collaboration "invite a
 * teammate" picker uses, since a regular 'user' has no other way to
 * discover who's on their team.
 */
export const getMyTeammates = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const me = await User.findById(req.user!.userId).select("supervisorId");
    if (!me?.supervisorId) {
      res.json({ success: true, data: { teammates: [] } });
      return;
    }

    const teammates = await User.find({
      supervisorId: me.supervisorId,
      _id: { $ne: req.user!.userId },
      isActive: true,
      // profilePicture excluded — see the note in getAllUsers above.
      // Same failure mode: one teammate with a large inline avatar would
      // bloat this list response for everyone using the invite picker.
    }).select("name email role");

    res.json({ success: true, data: { teammates } });
    return;
  } catch (err) {
    console.error("getMyTeammates error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// Deliberately separate from getAllUsers (CEO-only, full admin
// record) — this exists so the ICT Team page can offer a "pick a
// person" list without tech needing full user-management access.
// Minimal fields only, same rationale as getMyTeammates above.
export const getDirectory = async (
  _req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const users = await User.find({ isActive: true })
      .select("name email department")
      .sort({ name: 1 });
    res.json({ success: true, data: { users } });
  } catch (err) {
    console.error("getDirectory error:", err);
    res.status(500).json({ success: false });
  }
};
