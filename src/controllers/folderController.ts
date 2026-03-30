import { Response } from "express"
import mongoose from "mongoose"
import { AuthRequest } from "../types/auth"
import { FolderModel } from "../models/Folder"
import { DocumentModel } from "../models/Document"
import { AuditLog } from "../models/AuditLog";

export const createFolder = async (req: AuthRequest, res: Response) => {

  const { name, parentFolderId } = req.body

  let parentPath = ""

  if (parentFolderId) {
    const parent = await FolderModel.findById(parentFolderId)

    if (!parent) {
      return res.status(404).json({ success: false, message: "Parent folder not found" })
    }

    parentPath = parent.path
  }

  const path = `${parentPath}/${name}`

  const folder = await FolderModel.create({
    name,
    parentFolderId: parentFolderId ?? null,
    ownerId: req.user!.userId,
    path
  })

  res.json({
    success: true,
    data: folder
  })
}

export const getFolderContents = async (req: AuthRequest, res: Response) => {

  const { folderId } = req.params

  const folders = await FolderModel.find({
    parentFolderId: folderId
  })

  const documents = await mongoose.model("Document").find({
    folderId
  })

  res.json({
    success: true,
    data: {
      folders,
      documents
    }
  })
}

export const getFolderActivity = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;

    const docs = await DocumentModel.find({ folderId }).select("_id");

    const docIds = docs.map(d => d._id);

    const logs = await AuditLog.find({
      documentId: { $in: docIds }
    })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      data: logs
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

export const moveFolder = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;
    const { targetParentId } = req.body;

    const folder = await FolderModel.findById(folderId);

    if (!folder) {
      return res.status(404).json({ success: false });
    }

    if (folder.ownerId.toString() !== req.user!.userId) {
      return res.status(403).json({ success: false });
    }

    // 🔥 Prevent circular move
    if (targetParentId) {
      const target = await FolderModel.findById(targetParentId);

      if (!target) {
        return res.status(404).json({ success: false, message: "Target not found" });
      }

      if (target.path.startsWith(folder.path)) {
        return res.status(400).json({
          success: false,
          message: "Cannot move folder inside itself"
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

    // 🔥 Update all subfolders
    const subfolders = await FolderModel.find({
      path: { $regex: `^${oldPath}` }
    });

    for (const sub of subfolders) {
      sub.path = sub.path.replace(oldPath, newPath);
      await sub.save();
    }

    folder.parentFolderId = targetParentId || null;
    folder.path = newPath;
    await folder.save();

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};

export const deleteFolderRecursive = async (req: AuthRequest, res: Response) => {
  try {
    const { folderId } = req.params;

    const folder = await FolderModel.findById(folderId);

    if (!folder) {
      return res.status(404).json({ success: false });
    }

    if (folder.ownerId.toString() !== req.user!.userId) {
      return res.status(403).json({ success: false });
    }

    // 🔥 Find all nested folders
    const foldersToDelete = await FolderModel.find({
      path: { $regex: `^${folder.path}` }
    });

    const folderIds = foldersToDelete.map(f => f._id);

    // 🔥 Delete documents inside all folders
    await DocumentModel.deleteMany({
      folderId: { $in: folderIds }
    });

    // 🔥 Delete folders
    await FolderModel.deleteMany({
      _id: { $in: folderIds }
    });

    res.json({
      success: true,
      message: "Folder and all contents deleted"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};