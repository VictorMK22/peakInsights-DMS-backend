import { Response } from "express";
import { AuthRequest } from "../types/auth";
import { FolderModel } from "../models/Folder";
import { DocumentModel } from "../models/Document";
import { AuditLog } from "../models/AuditLog";
import { CommentModel } from "../models/Comment";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { createAuditLog } from "../utils/auditLogger";
import mongoose from "mongoose";
import { copyObjectInS3, deleteFromS3 } from "../services/s3Storage";

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Deep-clones a single document row onto disk + in the DB under a new
 * owner/folder. Used by copyFolder (recursive) and copyDocument
 * (single file) so both share one code path for "duplicate a file".
 * The physical file is copied to a brand-new UUID-named path so the
 * clone is fully independent of the original.
 */
export const cloneDocumentRecord = async (
  srcDoc: InstanceType<typeof DocumentModel>,
  destFolderId: mongoose.Types.ObjectId | null,
  newOwnerId: string,
  _uploadDir: string, // kept for call-site compatibility — unused now that files live in S3, not a local directory
  titleOverride?: string,
): Promise<InstanceType<typeof DocumentModel>> => {
  let newFileKey: string | undefined;
  if (srcDoc.fileKey) {
    newFileKey = await copyObjectInS3(srcDoc.fileKey);
  }

  return DocumentModel.create({
    title: titleOverride ?? srcDoc.title,
    description: srcDoc.description,
    fileName: srcDoc.fileName,
    fileKey: newFileKey,
    fileType: srcDoc.fileType,
    fileSize: srcDoc.fileSize,
    contentText: srcDoc.contentText,
    documentType: srcDoc.documentType,
    status: "draft",
    priority: srcDoc.priority,
    tags: srcDoc.tags,
    ownerId: newOwnerId,
    folderId: destFolderId,
    metadata: srcDoc.metadata,
  });
};

/** Folder-boundary-aware "is this path the same as, or a descendant of, base" check. */
const isSameOrDescendantPath = (path: string, base: string): boolean =>
  path === base || path.startsWith(`${base}/`);

/** Owner, the owner's supervisor, or CEO. Same rule used for documents. */
const canAccessFolder = async (
  folder: { ownerId: mongoose.Types.ObjectId | string },
  userId: string,
  role: string,
): Promise<boolean> => {
  if (role === "ceo" || role === "tech") return true;
  if (folder.ownerId.toString() === userId) return true;
  if (role === "supervisor") {
    const mapping = await SupervisorMapping.findOne({
      supervisorId: userId,
      subordinateId: folder.ownerId,
      status: "active",
    });
    return !!mapping;
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────
// SELF-HEALING documentType RESOLUTION
//
// Folders created before `documentType` existed on the schema have
// it unset, which broke the Working/Stored tabs two ways: such a
// folder would show up under BOTH tabs (nothing to filter it out),
// and it wouldn't count toward either tab's total.
//
// Rather than a one-off migration script, this infers the type the
// first time an untagged folder is read and persists it, so the fix
// applies automatically without needing DB access:
//   1. If a document inside the folder already has a documentType,
//      use that (majority isn't needed in practice — a folder's
//      contents are always uploaded under one tab at a time).
//   2. Else inherit from the parent folder (recursively resolved).
//   3. Else (empty root folder) default to "working".
// ─────────────────────────────────────────────────────────────────
export const resolveFolderType = async (
  folder: InstanceType<typeof FolderModel>,
): Promise<"working" | "storage" | "learning"> => {
  if (folder.documentType) return folder.documentType;

  let inferred: "working" | "storage" | "learning" | undefined;

  const sampleDoc = await DocumentModel.findOne({ folderId: folder._id })
    .select("documentType")
    .lean();
  if (sampleDoc?.documentType) {
    inferred = sampleDoc.documentType as any;
  } else if (folder.parentFolderId) {
    const parent = await FolderModel.findById(folder.parentFolderId);
    if (parent) inferred = await resolveFolderType(parent);
  }

  inferred = inferred ?? "working";
  folder.documentType = inferred;
  await folder.save();
  return inferred;
};

export const createFolder = async (req: AuthRequest, res: Response) => {
  try {
    const { name, parentFolderId, documentType } = req.body;
    if (!name?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Folder name is required" });
      return;
    }

    let parentPath = "";
    // A folder's type is a structural property of its location, not a
    // free choice per-folder — a subfolder always belongs to the same
    // tab as its parent (you can't put a "Stored" folder inside a
    // "Working" one). Root folders (no parent) get their type from
    // whichever tab the client was on when it clicked "New Folder".
    let resolvedType: "working" | "storage" | "learning" | undefined;

    if (parentFolderId) {
      const parent = await FolderModel.findById(parentFolderId);
      if (!parent) {
        res
          .status(404)
          .json({ success: false, message: "Parent folder not found" });
        return;
      }
      parentPath = parent.path;
      resolvedType = await resolveFolderType(parent);
    } else {
      resolvedType =
        documentType === "storage" || documentType === "learning"
          ? documentType
          : "working";
    }

    const path = `${parentPath}/${name.trim()}`;
    const folder = await FolderModel.create({
      name: name.trim(),
      parentFolderId: parentFolderId ?? null,
      ownerId: req.user!.userId,
      path,
      documentType: resolvedType,
    });
    res.json({ success: true, data: folder });
    return;
  } catch (err: any) {
    // Unique index on { ownerId, path } — same name already exists at this level
    if (err?.code === 11000) {
      res.status(409).json({
        success: false,
        message: "A folder with this name already exists here",
      });
      return;
    }
    console.error("createFolder error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// GET ROOT CONTENTS
//
// Returns top-level folders VISIBLE to the requesting user.
//
// Supervisor: sees their own folders + folders of their subordinates.
// CEO: sees all folders (no ownership restriction).
// User: sees only their own folders.
//
// Documents at root are returned by the separate paginated /documents
// endpoint (DriveExplorer Query B) — NOT here. This endpoint only
// returns folders so there's no duplication.
//
// MUST be registered BEFORE /:folderId/contents so "root" is not
// consumed by the param matcher.
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// GET STARRED FOLDERS
// Flat list (no folder-tree nesting) of every starred folder visible
// to the requester, same visibility rule as getRootContents. Paired
// with GET /documents?starred=true on the frontend's "Starred" view.
// Must be registered before /:folderId/contents (see note there).
// ─────────────────────────────────────────────────────────────────
export const getStarredFolders = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const uid = new mongoose.Types.ObjectId(userId);

    let ownerFilter: Record<string, unknown>;
    if (role === "ceo" || role === "tech") {
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

    const folders = await FolderModel.find({
      ...ownerFilter,
      isStarred: true,
      isDeleted: { $ne: true },
    }).sort({ name: 1 });

    res.json({ success: true, data: { folders } });
    return;
  } catch (err) {
    console.error("getStarredFolders error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

export const getRootContents = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const uid = new mongoose.Types.ObjectId(userId);
    const { documentType } = req.query as { documentType?: string };

    let ownerFilter: Record<string, unknown>;

    if (role === "ceo" || role === "tech") {
      // CEO sees everything
      ownerFilter = {};
    } else if (role === "supervisor") {
      // Supervisor sees own folders + subordinate folders
      const maps = await SupervisorMapping.find({
        supervisorId: uid,
        status: "active",
      }).select("subordinateId");
      const subIds = maps.map((m) => m.subordinateId);
      ownerFilter = { ownerId: { $in: [uid, ...subIds] } };
    } else {
      // User sees only their own folders
      ownerFilter = { ownerId: uid };
    }

    const allRootFolders = await FolderModel.find({
      ...ownerFilter,
      parentFolderId: null,
      isDeleted: { $ne: true },
    }).sort({ name: 1 });

    // Self-heal any folder created before documentType existed, then
    // filter to the requested tab. Without this, older folders show
    // up under every tab (nothing to filter them by) and never count
    // toward any tab's total.
    const resolved = await Promise.all(
      allRootFolders.map(async (f) => ({
        folder: f,
        type: await resolveFolderType(f),
      })),
    );
    const folders = documentType
      ? resolved.filter((r) => r.type === documentType).map((r) => r.folder)
      : allRootFolders;

    // Root-level documents are fetched separately by DriveExplorer
    // via GET /documents?folderId=null — we don't return them here
    // to avoid double-fetching and the old redundancy problem.
    res.json({ success: true, data: { folders, documents: [] } });
    return;
  } catch (err) {
    console.error("getRootContents error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// GET FOLDER CONTENTS
//
// Returns subfolders and documents inside a specific folder.
// Access check: user must own the folder or be its supervisor/CEO.
// ─────────────────────────────────────────────────────────────────
export const getFolderContents = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const userId = req.user!.userId;
    const role = req.user!.role;

    // Verify the folder exists and the user can access it
    const folder = await FolderModel.findById(folderId);
    if (!folder) {
      return res
        .status(404)
        .json({ success: false, message: "Folder not found" });
    }

    if (!(await canAccessFolder(folder, userId, role))) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    // Self-heal this folder's own type too — its subfolders inherit
    // from it going forward, so it needs to be resolved first.
    await resolveFolderType(folder);

    const [folders, documents] = await Promise.all([
      FolderModel.find({
        parentFolderId: folderId,
        isDeleted: { $ne: true },
      }).sort({
        name: 1,
      }),
      DocumentModel.find({ folderId, isDeleted: { $ne: true } })
        .select(
          "title fileType documentType createdAt folderId description isStarred",
        )
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    res.json({ success: true, data: { folders, documents } });
    return;
  } catch (err) {
    console.error("getFolderContents error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// GET FOLDER ACTIVITY
// Same access rule as getFolderContents — without this check, anyone
// authenticated could read the audit trail (who viewed/edited/deleted
// what) of every document inside any folder, just by guessing an ID.
// ─────────────────────────────────────────────────────────────────
export const getFolderActivity = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const userId = req.user!.userId;
    const role = req.user!.role;

    const folder = await FolderModel.findById(folderId);
    if (!folder) {
      res.status(404).json({ success: false, message: "Folder not found" });
      return;
    }

    if (!(await canAccessFolder(folder, userId, role))) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const docs = await DocumentModel.find({ folderId }).select("_id");
    const docIds = docs.map((d) => d._id);
    const logs = await AuditLog.find({ documentId: { $in: docIds } })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, data: logs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

// ─────────────────────────────────────────────────────────────────
// RENAME / UPDATE FOLDER
//
// Folders previously had create/move/delete but no rename — this
// closes that gap. Only the owner can rename (same rule as move and
// delete below). Renaming updates this folder's own path plus every
// descendant's path, exactly like moveFolder does for a re-parent.
// ─────────────────────────────────────────────────────────────────
export const updateFolder = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const { name } = req.body as { name?: string };

    if (!name?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Folder name is required" });
      return;
    }

    const folder = await FolderModel.findById(folderId);
    if (!folder) {
      res.status(404).json({ success: false, message: "Folder not found" });
      return;
    }
    if (folder.ownerId.toString() !== req.user!.userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const trimmedName = name.trim();
    if (trimmedName === folder.name) {
      res.json({ success: true, data: folder });
      return;
    }

    // Recompute this folder's path from its parent + new name, then
    // rewrite every descendant's path the same way moveFolder does.
    const parentPath = folder.path.slice(
      0,
      folder.path.length - folder.name.length - 1,
    );
    const oldPath = folder.path;
    const newPath = `${parentPath}/${trimmedName}`;

    // Guard against a duplicate sibling name at this level.
    const clash = await FolderModel.findOne({
      _id: { $ne: folder._id },
      parentFolderId: folder.parentFolderId,
      ownerId: folder.ownerId,
      name: trimmedName,
    });
    if (clash) {
      res.status(409).json({
        success: false,
        message: "A folder with this name already exists here",
      });
      return;
    }

    const subfolders = await FolderModel.find({
      path: { $regex: `^${escapeRegex(oldPath)}(/|$)` },
    });
    for (const sub of subfolders) {
      sub.path = sub.path.replace(oldPath, newPath);
      await sub.save();
    }

    folder.name = trimmedName;
    folder.path = newPath;
    await folder.save();

    res.json({ success: true, message: "Folder renamed", data: folder });
    return;
  } catch (err: any) {
    if (err?.code === 11000) {
      res.status(409).json({
        success: false,
        message: "A folder with this name already exists here",
      });
      return;
    }
    console.error("updateFolder error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

export const moveFolder = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const { targetParentId } = req.body;
    const folder = await FolderModel.findById(folderId);
    if (!folder) return res.status(404).json({ success: false });
    if (folder.ownerId.toString() !== req.user!.userId)
      return res.status(403).json({ success: false });

    if (targetParentId) {
      const target = await FolderModel.findById(targetParentId);
      if (!target)
        return res
          .status(404)
          .json({ success: false, message: "Target not found" });
      if (isSameOrDescendantPath(target.path, folder.path)) {
        return res.status(400).json({
          success: false,
          message: "Cannot move folder inside itself",
        });
      }
    }

    const newParent = targetParentId
      ? await FolderModel.findById(targetParentId)
      : null;
    const newPath = newParent
      ? `${newParent.path}/${folder.name}`
      : `/${folder.name}`;
    const oldPath = folder.path;

    const subfolders = await FolderModel.find({
      path: { $regex: `^${escapeRegex(oldPath)}(/|$)` },
    });

    // Re-parenting can move a folder into a different tab's tree —
    // recompute its type from the new parent (or default to its
    // existing type if moved to root) and cascade to every
    // descendant, so the Working/Stored split stays consistent.
    const newType = newParent
      ? await resolveFolderType(newParent)
      : (folder.documentType ?? "working");

    for (const sub of subfolders) {
      sub.path = sub.path.replace(oldPath, newPath);
      sub.documentType = newType;
      await sub.save();
    }
    folder.parentFolderId = targetParentId || null;
    folder.path = newPath;
    folder.documentType = newType;
    await folder.save();
    res.json({ success: true });
    return;
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// TRASH FOLDER (soft delete, cascades to every descendant + document)
//
// Google Drive semantics: deleting a folder moves it (and everything
// inside it) to Trash rather than erasing it. Nothing is removed from
// disk here — that only happens on permanentlyDeleteFolder or when
// the trash is emptied.
// ─────────────────────────────────────────────────────────────────
export const deleteFolderRecursive = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { folderId } = req.params;
    const folder = await FolderModel.findById(folderId);
    if (!folder) return res.status(404).json({ success: false });
    if (folder.ownerId.toString() !== req.user!.userId)
      return res.status(403).json({ success: false });

    const foldersToDelete = await FolderModel.find({
      path: { $regex: `^${escapeRegex(folder.path)}(/|$)` },
    });
    const folderIds = foldersToDelete.map((f) => f._id);
    const now = new Date();

    await FolderModel.updateMany(
      { _id: { $in: folderIds } },
      {
        $set: { isDeleted: true, deletedAt: now, deletedBy: req.user!.userId },
      },
    );
    await DocumentModel.updateMany(
      { folderId: { $in: folderIds } },
      {
        $set: { isDeleted: true, deletedAt: now, deletedBy: req.user!.userId },
      },
    );

    await createAuditLog({
      actorId: req.user!.userId,
      action: "trashed",
      details: { folderId: String(folder._id), name: folder.name },
    });

    res.json({
      success: true,
      message: "Folder and all contents moved to Trash",
    });
    return;
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// RESTORE FOLDER (out of Trash), cascading back to every descendant
// folder/document that was trashed in the same operation.
//
// If the parent folder is missing or still in Trash, the folder is
// restored to root instead of resurrecting into a dangling/hidden
// parent — same behavior Drive uses when you restore an item whose
// parent is also deleted.
// ─────────────────────────────────────────────────────────────────
export const restoreFolder = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const folder = await FolderModel.findById(folderId);
    if (!folder) {
      res.status(404).json({ success: false, message: "Folder not found" });
      return;
    }
    if (folder.ownerId.toString() !== req.user!.userId) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }
    if (!folder.isDeleted) {
      res.json({
        success: true,
        message: "Folder is not in Trash",
        data: folder,
      });
      return;
    }

    let parentGone = false;
    if (folder.parentFolderId) {
      const parent = await FolderModel.findById(folder.parentFolderId);
      parentGone = !parent || parent.isDeleted;
    }

    if (parentGone) {
      const oldPath = folder.path;
      const newPath = `/${folder.name}`;
      const subfolders = await FolderModel.find({
        path: { $regex: `^${escapeRegex(oldPath)}(/|$)` },
      });
      for (const sub of subfolders) {
        sub.path = sub.path.replace(oldPath, newPath);
        await sub.save();
      }
      folder.parentFolderId = undefined;
      folder.path = newPath;
    }
    await folder.save();

    const foldersToRestore = await FolderModel.find({
      path: { $regex: `^${escapeRegex(folder.path)}(/|$)` },
    });
    const folderIds = foldersToRestore.map((f) => f._id);

    await FolderModel.updateMany(
      { _id: { $in: folderIds } },
      {
        $set: { isDeleted: false, deletedAt: null },
        $unset: { deletedBy: "" },
      },
    );
    await DocumentModel.updateMany(
      { folderId: { $in: folderIds } },
      {
        $set: { isDeleted: false, deletedAt: null },
        $unset: { deletedBy: "" },
      },
    );

    // The bulk update above already persisted this in the DB — mirror
    // it on the in-memory doc too, so the response reflects reality
    // instead of the pre-restore snapshot.
    folder.isDeleted = false;
    folder.deletedAt = null;
    folder.deletedBy = undefined;

    await createAuditLog({
      actorId: req.user!.userId,
      action: "restored",
      details: { folderId: String(folder._id), name: folder.name },
    });

    res.json({ success: true, message: "Folder restored", data: folder });
    return;
  } catch (err) {
    console.error("restoreFolder error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// PERMANENTLY DELETE FOLDER — actually removes the folder, every
// descendant folder, every document inside (and their files on disk).
// Only allowed once the folder is already in Trash, matching Drive's
// "you can't skip the trash" model and giving a confirmation step.
// ─────────────────────────────────────────────────────────────────
export const permanentlyDeleteFolder = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { folderId } = req.params;
    const folder = await FolderModel.findById(folderId);
    if (!folder) return res.status(404).json({ success: false });
    if (folder.ownerId.toString() !== req.user!.userId)
      return res.status(403).json({ success: false });
    if (!folder.isDeleted) {
      res.status(400).json({
        success: false,
        message: "Move the folder to Trash before deleting it permanently",
      });
      return;
    }

    const foldersToDelete = await FolderModel.find({
      path: { $regex: `^${escapeRegex(folder.path)}(/|$)` },
    });
    const folderIds = foldersToDelete.map((f) => f._id);

    const docsToDelete = await DocumentModel.find({
      folderId: { $in: folderIds },
    }).select("fileKey");
    for (const doc of docsToDelete) {
      if (!doc.fileKey) continue;
      await deleteFromS3(doc.fileKey);
    }

    const docIds = docsToDelete.map((d) => d._id);
    await CommentModel.deleteMany({ documentId: { $in: docIds } });
    await DocumentModel.deleteMany({ folderId: { $in: folderIds } });
    await FolderModel.deleteMany({ _id: { $in: folderIds } });

    await createAuditLog({
      actorId: req.user!.userId,
      action: "permanently_deleted",
      details: { folderId: String(folder._id), name: folder.name },
    });

    res.json({
      success: true,
      message: "Folder and all contents permanently deleted",
    });
    return;
  } catch (err) {
    console.error("permanentlyDeleteFolder error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// TOGGLE STAR
// ─────────────────────────────────────────────────────────────────
export const toggleStarFolder = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const folder = await FolderModel.findById(folderId);
    if (!folder) {
      res.status(404).json({ success: false, message: "Folder not found" });
      return;
    }
    if (!(await canAccessFolder(folder, req.user!.userId, req.user!.role))) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }
    folder.isStarred = !folder.isStarred;
    await folder.save();
    await createAuditLog({
      actorId: req.user!.userId,
      action: folder.isStarred ? "starred" : "unstarred",
      details: { folderId: String(folder._id), name: folder.name },
    });
    res.json({ success: true, data: folder });
    return;
  } catch (err) {
    console.error("toggleStarFolder error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// COPY / DUPLICATE FOLDER
//
// Deep-copies the folder, every subfolder, and every document inside
// (each document's physical file is duplicated on disk too, so the
// copy is fully independent of the original — editing or deleting one
// never affects the other). The copy is always owned by the requester
// and always lands in the current tab's type.
// ─────────────────────────────────────────────────────────────────
export const copyFolder = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const { targetParentId } = req.body as { targetParentId?: string | null };

    const folder = await FolderModel.findById(folderId);
    if (!folder) {
      res.status(404).json({ success: false, message: "Folder not found" });
      return;
    }
    if (!(await canAccessFolder(folder, req.user!.userId, req.user!.role))) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const userId = req.user!.userId;

    let newParent: InstanceType<typeof FolderModel> | null = null;
    if (targetParentId) {
      newParent = await FolderModel.findById(targetParentId);
      if (!newParent) {
        res.status(404).json({ success: false, message: "Target not found" });
        return;
      }
    }

    // Pick a non-colliding name at the destination level, Drive-style
    // ("X (copy)", "X (copy 2)", ...).
    const siblingFilter = {
      ownerId: userId,
      parentFolderId: newParent ? newParent._id : null,
    };
    let baseName = targetParentId ? folder.name : `${folder.name} (copy)`;
    let candidate = baseName;
    let n = 2;
    while (await FolderModel.findOne({ ...siblingFilter, name: candidate })) {
      candidate = `${baseName} (${n++})`;
    }

    const parentPath = newParent ? newParent.path : "";
    const rootCopy = await FolderModel.create({
      name: candidate,
      parentFolderId: newParent ? newParent._id : null,
      ownerId: userId,
      path: `${parentPath}/${candidate}`,
      documentType: newParent
        ? await resolveFolderType(newParent)
        : folder.documentType,
    });

    // Recursively clone descendants (subfolders + their documents),
    // preserving relative structure under the new root.
    const cloneChildren = async (
      srcFolder: InstanceType<typeof FolderModel>,
      destFolder: InstanceType<typeof FolderModel>,
    ) => {
      const [childFolders, childDocs] = await Promise.all([
        FolderModel.find({
          parentFolderId: srcFolder._id,
          isDeleted: { $ne: true },
        }),
        DocumentModel.find({
          folderId: srcFolder._id,
          isDeleted: { $ne: true },
        }),
      ]);

      for (const doc of childDocs) {
        await cloneDocumentRecord(doc, destFolder._id, userId, "");
      }

      for (const child of childFolders) {
        const newChild = await FolderModel.create({
          name: child.name,
          parentFolderId: destFolder._id,
          ownerId: userId,
          path: `${destFolder.path}/${child.name}`,
          documentType: destFolder.documentType,
        });
        await cloneChildren(child, newChild);
      }
    };

    await cloneChildren(folder, rootCopy);

    await createAuditLog({
      actorId: userId,
      action: "copied",
      details: {
        sourceFolderId: String(folder._id),
        newFolderId: String(rootCopy._id),
      },
    });

    res.json({ success: true, message: "Folder copied", data: rootCopy });
    return;
  } catch (err) {
    console.error("copyFolder error:", err);
    res.status(500).json({ success: false });
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// BULK DELETE FOLDERS
// Same rule as single delete (owner only). Each requested folder
// (and everything nested under it) is expanded into the full set of
// descendant folder ids first, de-duplicated across the whole
// selection — this matters because the client may select a folder
// AND one of its own subfolders at the same time. Folders the caller
// doesn't own are skipped and reported in `failed` rather than
// failing the whole batch.
// ─────────────────────────────────────────────────────────────────
export const bulkDeleteFolders = async (req: AuthRequest, res: Response) => {
  try {
    const { folderIds } = req.body as { folderIds?: string[] };
    if (!Array.isArray(folderIds) || folderIds.length === 0) {
      res
        .status(400)
        .json({ success: false, message: "No folder ids provided" });
      return;
    }

    const uniqueIds = [...new Set(folderIds)].filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    );
    const folders = await FolderModel.find({ _id: { $in: uniqueIds } });
    const foundIds = new Set(folders.map((f) => String(f._id)));

    const deletedIds: string[] = [];
    const failed: { id: string; reason: "not_found" | "forbidden" }[] = [];
    for (const id of uniqueIds) {
      if (!foundIds.has(id)) failed.push({ id, reason: "not_found" });
    }

    const allFolderIdsToDelete = new Set<string>();
    for (const folder of folders) {
      if (folder.ownerId.toString() !== req.user!.userId) {
        failed.push({ id: String(folder._id), reason: "forbidden" });
        continue;
      }
      const descendants = await FolderModel.find({
        path: { $regex: `^${escapeRegex(folder.path)}(/|$)` },
      }).select("_id");
      descendants.forEach((d) => allFolderIdsToDelete.add(String(d._id)));
      deletedIds.push(String(folder._id));
    }

    if (allFolderIdsToDelete.size > 0) {
      const idsArray = [...allFolderIdsToDelete];
      const now = new Date();
      await FolderModel.updateMany(
        { _id: { $in: idsArray } },
        {
          $set: {
            isDeleted: true,
            deletedAt: now,
            deletedBy: req.user!.userId,
          },
        },
      );
      await DocumentModel.updateMany(
        { folderId: { $in: idsArray } },
        {
          $set: {
            isDeleted: true,
            deletedAt: now,
            deletedBy: req.user!.userId,
          },
        },
      );
    }

    await createAuditLog({
      actorId: req.user!.userId,
      action: "trashed",
      details: { folderIds: deletedIds },
    });

    res.json({
      success: true,
      message: `${deletedIds.length} folder${deletedIds.length === 1 ? "" : "s"} moved to Trash${
        failed.length ? `, ${failed.length} skipped` : ""
      }`,
      data: { deletedIds, failed },
    });
    return;
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
    return;
  }
};
