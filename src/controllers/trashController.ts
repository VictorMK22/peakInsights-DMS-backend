/**
 * trashController.ts
 *
 * A thin aggregation layer over the trash fields that live on
 * Document and Folder directly (isDeleted/deletedAt/deletedBy). The
 * actual trash/restore/permanent-delete actions live on the
 * document/folder controllers next to the rest of each model's CRUD
 * — this file only handles the two things that genuinely need both
 * models at once:
 *
 *   GET  /api/trash        — the combined Trash view (folders + docs)
 *   POST /api/trash/empty  — "Empty Trash" (permanent, irreversible)
 */
import { Response } from "express";
import { AuthRequest } from "../types/auth";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import { FolderModel } from "../models/Folder";
import { DocumentModel } from "../models/Document";
import { CommentModel } from "../models/Comment";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { createAuditLog } from "../utils/auditLogger";
import { attachSignedUrlsToMany } from "./documentController";

// ─────────────────────────────────────────────────────────────────
// GET TRASH
//
// Same visibility rule used everywhere else (own items; supervisors
// also see subordinates'; CEO sees all). Only "top-level" trashed
// items are returned — a document/folder whose parent folder was
// ALSO trashed (i.e. it was swept up by a cascading folder-delete)
// is left out, since it's already represented by that parent. This
// mirrors how Drive's Trash avoids showing every nested file
// individually when you delete a whole folder.
// ─────────────────────────────────────────────────────────────────
export const getTrash = async (req: AuthRequest, res: Response) => {
  try {
    const uid = new mongoose.Types.ObjectId(req.user!.userId);
    const role = req.user!.role;

    let ownerFilter: Record<string, unknown>;
    if (role === "ceo") {
      ownerFilter = {};
    } else if (role === "supervisor") {
      const maps = await SupervisorMapping.find({
        supervisorId: uid,
        status: "active",
      }).select("subordinateId");
      const subIds = maps.map((m) => m.subordinateId);
      ownerFilter = { ownerId: { $in: [uid, ...subIds] } };
    } else {
      ownerFilter = { ownerId: uid };
    }

    const trashedFolders = await FolderModel.find({
      ...ownerFilter,
      isDeleted: true,
    }).sort({ deletedAt: -1 });
    const trashedFolderIds = new Set(trashedFolders.map((f) => String(f._id)));

    const topFolders = trashedFolders.filter(
      (f) =>
        !f.parentFolderId || !trashedFolderIds.has(String(f.parentFolderId)),
    );

    const trashedDocs = await DocumentModel.find({
      ...ownerFilter,
      isDeleted: true,
    })
      .populate("ownerId", "name email")
      .populate("folderId", "name")
      .sort({ deletedAt: -1 })
      .lean();

    const topDocs = trashedDocs.filter((d) => {
      if (!d.folderId) return true;
      const folderId =
        typeof d.folderId === "object" &&
        d.folderId !== null &&
        "_id" in d.folderId
          ? String((d.folderId as { _id: unknown })._id)
          : String(d.folderId);
      return !trashedFolderIds.has(folderId);
    });

    res.json({
      success: true,
      data: {
        folders: topFolders,
        documents: attachSignedUrlsToMany(topDocs),
      },
    });
    return;
  } catch (err) {
    console.error("getTrash error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// EMPTY TRASH
//
// Permanently deletes every folder and document the requester owns
// that is currently in Trash — the point of no return. Scoped
// strictly to ownership (not the broader supervisor/CEO visibility
// getTrash uses) so a supervisor viewing a subordinate's trashed
// items can never wipe someone else's data in one action.
// ─────────────────────────────────────────────────────────────────
export const emptyTrash = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";

    const docs = await DocumentModel.find({
      ownerId: userId,
      isDeleted: true,
    });

    for (const doc of docs) {
      if (!doc.fileKey) continue;
      const p = path.join(uploadDir, doc.fileKey);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* non-fatal */
        }
      }
    }

    const docIds = docs.map((d) => d._id);
    await CommentModel.deleteMany({ documentId: { $in: docIds } });
    await DocumentModel.deleteMany({ ownerId: userId, isDeleted: true });
    await FolderModel.deleteMany({ ownerId: userId, isDeleted: true });

    await createAuditLog({
      actorId: userId,
      action: "permanently_deleted",
      details: { emptiedTrash: true, documentCount: docs.length },
    });

    res.json({ success: true, message: "Trash emptied" });
    return;
  } catch (err) {
    console.error("emptyTrash error:", err);
    res.status(500).json({ success: false });
    return;
  }
};
