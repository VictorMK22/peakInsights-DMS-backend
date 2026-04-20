/**
 * documentController.ts
 *
 * DOCUMENTS ARE PURE FILE STORAGE.
 *
 * What documents do:
 *   ✅ Upload (single / multiple / folder)        POST   /documents
 *   ✅ List documents                              GET    /documents
 *   ✅ Get one document                            GET    /documents/:id
 *   ✅ Update metadata (title, desc, tags…)       PUT    /documents/:id
 *   ✅ Upload new file version                     POST   /documents/:id/versions
 *   ✅ List all versions                           GET    /documents/:id/versions
 *   ✅ Restore an older version                    PATCH  /documents/:id/versions/:vNum/restore
 *   ✅ Delete a specific version                   DELETE /documents/:id/versions/:vNum
 *   ✅ Patch inline text content (Yjs / editor)   PATCH  /documents/:id/content
 *   ✅ Delete document entirely                    DELETE /documents/:id
 *   ✅ Preview (DOCX→HTML, PDF, images)            GET    /documents/:id/preview
 *   ✅ Download                                    GET    /documents/:id/download
 *   ✅ Move to folder                              PUT    /documents/:id/move
 *   ✅ Activity log                                GET    /documents/:id/activity
 *   ✅ Create comment                              POST   /documents/:id/comments
 *   ✅ List comments                               GET    /documents/:id/comments
 *   ✅ Update own comment                          PUT    /documents/:id/comments/:commentId
 *   ✅ Delete own comment (owner/CEO deletes any)  DELETE /documents/:id/comments/:commentId
 *
 * What documents do NOT do:
 *   ❌ TAT / efficiency / startTime / targetTatMinutes
 *   ❌ Status workflow  (pending_completion, completed)
 *   ❌ Supervisor approval
 *   ❌ Collaborators / accessControlList
 *   ❌ inviteCollaborator / removeCollaborator
 *
 * Everything performance/collaboration-related belongs to Tasks.
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import { DocumentModel } from '../models/Document';
import { SupervisorMapping } from '../models/SupervisorMapping';
import { TaskModel } from '../models/Task';
import { createAuditLog } from '../utils/auditLogger';
import mongoose from 'mongoose';
import { DocumentPriority } from '../types';
import { AuditLog } from '../models/AuditLog';
import { FolderModel } from '../models/Folder';
import { CommentModel } from '../models/Comment';
import { redis } from '../config/redis';
import { buildCacheKey } from '../utils/cacheKey';
import { enqueueDocumentProcessing } from '../queues/documentQueue';
import { getLocalFileUrl } from '../middleware/upload';
import path from 'path';
import fs from 'fs';

// ─────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────

const invalidateCache = async (userId: string) => {
  try {
    if (!redis) return;
    const keys = await redis.keys(`docs:${userId}:*`);
    if (keys.length) await redis.del(keys);
  } catch { /* non-fatal */ }
};

/**
 * Checks whether the requesting user can access a document.
 *
 * Access is granted to:
 *   - The document's owner
 *   - The CEO (always)
 *   - A supervisor who manages the document's owner
 *   - An active task collaborator whose task links to this document
 *   - Any user, for learning-type documents
 */
const canAccess = async (
  doc: {
    ownerId: mongoose.Types.ObjectId | string;
    supervisorId?: mongoose.Types.ObjectId | string;
    documentType?: string;
    _id: mongoose.Types.ObjectId | string;
  },
  userId: string,
  role: string
): Promise<boolean> => {
  if (role === 'ceo') return true;

  const ownerId = doc.ownerId.toString();
  if (ownerId === userId) return true;

  if (doc.documentType === 'learning') return true;

  if (role === 'supervisor') {
    if (doc.supervisorId?.toString() === userId) return true;
    const mapping = await SupervisorMapping.findOne({
      supervisorId: userId,
      subordinateId: doc.ownerId,
      status: 'active',
    });
    if (mapping) return true;
  }

  // Active task collaborator whose linked task references this document
  const collab = await TaskModel.findOne({
    documentId: doc._id,
    status: 'in_progress',
    'collaborators': {
      $elemMatch: {
        userId: new mongoose.Types.ObjectId(userId),
        status: 'active',
      },
    },
  });
  if (collab) return true;

  return false;
};

// ─────────────────────────────────────────────────────────────────
// CREATE DOCUMENT
// Supports: single file, multiple files, full folder uploads.
// All documents start as 'draft'. No TAT, no startTime ever.
// ─────────────────────────────────────────────────────────────────
export const createDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    // Working documents only carry: title (filename), description, date.
    // Priority is a storage/learning-only field — working docs have no priority
    // because they are task-driven and task priority governs urgency.
    const { description, tags, department, documentType: rawDocumentType, priority: rawPriority } = req.body;

    // Document type rules:
    //   CEO / Supervisor → 'learning' by default (they upload training materials).
    //                      They may explicitly choose 'storage' to override.
    //   User             → 'working' always (task documents; cannot set learning).
    //                      They may explicitly choose 'storage' for reference files.
    const uploaderRole = req.user!.role;
    let documentType: string;
    if (uploaderRole === 'ceo' || uploaderRole === 'supervisor') {
      documentType = rawDocumentType === 'storage' ? 'storage' : 'learning';
    } else {
      documentType = rawDocumentType === 'storage' ? 'storage' : 'working';
    }

    let relativePaths: string[] = [];
    const rawPaths = (req.query.webkitRelativePaths as string | undefined)
                  ?? (req.body.webkitRelativePaths as string | undefined);   // body fallback for backwards-compat

    if (rawPaths) {
      try {
        const parsed = JSON.parse(decodeURIComponent(rawPaths));
        if (!Array.isArray(parsed)) {
          return res.status(400).json({ success: false, message: 'webkitRelativePaths must be an array' });
        }
        relativePaths = parsed;
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid webkitRelativePaths: ' + (e as Error).message });
      }
    }

    if (relativePaths.length > 0 && relativePaths.length !== files.length) {
      return res.status(400).json({
        success: false,
        message: `Path count (${relativePaths.length}) does not match file count (${files.length})`
      });
    }

    const mapping = await SupervisorMapping.findOne({
      subordinateId: req.user!.userId, status: 'active',
    });

    const created = await Promise.all(files.map(async (file, idx) => {
      const relativePath = relativePaths[idx] || file.originalname;
      const parts        = relativePath.split('/');
      const fileName     = parts.pop() ?? file.originalname;

      // Rebuild folder hierarchy using upsert to avoid race conditions.
      // When multiple files in a folder upload run concurrently (Promise.all),
      // two files may both try to create the same parent folder at the same time.
      // findOneAndUpdate with upsert:true is atomic — whichever wins creates the
      // folder; the loser gets back the existing one instead of a duplicate key error.
      let parentFolderId = null;
      let currentPath    = '';
      for (const segment of parts) {
        currentPath += `/${segment}`;
        const folder = await FolderModel.findOneAndUpdate(
          { path: currentPath, ownerId: req.user!.userId },
          {
            $setOnInsert: {
              name: segment,
              path: currentPath,
              parentFolderId,
              ownerId: req.user!.userId,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        ) as any;
        if (!folder) {
          throw new Error('Folder creation failed unexpectedly');
        }
        parentFolderId = folder._id;
      }

      const fileUrl = getLocalFileUrl(file.filename);

      const doc = await DocumentModel.create({
        title:        fileName,
        description,
        folderId:     parentFolderId,
        fileType:     file.mimetype,
        // Priority only applies to storage/learning docs (not working docs — tasks drive urgency)
        priority:     documentType !== 'working' ? (rawPriority ?? 'medium') : undefined,
        ownerId:      req.user!.userId,
        supervisorId: mapping?.supervisorId,
        departmentId: department ?? mapping?.departmentName,
        tags:         tags ? (Array.isArray(tags) ? tags : [tags]) : [],
        documentType: documentType ?? 'working',
        status:       'draft',       // always draft — no TAT timer
        currentVersion: 1,
        versionHistory: [{
          versionNumber: 1,
          fileName:  file.originalname,
          fileKey:   file.filename,
          fileUrl,
          fileSize:  file.size,
          fileType:  file.mimetype,
          modifiedBy: new mongoose.Types.ObjectId(req.user!.userId),
          modifiedAt: new Date(),
          changeNote: 'Initial upload',
        }],
      });

      await enqueueDocumentProcessing({
        documentId: doc._id.toString(),
        fileKey:    file.filename,
        fileType:   file.mimetype,
      });
      await invalidateCache(req.user!.userId);
      await createAuditLog({
        documentId: doc._id.toString(),
        actorId:    req.user!.userId,
        action:     'created',
      });
      return doc;
    }));

    return res.status(201).json({
      success: true,
      message: `${created.length} document(s) uploaded`,
      data:    created,
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// LIST DOCUMENTS
// ─────────────────────────────────────────────────────────────────
export const getDocuments = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const cacheKey = buildCacheKey(req.user!.userId, req.query);
    const cached   = redis ? await redis.get(cacheKey) : null;
    if (cached) { res.json(JSON.parse(cached)); return; }

    const {
      priority, page = '1', limit = '20',
      ownerId: ownerF, supervisorId: supF,
      folderId, documentType, search,
    } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};
    if (priority)     filter['priority']     = priority;
    if (documentType) filter['documentType'] = documentType;
    if (search)       filter['title']        = { $regex: search, $options: 'i' };

    const uid = new mongoose.Types.ObjectId(req.user!.userId);

    if (req.user!.role === 'user') {
      // Own docs + docs linked to active tasks where user is collaborator
      const activeTasks = await TaskModel.find({
        status: 'in_progress',
        documentId: { $exists: true },
        'collaborators': { $elemMatch: { userId: uid, status: 'active' } },
      }).select('documentId');
      const linkedIds = activeTasks.map((t) => t.documentId).filter(Boolean);

      filter['$or'] = [
        { ownerId: uid },
        { _id: { $in: linkedIds } },
        { documentType: 'learning' },
      ];
    } else if (req.user!.role === 'supervisor') {
      const maps = await SupervisorMapping.find({
        supervisorId: uid, status: 'active',
      }).select('subordinateId');
      const subs = maps.map((m) => m.subordinateId);
      filter['$or'] = [
        { ownerId: { $in: subs } },
        { supervisorId: uid },
        { documentType: 'learning' },
      ];
    } else if (req.user!.role === 'ceo') {
      if (ownerF) filter['ownerId']      = new mongoose.Types.ObjectId(ownerF);
      if (supF)   filter['supervisorId'] = new mongoose.Types.ObjectId(supF);
    }

    if (folderId === 'null') {
      filter['folderId'] = null;
    } else if (folderId) {
      filter['folderId'] = new mongoose.Types.ObjectId(folderId);
    } else {
      filter['folderId'] = null;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [documents, total] = await Promise.all([
      DocumentModel.find(filter)
        .populate('ownerId', 'name email')
        .populate('supervisorId', 'name email')
        .populate('folderId', 'name path')
        .sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      DocumentModel.countDocuments(filter),
    ]);

    const response = {
      success: true, message: 'Documents retrieved', data: { documents },
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    };
    if (redis) await redis.set(cacheKey, JSON.stringify(response), 'EX', 60);
    res.json(response);
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// GET ONE DOCUMENT
// ─────────────────────────────────────────────────────────────────
export const getDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id)
      .populate('ownerId', 'name email')
      .populate('supervisorId', 'name email')
      .populate('folderId', 'name path');

    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const access = await canAccess(doc as Parameters<typeof canAccess>[0], req.user!.userId, req.user!.role);
    if (!access) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

    await createAuditLog({ documentId: req.params.id, actorId: req.user!.userId, action: 'viewed' });
    res.json({ success: true, data: { document: doc } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE METADATA
// Working docs: title, description only.
// Storage/learning: title, description, priority, tags.
// ─────────────────────────────────────────────────────────────────
export const updateDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const isOwner = doc.ownerId.toString() === req.user!.userId;
    const isCEO   = req.user!.role === 'ceo';
    if (!isOwner && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the owner or CEO can update this document' }); return;
    }

    const { title, description, priority, tags } = req.body as Partial<{
      title: string; description: string; priority: DocumentPriority; tags: string[];
    }>;

    if (title)       doc.title       = title;
    if (description !== undefined) doc.description = description;
    // Priority and tags only apply to non-working documents
    if (doc.documentType !== 'working') {
      if (priority) doc.priority = priority;
      if (tags)     doc.tags     = tags;
    }

    await doc.save();
    await createAuditLog({ documentId: req.params.id, actorId: req.user!.userId, action: 'edited' });
    res.json({ success: true, message: 'Document updated', data: { document: doc } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// PATCH INLINE TEXT CONTENT  (Yjs / rich-text editor persistence)
// Owner or CEO only — saves the editor's text back to contentText.
// ─────────────────────────────────────────────────────────────────
export const patchDocumentContent = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { content } = req.body as { content: string };
    if (content === undefined) {
      res.status(400).json({ success: false, message: 'content is required' }); return;
    }

    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const isOwner = doc.ownerId.toString() === req.user!.userId;
    const isCEO   = req.user!.role === 'ceo';
    if (!isOwner && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the owner or CEO can edit content' }); return;
    }

    doc.contentText = content;
    doc.description = content.slice(0, 500);
    await doc.save();
    await invalidateCache(req.user!.userId);
    await createAuditLog({ documentId: req.params.id, actorId: req.user!.userId, action: 'edited' });
    res.json({ success: true, message: 'Content saved', data: { document: doc } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// DELETE DOCUMENT
// Owner or CEO; physically removes the file from disk.
// ─────────────────────────────────────────────────────────────────
export const deleteDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    if (doc.ownerId.toString() !== req.user!.userId && req.user!.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the owner or CEO can delete this document' }); return;
    }

    // Remove all physical files across all versions
    for (const version of doc.versionHistory) {
      const p = path.join(process.env.UPLOAD_DIR ?? './uploads', version.fileKey);
      if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* non-fatal */ }
    }

    await doc.deleteOne();
    await CommentModel.deleteMany({ documentId: doc._id });
    await invalidateCache(req.user!.userId);
    await createAuditLog({ documentId: req.params.id, actorId: req.user!.userId, action: 'deleted' });
    res.json({ success: true, message: 'Document deleted' });
  } catch (err) { next(err); }
};

// ═════════════════════════════════════════════════════════════════
// VERSION HISTORY CRUD
// ═════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// UPLOAD NEW VERSION (replaces the current file with a new upload)
// Owner or CEO. The previous version is preserved in versionHistory.
// ─────────────────────────────────────────────────────────────────
export const uploadNewVersion = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    if (doc.ownerId.toString() !== req.user!.userId && req.user!.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the owner or CEO can upload new versions' }); return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file provided' }); return;
    }

    const fileUrl = getLocalFileUrl(req.file.filename);
    doc.currentVersion += 1;
    doc.versionHistory.push({
      versionNumber: doc.currentVersion,
      fileName:      req.file.originalname,
      fileKey:       req.file.filename,
      fileUrl,
      fileSize:      req.file.size,
      fileType:      req.file.mimetype,
      modifiedBy:    new mongoose.Types.ObjectId(req.user!.userId),
      modifiedAt:    new Date(),
      changeNote:    (req.body as { changeNote?: string }).changeNote ?? '',
    });
    doc.fileType = req.file.mimetype;

    await doc.save();
    await invalidateCache(req.user!.userId);
    await createAuditLog({ documentId: req.params.id, actorId: req.user!.userId, action: 'edited' });

    res.json({
      success: true,
      message: `Version ${doc.currentVersion} uploaded`,
      data:    { document: doc },
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// LIST ALL VERSIONS
// Anyone with document access can view version history.
// ─────────────────────────────────────────────────────────────────
export const getVersions = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id).select('versionHistory ownerId supervisorId documentType');
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const access = await canAccess(doc as Parameters<typeof canAccess>[0], req.user!.userId, req.user!.role);
    if (!access) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

    res.json({ success: true, data: { versions: doc.versionHistory } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// RESTORE A PREVIOUS VERSION
// Promotes an older version to "current" by duplicating it as a new
// entry in versionHistory. The file on disk is NOT deleted.
// Owner or CEO only.
// ─────────────────────────────────────────────────────────────────
export const restoreVersion = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id, versionNumber } = req.params as { id: string; versionNumber: string };
    const doc = await DocumentModel.findById(id);
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    if (doc.ownerId.toString() !== req.user!.userId && req.user!.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the owner or CEO can restore versions' }); return;
    }

    const target = doc.versionHistory.find(
      (v) => v.versionNumber === Number(versionNumber)
    );
    if (!target) {
      res.status(404).json({ success: false, message: `Version ${versionNumber} not found` }); return;
    }

    // Push a new version entry that is a copy of the restored version
    doc.currentVersion += 1;
    doc.versionHistory.push({
      versionNumber: doc.currentVersion,
      fileName:   target.fileName,
      fileKey:    target.fileKey,
      fileUrl:    target.fileUrl,
      fileSize:   target.fileSize,
      fileType:   target.fileType,
      modifiedBy: new mongoose.Types.ObjectId(req.user!.userId),
      modifiedAt: new Date(),
      changeNote: `Restored from version ${versionNumber}`,
    });
    doc.fileType = target.fileType;

    await doc.save();
    await createAuditLog({ documentId: id, actorId: req.user!.userId, action: 'edited' });

    res.json({
      success: true,
      message: `Version ${versionNumber} restored as version ${doc.currentVersion}`,
      data:    { document: doc },
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// DELETE A SPECIFIC VERSION
// Owner or CEO only. Cannot delete the only remaining version.
// Physically removes the file from disk unless it is the same file
// as another version (safety check on fileKey).
// ─────────────────────────────────────────────────────────────────
export const deleteVersion = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id, versionNumber } = req.params as { id: string; versionNumber: string };
    const doc = await DocumentModel.findById(id);
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    if (doc.ownerId.toString() !== req.user!.userId && req.user!.role !== 'ceo') {
      res.status(403).json({ success: false, message: 'Only the owner or CEO can delete versions' }); return;
    }

    if (doc.versionHistory.length <= 1) {
      res.status(400).json({ success: false, message: 'Cannot delete the only version. Delete the document instead.' }); return;
    }

    const targetIdx = doc.versionHistory.findIndex(
      (v) => v.versionNumber === Number(versionNumber)
    );
    if (targetIdx === -1) {
      res.status(404).json({ success: false, message: `Version ${versionNumber} not found` }); return;
    }

    const target  = doc.versionHistory[targetIdx];

    // Only delete the physical file if no other version shares the same fileKey
    const sharedKey = doc.versionHistory.some(
      (v, i) => i !== targetIdx && v.fileKey === target.fileKey
    );
    if (!sharedKey) {
      const filePath = path.join(process.env.UPLOAD_DIR ?? './uploads', target.fileKey);
      if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch { /* non-fatal */ }
    }

    doc.versionHistory.splice(targetIdx, 1);
    // Keep currentVersion as-is (version numbers are not re-numbered to preserve history)

    await doc.save();
    await createAuditLog({ documentId: id, actorId: req.user!.userId, action: 'edited' });

    res.json({ success: true, message: `Version ${versionNumber} deleted` });
  } catch (err) { next(err); }
};

// ═════════════════════════════════════════════════════════════════
// COMMENT CRUD
// Comments are attached to documents. Anyone with document access
// can read and create comments. Only the comment author (or the
// document owner / CEO) can update or delete a comment.
// ═════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// CREATE COMMENT
// ─────────────────────────────────────────────────────────────────
export const createComment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id)
      .select('ownerId supervisorId documentType _id');
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const access = await canAccess(doc as Parameters<typeof canAccess>[0], req.user!.userId, req.user!.role);
    if (!access) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

    const { text } = req.body as { text: string };
    if (!text?.trim()) {
      res.status(400).json({ success: false, message: 'Comment text is required' }); return;
    }

    const comment = await CommentModel.create({
      documentId: doc._id,
      user:       req.user!.userId,
      text:       text.trim(),
    });

    const populated = await comment.populate('user', 'name email role');
    res.status(201).json({ success: true, message: 'Comment added', data: { comment: populated } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// LIST COMMENTS
// ─────────────────────────────────────────────────────────────────
export const getComments = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id)
      .select('ownerId supervisorId documentType _id');
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const access = await canAccess(doc as Parameters<typeof canAccess>[0], req.user!.userId, req.user!.role);
    if (!access) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

    const comments = await CommentModel.find({ documentId: req.params.id })
      .populate('user', 'name email role')
      .sort({ createdAt: 1 });
    res.json({ success: true, data: { comments } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE COMMENT
// Only the comment's author can edit it.
// ─────────────────────────────────────────────────────────────────
export const updateComment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { commentId } = req.params as { commentId: string };
    const { text } = req.body as { text: string };

    if (!text?.trim()) {
      res.status(400).json({ success: false, message: 'Comment text is required' }); return;
    }

    const comment = await CommentModel.findById(commentId);
    if (!comment) { res.status(404).json({ success: false, message: 'Comment not found' }); return; }

    if (comment.user.toString() !== req.user!.userId) {
      res.status(403).json({ success: false, message: 'You can only edit your own comments' }); return;
    }

    comment.text = text.trim();
    await comment.save();

    const populated = await comment.populate('user', 'name email role');
    res.json({ success: true, message: 'Comment updated', data: { comment: populated } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// DELETE COMMENT
// The comment's author, the document owner, or the CEO can delete.
// ─────────────────────────────────────────────────────────────────
export const deleteComment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id, commentId } = req.params as { id: string; commentId: string };
    const comment = await CommentModel.findById(commentId);
    if (!comment) { res.status(404).json({ success: false, message: 'Comment not found' }); return; }

    const doc = await DocumentModel.findById(id).select('ownerId');
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const isAuthor      = comment.user.toString() === req.user!.userId;
    const isDocOwner    = doc.ownerId.toString() === req.user!.userId;
    const isCEO         = req.user!.role === 'ceo';

    if (!isAuthor && !isDocOwner && !isCEO) {
      res.status(403).json({ success: false, message: 'Not authorised to delete this comment' }); return;
    }

    await comment.deleteOne();
    res.json({ success: true, message: 'Comment deleted' });
  } catch (err) { next(err); }
};

// ═════════════════════════════════════════════════════════════════
// PREVIEW, DOWNLOAD, MOVE, ACTIVITY
// ═════════════════════════════════════════════════════════════════

export const previewDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) { res.status(404).json({ success: false }); return; }

    const access = await canAccess(doc as Parameters<typeof canAccess>[0], req.user!.userId, req.user!.role);
    if (!access) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

    const latest   = doc.versionHistory[doc.versionHistory.length - 1];
    if (!latest) { res.status(404).json({ success: false, message: 'No file found' }); return; }

    const filePath = path.join(process.env.UPLOAD_DIR ?? './uploads', latest.fileKey);
    const mimeType = latest.fileType;

    // DOCX → HTML via mammoth (no LibreOffice)
    const isDocx = mimeType.includes('wordprocessingml') || mimeType.includes('msword');
    if (isDocx && fs.existsSync(filePath)) {
      try {
        const mammoth = await import('mammoth');
        const result  = await mammoth.convertToHtml({ path: filePath });
        res.json({ success: true, type: 'html', html: result.value, url: latest.fileUrl });
        return;
      } catch (e) {
        console.error('mammoth failed, falling back:', e);
      }
    }

    // PDF / images / everything else → return URL for browser rendering
    res.json({ success: true, type: mimeType, url: latest.fileUrl });
  } catch (err) { next(err); }
};

export const downloadDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) { res.status(404).json({ success: false, message: 'Document not found' }); return; }

    const access = await canAccess(doc as Parameters<typeof canAccess>[0], req.user!.userId, req.user!.role);
    if (!access) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

    const latest = doc.versionHistory[doc.versionHistory.length - 1];
    if (!latest) { res.status(404).json({ success: false, message: 'File not found' }); return; }

    await createAuditLog({ documentId: req.params.id, actorId: req.user!.userId, action: 'downloaded' });

    const filePath = path.join(process.env.UPLOAD_DIR ?? './uploads', latest.fileKey);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: 'File missing from disk' }); return;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(latest.fileName)}"`);
    res.setHeader('Content-Type', latest.fileType);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) { next(err); }
};

export const moveDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) { res.status(404).json({ success: false }); return; }
    if (doc.ownerId.toString() !== req.user!.userId && req.user!.role !== 'ceo') {
      res.status(403).json({ success: false }); return;
    }
    doc.folderId = req.body.targetFolderId || null;
    await doc.save();
    await invalidateCache(req.user!.userId);
    res.json({ success: true, message: 'Document moved' });
  } catch { res.status(500).json({ success: false }); }
};

export const getDocumentActivity = async (req: AuthRequest, res: Response): Promise<void> => {
  const logs = await AuditLog.find({ documentId: req.params.id }).sort({ createdAt: -1 });
  res.json({ success: true, data: logs });
};