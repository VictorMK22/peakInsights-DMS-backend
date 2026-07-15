import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { LearningCategoryModel } from "../models/LearningCategory";
import { DocumentModel } from "../models/Document";

/**
 * Learning Library categories.
 *
 * These are the primary way the library is browsed (per the team's
 * preference for category-first organization over flat tags). Any
 * authenticated role can read the list; only CEO/supervisor can
 * manage it, mirroring the same split used for Departments.
 */

export const getLearningCategories = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { includeInactive } = req.query as Record<string, string>;
    const filter = includeInactive === "true" ? {} : { isActive: true };

    const categories = await LearningCategoryModel.find(filter).sort({
      order: 1,
      name: 1,
    });

    // Live resource count per category so the library can show
    // "Onboarding (12)" without a second round trip per card.
    const counts = await DocumentModel.aggregate([
      {
        $match: {
          documentType: "learning",
          isDeleted: { $ne: true },
          categoryId: { $ne: null },
        },
      },
      { $group: { _id: "$categoryId", count: { $sum: 1 } } },
    ]);
    const countById = new Map(
      counts.map((c) => [c._id?.toString(), c.count as number]),
    );

    const categoriesWithCounts = categories.map((c) => ({
      ...c.toObject(),
      resourceCount: countById.get(c._id.toString()) ?? 0,
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
    if (req.user!.role !== "ceo" && req.user!.role !== "supervisor") {
      res.status(403).json({
        success: false,
        message: "Only the CEO or a supervisor can create categories",
      });
      return;
    }

    const { name, description, icon, color, order } = req.body as {
      name: string;
      description?: string;
      icon?: string;
      color?: string;
      order?: number;
    };
    if (!name?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Category name is required" });
      return;
    }

    const existing = await LearningCategoryModel.findOne({
      name: name.trim(),
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
      createdBy: req.user!.userId,
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
    if (req.user!.role !== "ceo" && req.user!.role !== "supervisor") {
      res.status(403).json({
        success: false,
        message: "Only the CEO or a supervisor can edit categories",
      });
      return;
    }

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

    if (name !== undefined && name.trim()) {
      const clash = await LearningCategoryModel.findOne({
        _id: { $ne: id },
        name: name.trim(),
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
    if (req.user!.role !== "ceo" && req.user!.role !== "supervisor") {
      res.status(403).json({
        success: false,
        message: "Only the CEO or a supervisor can delete categories",
      });
      return;
    }

    const { id } = req.params;
    const category = await LearningCategoryModel.findById(id);
    if (!category) {
      res.status(404).json({ success: false, message: "Category not found" });
      return;
    }

    const inUse = await DocumentModel.countDocuments({
      categoryId: id,
      isDeleted: { $ne: true },
    });
    if (inUse > 0) {
      res.status(409).json({
        success: false,
        message: `Cannot delete — ${inUse} resource(s) are still in this category. Recategorize them first.`,
      });
      return;
    }

    await category.deleteOne();

    res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    next(err);
  }
};
