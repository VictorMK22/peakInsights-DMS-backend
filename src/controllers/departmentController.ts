import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { Department } from "../models/Department";
import { User } from "../models/User";

/**
 * CEO ONLY — creates a new department.
 * Departments are the single source of truth used to populate the
 * department dropdown everywhere a department needs to be picked
 * (create user, create supervisor, assign user to supervisor).
 */
export const createDepartment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can create departments",
      });
      return;
    }

    const { name, description } = req.body as {
      name: string;
      description?: string;
    };
    if (!name?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Department name is required" });
      return;
    }

    const existing = await Department.findOne({
      name: name.trim(),
    }).collation({ locale: "en", strength: 2 });
    if (existing) {
      res.status(409).json({
        success: false,
        message: "A department with this name already exists",
      });
      return;
    }

    const department = await Department.create({
      name: name.trim(),
      description: description?.trim(),
      createdBy: req.user.userId,
    });

    res.status(201).json({
      success: true,
      message: "Department created",
      data: { department },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Any authenticated role can view the list of departments — it's
 * needed to populate dropdowns (e.g. profile page, create-user forms).
 * Only the CEO gets management actions (create/edit/delete) on the
 * frontend, enforced by the routes below.
 */
export const getAllDepartments = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { includeInactive } = req.query as Record<string, string>;
    const filter = includeInactive === "true" ? {} : { isActive: true };

    const departments = await Department.find(filter).sort({ name: 1 });

    // Attach a live head-count so the CEO can see how many people are
    // in each department without a separate round trip.
    const counts = await User.aggregate([
      { $match: { isActive: true, department: { $ne: null } } },
      { $group: { _id: "$department", count: { $sum: 1 } } },
    ]);
    const countByName = new Map(counts.map((c) => [c._id, c.count]));

    const departmentsWithCounts = departments.map((d) => ({
      ...d.toObject(),
      userCount: countByName.get(d.name) ?? 0,
    }));

    res.json({
      success: true,
      message: "Departments retrieved",
      data: { departments: departmentsWithCounts },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — updates a department's name/description.
 * Renaming a department also updates the department string stored on
 * every user/supervisor currently assigned to it, so the two stay in
 * sync (User.department is a denormalized copy of Department.name).
 */
export const updateDepartment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res
        .status(403)
        .json({ success: false, message: "Only the CEO can edit departments" });
      return;
    }

    const { id } = req.params as { id: string };
    const { name, description, isActive } = req.body as {
      name?: string;
      description?: string;
      isActive?: boolean;
    };

    const department = await Department.findById(id);
    if (!department) {
      res.status(404).json({ success: false, message: "Department not found" });
      return;
    }

    const oldName = department.name;

    if (name !== undefined && name.trim()) {
      const clash = await Department.findOne({
        _id: { $ne: id },
        name: name.trim(),
      }).collation({ locale: "en", strength: 2 });
      if (clash) {
        res.status(409).json({
          success: false,
          message: "A department with this name already exists",
        });
        return;
      }
      department.name = name.trim();
    }
    if (description !== undefined) department.description = description.trim();
    if (isActive !== undefined) department.isActive = isActive;

    await department.save();

    if (name && department.name !== oldName) {
      await User.updateMany(
        { department: oldName },
        { department: department.name },
      );
    }

    res.json({
      success: true,
      message: "Department updated",
      data: { department },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * CEO ONLY — deletes a department.
 * Blocked if any active user is currently assigned to it, so deleting
 * a department can never silently orphan a user's department field —
 * the CEO must reassign those people first.
 */
export const deleteDepartment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (req.user?.role !== "ceo" && req.user?.role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the CEO can delete departments",
      });
      return;
    }

    const { id } = req.params as { id: string };
    const department = await Department.findById(id);
    if (!department) {
      res.status(404).json({ success: false, message: "Department not found" });
      return;
    }

    const usersInDept = await User.countDocuments({
      department: department.name,
      isActive: true,
    });
    if (usersInDept > 0) {
      res.status(409).json({
        success: false,
        message: `Cannot delete — ${usersInDept} active user(s) are still assigned to this department. Reassign them first.`,
      });
      return;
    }

    await department.deleteOne();

    res.json({ success: true, message: "Department deleted" });
  } catch (err) {
    next(err);
  }
};
