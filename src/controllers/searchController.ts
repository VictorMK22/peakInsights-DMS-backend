import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { DocumentModel } from "../models/Document";
import { TaskModel } from "../models/Task";
import { AuthRequest } from "../types/auth";
import { SupervisorMapping } from "../models/SupervisorMapping";

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

    const userId = new mongoose.Types.ObjectId(req.user?.userId);
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

    if (req.user?.role === "user" || req.user?.role === "accountant") {
      const activeTasks = await TaskModel.find({
        status: "in_progress",
        documentId: { $exists: true },
        collaborators: { $elemMatch: { userId, status: "active" } },
      }).select("documentId");
      const linkedIds = activeTasks.map((t) => t.documentId).filter(Boolean);

      filter["$or"] = [
        { ownerId: userId },
        { _id: { $in: linkedIds } },
        { documentType: "learning" },
      ];
    }

    if (req.user?.role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: userId,
        status: "active",
      }).select("subordinateId");

      const subordinateIds = mappings.map((m) => m.subordinateId);

      filter["$or"] = [
        { ownerId: userId },
        { ownerId: { $in: subordinateIds } },
        { supervisorId: userId },
        { documentType: "learning" },
      ];
    }

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
