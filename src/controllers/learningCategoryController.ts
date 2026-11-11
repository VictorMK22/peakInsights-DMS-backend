import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { LearningCategoryModel } from "../models/LearningCategory";
import { DocumentModel } from "../models/Document";

/**
 * Document categories.
 *
 * Originally the Learning Library's taxonomy; now every document type —
 * working, storage and learning — can be filed under a category when it is
 * uploaded. (The model/route keep their "learning" names so existing data
 * and clients keep working.)
 *
 *   learning  Shared taxonomy, managed by CEO / tech / supervisor, readable
 *             by every role.
 *   working / storage
 *             Personal by default: a user creates and sees only their own.
 *             CEO / tech / supervisor may also create a *shared* one
 *             (`shared: true`) that every user can file under.
 */

export type CategoryDocType = "working" | "storage" | "learning";
const DOC_TYPES: CategoryDocType[] = ["working", "storage", "learning"];

const isManagement = (role?: string) =>
  role === "ceo" || role === "tech" || role === "supervisor";

const parseDocType = (raw: unknown): CategoryDocType | undefined =>
  DOC_TYPES.includes(raw as CategoryDocType)
    ? (raw as CategoryDocType)
    : undefined;

// Rows created before categories covered every type have no documentType.
const typeFilter = (type: CategoryDocType) =>
  type === "learning"
    ? { $or: [{ documentType: "learning" }, { documentType: { $exists: false } }] }
    : { documentType: type };

const effectiveType = (c: { documentType?: string }): CategoryDocType =>
  (c.documentType as CategoryDocType) ?? "learning";

// A category is visible when it is shared (no owner) or belongs to the caller.
const visibleTo = (userId: string) => ({
  $or: [
    { ownerId: { $exists: false } },
    { ownerId: null },
    { ownerId: new mongoose.Types.ObjectId(userId) },
  ],
});

/** Can this user create/edit/delete the given category? */
const canManage = (
  category: { documentType?: string; ownerId?: mongoose.Types.ObjectId | null },
  userId: string,
  role?: string,
): boolean => {
  if (category.ownerId) return String(category.ownerId) === userId;
  if (effectiveType(category) === "learning") return isManagement(role);
  return isManagement(role); // shared working/storage → management only
};

/**
 * Is `categoryId` a valid choice for a document of `documentType` uploaded by
 * `userId`? Used by the document controller on create/update.
 */
export const validateCategoryForDocument = async (
  categoryId: string,
  documentType: CategoryDocType,
  userId: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    return { ok: false, message: "Invalid category" };
  }
  const category = await LearningCategoryModel.findOne({
    _id: categoryId,
    ...typeFilter(documentType),
    ...visibleTo(userId),
  })
    .select("_id isActive")
    .lean();
  if (!category) {
    return {
      ok: false,
      message: `That category isn't available for ${documentType} documents`,
    };
  }
  if (category.isActive === false) {
    return { ok: false, message: "That category is no longer active" };
  }
  return { ok: true };
};

export const getLearningCategories = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { includeInactive, documentType } = req.query as Record<
      string,
      string
    >;
    const userId = req.user!.userId;
    // No documentType → the library's original behaviour (learning only).
    const type = parseDocType(documentType) ?? "learning";

    const filter: Record<string, unknown> = {
      $and: [typeFilter(type), visibleTo(userId)],
    };
    if (includeInactive !== "true") filter.isActive = true;

    const categories = await LearningCategoryModel.find(filter).sort({
      order: 1,
      name: 1,
    });

    // Live resource count per category so the UI can show "Onboarding (12)"
    // without a second round trip. Learning material is shared, so its counts
    // are library-wide; working/storage counts only cover the caller's own
    // documents so they never reveal what other people have filed.
    const countMatch: Record<string, unknown> = {
      documentType: type,
      isDeleted: { $ne: true },
      categoryId: { $in: categories.map((c) => c._id) },
    };
    if (type !== "learning") {
      countMatch.ownerId = new mongoose.Types.ObjectId(userId);
    }
    const counts = await DocumentModel.aggregate([
      { $match: countMatch },
      { $group: { _id: "$categoryId", count: { $sum: 1 } } },
    ]);
    const countById = new Map(
      counts.map((c) => [c._id?.toString(), c.count as number]),
    );

    const categoriesWithCounts = categories.map((c) => ({
      ...c.toObject(),
      documentType: effectiveType(c),
      resourceCount: countById.get(c._id.toString()) ?? 0,
      // Lets the UI offer edit/delete only where the caller may use them.
      canManage: canManage(c, userId, req.user!.role),
    }));

    res.json({
      success: true,
      message: "Categories retrieved",
      data: { categories: categoriesWithCounts },
    });
  } catch (err) {
    next(err);
  }
};

export const createLearningCategory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const { name, description, icon, color, order, documentType, shared } =
      req.body as {
        name: string;
        description?: string;
        icon?: string;
        color?: string;
        order?: number;
        documentType?: string;
        shared?: boolean;
      };

    const type = parseDocType(documentType) ?? "learning";

    if (type === "learning" && !isManagement(role)) {
      res.status(403).json({
        success: false,
        message: "Only the CEO or a supervisor can create learning categories",
      });
      return;
    }
    if (type !== "learning" && shared && !isManagement(role)) {
      res.status(403).json({
        success: false,
        message: "Only the CEO or a supervisor can create shared categories",
      });
      return;
    }
    if (!name?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Category name is required" });
      return;
    }

    // Learning + shared categories live in one shared namespace; personal ones
    // are unique per owner.
    const isPersonal = type !== "learning" && !shared;
    const existing = await LearningCategoryModel.findOne({
      name: name.trim(),
      ...typeFilter(type),
      ...(isPersonal
        ? { ownerId: new mongoose.Types.ObjectId(userId) }
        : { $or: [{ ownerId: { $exists: false } }, { ownerId: null }] }),
    }).collation({ locale: "en", strength: 2 });
    if (existing) {
      res.status(409).json({
        success: false,
        message: "A category with this name already exists",
      });
      return;
    }

    const category = await LearningCategoryModel.create({
      name: name.trim(),
      description: description?.trim(),
      icon,
      color,
      order: order ?? 0,
      documentType: type,
      ownerId: isPersonal ? userId : undefined,
      createdBy: userId,
    });

    res.status(201).json({
      success: true,
      message: "Category created",
      data: { category },
    });
  } catch (err) {
    next(err);
  }
};

export const updateLearningCategory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, description, icon, color, order, isActive } = req.body as {
      name?: string;
      description?: string;
      icon?: string;
      color?: string;
      order?: number;
      isActive?: boolean;
    };

    const category = await LearningCategoryModel.findById(id);
    if (!category) {
      res.status(404).json({ success: false, message: "Category not found" });
      return;
    }
    if (!canManage(category, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "You can't edit this category",
      });
      return;
    }

    if (name !== undefined && name.trim()) {
      const clash = await LearningCategoryModel.findOne({
        _id: { $ne: id },
        name: name.trim(),
        ...typeFilter(effectiveType(category)),
        ownerId: category.ownerId ?? { $in: [null] },
      }).collation({ locale: "en", strength: 2 });
      if (clash) {
        res.status(409).json({
          success: false,
          message: "A category with this name already exists",
        });
        return;
      }
      category.name = name.trim();
    }
    if (description !== undefined) category.description = description.trim();
    if (icon !== undefined) category.icon = icon;
    if (color !== undefined) category.color = color;
    if (order !== undefined) category.order = order;
    if (isActive !== undefined) category.isActive = isActive;

    await category.save();

    res.json({
      success: true,
      message: "Category updated",
      data: { category },
    });
  } catch (err) {
    next(err);
  }
};

export const deleteLearningCategory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    const category = await LearningCategoryModel.findById(id);
    if (!category) {
      res.status(404).json({ success: false, message: "Category not found" });
      return;
    }
    if (!canManage(category, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "You can't delete this category",
      });
      return;
    }

    const inUse = await DocumentModel.countDocuments({
      categoryId: id,
      isDeleted: { $ne: true },
    });
    if (inUse > 0) {
      res.status(409).json({
        success: false,
        message: `Cannot delete — ${inUse} document(s) are still in this category. Recategorize them first.`,
      });
      return;
    }

    await category.deleteOne();

    res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    next(err);
  }
};