import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { ClientFolderModel, IClientFolder } from "../models/ClientFolder";
import { ClientModel } from "../models/Client";
import { DocumentModel } from "../models/Document";
import { canAccess } from "./clientController";
import { logClientActivity } from "../utils/clientAudit";
import { createAuditLog } from "../utils/auditLogger";
import { canDelete, invalidateCache } from "./documentController";

/**
 * Folders inside a client's Documents tab. Everyone with access to the client
 * sees the same folders. Mounted under /clients/:id (see clientRoutes).
 *
 * Who may do what:
 *   - create a folder / see folders      : anyone with access to the client
 *   - rename or delete a folder          : whoever created it, or the CEO
 *   - move a document in/out of a folder : the uploader of that document, or the CEO
 * Deleting a folder returns its documents to the main list. If the caller asks
 * for it (?deleteDocuments=true) the documents they are allowed to delete go to
 * Trash instead — recoverable, like any other document delete.
 */

const MAX_NAME_LENGTH = 80;
const MAX_FOLDERS_PER_CLIENT = 200;

const isValidId = (v: unknown): v is string =>
  typeof v === "string" && mongoose.Types.ObjectId.isValid(v);

const nameKeyOf = (name: string) => name.trim().toLowerCase();

/** Validates a folder name from the request body. Returns the error or the name. */
const parseName = (raw: unknown): { error: string } | { name: string } => {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { error: "Folder name is required" };
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `Folder name must be ${MAX_NAME_LENGTH} characters or fewer` };
  }
  return { name };
};

const canManageFolder = (
  folder: Pick<IClientFolder, "createdBy">,
  userId: string,
  role: string,
): boolean => role === "ceo" || folder.createdBy.toString() === userId;

/** Access to the client, or an error response already sent. */
const requireClientAccess = async (
  req: AuthRequest,
  res: Response,
): Promise<boolean> => {
  const clientId = req.params.id;
  if (!isValidId(clientId)) {
    res.status(400).json({ success: false, message: "Invalid client" });
    return false;
  }
  if (!(await canAccess(clientId, req.user!.userId, req.user!.role))) {
    res.status(403).json({ success: false, message: "Access denied" });
    return false;
  }
  return true;
};

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;

// GET /clients/:id/folders
export const listClientFolders = async (req: AuthRequest, res: Response) => {
  try {
    if (!(await requireClientAccess(req, res))) return;
    const clientId = new mongoose.Types.ObjectId(req.params.id);

    const [folders, counts, unfiledCount] = await Promise.all([
      ClientFolderModel.find({ clientId })
        .populate("createdBy", "name role")
        .sort({ name: 1 })
        .collation({ locale: "en", strength: 2 })
        .lean(),
      DocumentModel.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
        {
          $match: {
            clientId,
            clientFolderId: { $ne: null },
            isDeleted: { $ne: true },
          },
        },
        { $group: { _id: "$clientFolderId", n: { $sum: 1 } } },
      ]),
      DocumentModel.countDocuments({
        clientId,
        clientFolderId: null,
        isDeleted: { $ne: true },
      }),
    ]);

    const countById = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json({
      success: true,
      data: {
        folders: folders.map((f) => ({
          ...f,
          documentCount: countById.get(String(f._id)) ?? 0,
        })),
        unfiledCount,
      },
    });
  } catch {
    res.status(500).json({ success: false });
  }
};

// POST /clients/:id/folders   { name }
export const createClientFolder = async (req: AuthRequest, res: Response) => {
  try {
    if (!(await requireClientAccess(req, res))) return;
    const parsed = parseName(req.body?.name);
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const clientId = new mongoose.Types.ObjectId(req.params.id);

    if ((await ClientFolderModel.countDocuments({ clientId })) >= MAX_FOLDERS_PER_CLIENT) {
      res.status(400).json({
        success: false,
        message: `A client can have at most ${MAX_FOLDERS_PER_CLIENT} folders`,
      });
      return;
    }

    let folder;
    try {
      folder = await ClientFolderModel.create({
        clientId,
        name: parsed.name,
        nameKey: nameKeyOf(parsed.name),
        createdBy: new mongoose.Types.ObjectId(req.user!.userId),
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        res.status(409).json({
          success: false,
          message: `A folder named "${parsed.name}" already exists for this client`,
        });
        return;
      }
      throw err;
    }

    const client = await ClientModel.findById(clientId).select("name").lean();
    await logClientActivity(req, {
      clientId,
      clientName: client?.name,
      category: "document",
      action: "folder_created",
      summary: `Created document folder "${folder.name}"`,
    });

    res.status(201).json({
      success: true,
      data: { folder: { ...folder.toObject(), documentCount: 0 } },
    });
  } catch {
    res.status(500).json({ success: false });
  }
};

// PUT /clients/:id/folders/:folderId   { name }
export const renameClientFolder = async (req: AuthRequest, res: Response) => {
  try {
    if (!(await requireClientAccess(req, res))) return;
    const { folderId } = req.params;
    if (!isValidId(folderId)) {
      res.status(400).json({ success: false, message: "Invalid folder" });
      return;
    }
    const parsed = parseName(req.body?.name);
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }

    const folder = await ClientFolderModel.findOne({
      _id: folderId,
      clientId: req.params.id,
    });
    if (!folder) {
      res.status(404).json({ success: false, message: "Folder not found" });
      return;
    }
    if (!canManageFolder(folder, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "Only the person who created this folder, or the CEO, can rename it",
      });
      return;
    }

    const previous = folder.name;
    folder.name = parsed.name;
    folder.nameKey = nameKeyOf(parsed.name);
    try {
      await folder.save();
    } catch (err) {
      if (isDuplicateKey(err)) {
        res.status(409).json({
          success: false,
          message: `A folder named "${parsed.name}" already exists for this client`,
        });
        return;
      }
      throw err;
    }

    await logClientActivity(req, {
      clientId: req.params.id,
      category: "document",
      action: "folder_renamed",
      summary: `Renamed document folder "${previous}" to "${folder.name}"`,
    });
    res.json({ success: true, data: { folder } });
  } catch {
    res.status(500).json({ success: false });
  }
};

// DELETE /clients/:id/folders/:folderId[?deleteDocuments=true]
// By default the documents inside go back to the client's main list.
// With deleteDocuments=true, the documents the caller may delete (the owner or
// the CEO — never an accountant) are moved to Trash; any the caller may NOT
// delete are returned to the main list rather than destroyed or left hidden.
export const deleteClientFolder = async (req: AuthRequest, res: Response) => {
  try {
    if (!(await requireClientAccess(req, res))) return;
    const { folderId } = req.params;
    if (!isValidId(folderId)) {
      res.status(400).json({ success: false, message: "Invalid folder" });
      return;
    }

    const folder = await ClientFolderModel.findOne({
      _id: folderId,
      clientId: req.params.id,
    });
    if (!folder) {
      res.status(404).json({ success: false, message: "Folder not found" });
      return;
    }
    if (!canManageFolder(folder, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "Only the person who created this folder, or the CEO, can delete it",
      });
      return;
    }

    const { userId, role } = req.user!;
    let trashedIds: mongoose.Types.ObjectId[] = [];

    if (req.query.deleteDocuments === "true") {
      const inFolder = await DocumentModel.find({
        clientId: req.params.id,
        clientFolderId: folder._id,
        isDeleted: { $ne: true },
      }).select("_id ownerId documentType");

      trashedIds = inFolder
        .filter((d) => canDelete(d, userId, role))
        .map((d) => d._id as mongoose.Types.ObjectId);

      if (trashedIds.length) {
        await DocumentModel.updateMany(
          { _id: { $in: trashedIds } },
          {
            $set: {
              isDeleted: true,
              deletedAt: new Date(),
              deletedBy: new mongoose.Types.ObjectId(userId),
            },
            // Out of the folder too, so a restore lands in the main list
            // instead of pointing at a folder that no longer exists.
            $unset: { clientFolderId: "" },
          },
        );
        await Promise.all(
          trashedIds.map((id) =>
            createAuditLog({ documentId: String(id), actorId: userId, action: "trashed" }),
          ),
        );
        await invalidateCache(userId);
      }
    }

    // Live documents go back to the main list (this is the number we report)…
    const released = await DocumentModel.updateMany(
      { clientId: req.params.id, clientFolderId: folder._id, isDeleted: { $ne: true } },
      { $unset: { clientFolderId: "" } },
    );
    // …and anything already in Trash stops pointing at the folder we're deleting.
    await DocumentModel.updateMany(
      { clientId: req.params.id, clientFolderId: folder._id },
      { $unset: { clientFolderId: "" } },
    );
    await folder.deleteOne();

    await logClientActivity(req, {
      clientId: req.params.id,
      category: "document",
      action: "folder_deleted",
      summary:
        trashedIds.length > 0
          ? `Deleted document folder "${folder.name}" — ${trashedIds.length} document(s) moved to Trash` +
            (released.modifiedCount > 0
              ? `, ${released.modifiedCount} returned to the main list (not allowed to delete them)`
              : "")
          : `Deleted document folder "${folder.name}" (${released.modifiedCount} document(s) returned to the main list)`,
    });
    res.json({
      success: true,
      message: "Folder deleted",
      data: {
        releasedDocuments: released.modifiedCount,
        trashedDocuments: trashedIds.length,
      },
    });
  } catch {
    res.status(500).json({ success: false });
  }
};

// PUT /clients/:id/documents/:docId/folder   { folderId: string | null }
// folderId null/omitted = back to the client's main list.
export const moveClientDocument = async (req: AuthRequest, res: Response) => {
  try {
    if (!(await requireClientAccess(req, res))) return;
    const { docId } = req.params;
    if (!isValidId(docId)) {
      res.status(400).json({ success: false, message: "Invalid document" });
      return;
    }

    const doc = await DocumentModel.findOne({
      _id: docId,
      clientId: req.params.id,
      isDeleted: { $ne: true },
    }).select("title ownerId clientFolderId");
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }
    if (
      req.user!.role !== "ceo" &&
      doc.ownerId.toString() !== req.user!.userId
    ) {
      res.status(403).json({
        success: false,
        message: "You can only move documents you uploaded",
      });
      return;
    }

    const raw = req.body?.folderId;
    let target: IClientFolder | null = null;
    if (raw !== null && raw !== undefined && raw !== "") {
      if (!isValidId(raw)) {
        res.status(400).json({ success: false, message: "Invalid folder" });
        return;
      }
      target = await ClientFolderModel.findOne({
        _id: raw,
        clientId: req.params.id,
      });
      if (!target) {
        res.status(404).json({ success: false, message: "Folder not found" });
        return;
      }
    }

    const unchanged = String(doc.clientFolderId ?? "") === String(target?._id ?? "");
    if (!unchanged) {
      await DocumentModel.updateOne(
        { _id: doc._id },
        target
          ? { $set: { clientFolderId: target._id } }
          : { $unset: { clientFolderId: "" } },
      );
      await logClientActivity(req, {
        clientId: req.params.id,
        category: "document",
        action: "document_moved",
        summary: target
          ? `Moved "${doc.title}" into folder "${target.name}"`
          : `Moved "${doc.title}" out of its folder`,
      });
    }

    res.json({ success: true, message: "Document moved" });
  } catch {
    res.status(500).json({ success: false });
  }
};