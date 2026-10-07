import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { DocumentModel } from "../models/Document";
import { AuthRequest } from "../types/auth";
import { buildDocumentVisibilityFilter } from "./documentController";

export const searchDocuments = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      q,
      page = "1",
      limit = "20",
      folderId,
    } = req.query as Record<string, string>;

    if (!q) {
      return res.json({ success: true, data: [] });
    }

    const skip = (Number(page) - 1) * Number(limit);

    const filter: any = {
      $text: { $search: q },
    };

    // =========================
    // 🔐 ROLE-BASED ACCESS
    // Mirrors getDocuments' access rules exactly — search results
    // should never be a subset or superset of what the regular
    // document list shows, just the same set filtered by the query.
    // =========================

    const visibility = await buildDocumentVisibilityFilter(
      req.user!.userId,
      req.user!.role,
    );
    if (visibility) Object.assign(filter, visibility);

    // CEO → no restriction

    // =========================
    // 📁 FOLDER FILTER
    // =========================

    if (folderId) {
      filter["folderId"] = new mongoose.Types.ObjectId(folderId);
    }

    // =========================
    // 🔍 QUERY
    // =========================

    const [results, total] = await Promise.all([
      DocumentModel.find(filter, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .skip(skip)
        .limit(Number(limit))
        .populate("ownerId", "name email")
        .populate("folderId", "name path")
        .lean(),

      DocumentModel.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: results,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
};
