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
 *   ✅ Mark as read (read receipt, upsert)          POST   /documents/:id/read
 *   ✅ List who has read a document                 GET    /documents/:id/reads
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

import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { DocumentModel } from "../models/Document";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { TaskModel } from "../models/Task";
import { createAuditLog } from "../utils/auditLogger";
import mongoose from "mongoose";
import { DocumentPriority } from "../types";
import { AuditLog } from "../models/AuditLog";
import { FolderModel } from "../models/Folder";
import { CommentModel } from "../models/Comment";
import { DocumentReadModel } from "../models/DocumentRead";
import { redis } from "../config/redis";
import { buildCacheKey } from "../utils/cacheKey";
import { enqueueDocumentProcessing } from "../queues/documentQueue";
import { getLocalFileUrl } from "../middleware/upload";
import { buildSignedFileUrl } from "../utils/fileAccessToken";
import path from "path";
import fs from "fs";
import { resolveFolderType, cloneDocumentRecord } from "./folderController";

// ─────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────

const invalidateCache = async (userId: string) => {
  try {
    if (!redis) return;
    const keys = await redis.keys(`docs:${userId}:*`);
    if (keys.length) await redis.del(keys);
  } catch {
    /* non-fatal */
  }
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
// Extracts a comparable ID string whether the field is a raw
// ObjectId/string, or has been populated into a full sub-document (an
// object with an _id) — plain `.toString()` on a populated Mongoose
// document returns a debug-inspect string, not the ID, so any
// comparison built on it silently fails. getDocument populates
// ownerId/supervisorId before calling canAccess, so this is a real,
// not just theoretical, distinction.
export const idOf = (value: unknown): string => {
  if (
    value &&
    typeof value === "object" &&
    "_id" in (value as Record<string, unknown>)
  ) {
    return String((value as { _id: unknown })._id);
  }
  return String(value ?? "");
};

const canAccess = async (
  doc: {
    ownerId: mongoose.Types.ObjectId | string;
    supervisorId?: mongoose.Types.ObjectId | string;
    documentType?: string;
    _id: mongoose.Types.ObjectId | string;
  },
  userId: string,
  role: string,
): Promise<boolean> => {
  if (role === "ceo") return true;

  const ownerId = idOf(doc.ownerId);
  if (ownerId === userId) return true;

  if (doc.documentType === "learning") return true;

  if (role === "supervisor") {
    if (idOf(doc.supervisorId) === userId) return true;
    const mapping = await SupervisorMapping.findOne({
      supervisorId: userId,
      subordinateId: ownerId,
      status: "active",
    });
    if (mapping) return true;
  }

  // Active task collaborator whose linked task references this document
  const collab = await TaskModel.findOne({
    documentId: doc._id,
    status: "in_progress",
    collaborators: {
      $elemMatch: {
        userId: new mongoose.Types.ObjectId(userId),
        status: "active",
      },
    },
  });
  if (collab) return true;

  return false;
};

/**
 * Checks whether the requesting user can *modify* a document (edit
 * metadata/content, upload/restore/delete a version, or delete the
 * document outright) — a narrower rule than read access (canAccess).
 *
 * Allowed:
 *   - The document's owner
 *   - The CEO (always)
 *   - A supervisor, but only for 'learning' documents (training
 *     material is jointly maintained by supervisors even if they
 *     didn't personally upload it — matches the frontend's canEdit/
 *     canManage logic on the document detail & learning materials pages)
 */
const canModify = (
  doc: { ownerId: mongoose.Types.ObjectId | string; documentType?: string },
  userId: string,
  role: string,
): boolean => {
  if (role === "ceo") return true;
  if (idOf(doc.ownerId) === userId) return true;
  if (role === "supervisor" && doc.documentType === "learning") return true;
  return false;
};

/**
 * Best-effort text extraction at upload time, so the in-browser
 * content editor (patchDocumentContent) has something real to work
 * with right away instead of starting empty. Never throws — a failed
 * extraction just means contentText stays empty, it doesn't block
 * the upload itself.
 *
 * Covers: .txt/.md/.csv (plain text), .rtf (control-code stripped),
 * .docx (mammoth), .xlsx/.xls (xlsx — handles both formats), .pptx
 * (slide text via JSZip, since .pptx is just a zip of XML).
 * Deliberately NOT covered: PDFs (excluded by design), and legacy
 * binary .doc/.ppt (pre-XML Office formats — would need something
 * like LibreOffice/antiword to read at all, not worth the dependency
 * weight for a best-effort feature).
 */
const extractTextContent = async (
  filePath: string,
  fileType: string,
  originalName: string,
): Promise<string | undefined> => {
  const ext = path.extname(originalName).toLowerCase();

  try {
    // Plain text formats — mimetype detection for .md/.csv is
    // inconsistent across browsers/OSes, so extension is checked too.
    if (
      fileType === "text/plain" ||
      fileType === "text/markdown" ||
      fileType === "text/csv" ||
      [".txt", ".md", ".csv"].includes(ext)
    ) {
      return await fs.promises.readFile(filePath, "utf-8");
    }

    // RTF — strip control codes/groups for a rough plain-text read.
    // Not a full RTF parser, but good enough to make the text searchable/editable.
    if (
      fileType === "application/rtf" ||
      fileType === "text/rtf" ||
      ext === ".rtf"
    ) {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      return raw
        .replace(/\\par[d]?/g, "\n")
        .replace(/\{\\[^{}]*\}/g, "")
        .replace(/\\[a-zA-Z]+-?\d*/g, "")
        .replace(/[{}]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    // .docx
    if (
      fileType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      ext === ".docx"
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    // .xlsx / .xls — xlsx (SheetJS) reads both formats transparently.
    // Every sheet's cells are flattened into rows of text.
    if (
      fileType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      fileType === "application/vnd.ms-excel" ||
      [".xlsx", ".xls"].includes(ext)
    ) {
      const XLSX = await import("xlsx");
      const workbook = XLSX.readFile(filePath);
      const sheetTexts = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        return `--- ${name} ---\n${csv}`;
      });
      return sheetTexts.join("\n\n");
    }

    // .pptx — a zip of XML; slide text lives in <a:t> runs inside
    // ppt/slides/slideN.xml.
    if (
      fileType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      ext === ".pptx"
    ) {
      const JSZip = (await import("jszip")).default;
      const buffer = await fs.promises.readFile(filePath);
      const zip = await JSZip.loadAsync(buffer);

      const slideFiles = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => {
          const numA = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
          const numB = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
          return numA - numB;
        });

      const slideTexts = await Promise.all(
        slideFiles.map(async (name, i) => {
          const xml = await zip.files[name].async("string");
          const text = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
            .map((m) => m[1])
            .join(" ");
          return `--- Slide ${i + 1} ---\n${text}`;
        }),
      );
      return slideTexts.join("\n\n");
    }
  } catch (err) {
    console.error("extractTextContent failed (non-fatal):", err);
  }
  return undefined;
};

/**
 * Replaces a document's fileUrl with a freshly-signed, short-lived
 * URL before it goes out in a response. Whatever was stored in the DB
 * at upload time is stale/unsigned and no longer servable on its own
 * — see utils/fileAccessToken.ts for why. Works on both plain objects
 * (.lean()) and full Mongoose documents (.toObject() first).
 */
export const attachSignedUrls = <
  T extends { fileKey?: string; fileUrl?: string },
>(
  input: T,
): T => {
  const plain = (
    typeof (input as any).toObject === "function"
      ? (input as any).toObject()
      : input
  ) as T;
  if (plain.fileKey) {
    plain.fileUrl = buildSignedFileUrl(plain.fileKey);
  }
  return plain;
};

export const attachSignedUrlsToMany = <
  T extends { fileKey?: string; fileUrl?: string },
>(
  docs: T[],
): T[] => docs.map((d) => attachSignedUrls(d));

// ─────────────────────────────────────────────────────────────────
// CHECK DUPLICATE FILENAMES
// Called by the upload page before actually sending files, so the
// user can be asked "overwrite or upload as new?" instead of silently
// ending up with two separate documents that happen to share a name.
// Scoped to the uploader's own documents in the target folder — the
// same boundary as folder semantics (no collision across folders),
// and you can only ever overwrite something you actually own/manage.
// ─────────────────────────────────────────────────────────────────
export const checkDuplicateFilenames = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { filenames, folderId } = req.body as {
      filenames: string[];
      folderId?: string | null;
    };

    if (!Array.isArray(filenames) || filenames.length === 0) {
      res
        .status(400)
        .json({ success: false, message: "filenames (array) is required" });
      return;
    }

    const existing = await DocumentModel.find({
      title: { $in: filenames },
      ownerId: req.user!.userId,
      folderId: folderId || null,
    }).select("title");

    const duplicates = existing.map((d) => ({
      fileName: d.title,
      documentId: d._id.toString(),
    }));
    res.json({ success: true, data: { duplicates } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// CREATE DOCUMENT
// Supports: single file, multiple files, full folder uploads.
// All documents start as 'draft'. No TAT, no startTime ever.
// ─────────────────────────────────────────────────────────────────
export const createDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No files uploaded" });
    }

    // Working documents only carry: title (filename), description, date.
    // Priority is a storage/learning-only field — working docs have no priority
    // because they are task-driven and task priority governs urgency.
    const {
      description,
      tags,
      department,
      documentType: rawDocumentType,
      priority: rawPriority,
      categoryId,
    } = req.body;

    // Document type rules:
    //   CEO / Supervisor → 'learning' by default (they upload training materials).
    //                      They may explicitly choose 'storage' to override.
    //   User             → 'working' always (task documents; cannot set learning).
    //                      They may explicitly choose 'storage' for reference files.
    const uploaderRole = req.user!.role;
    let documentType: string;
    if (uploaderRole === "ceo" || uploaderRole === "supervisor") {
      documentType = rawDocumentType === "storage" ? "storage" : "learning";
    } else {
      documentType = rawDocumentType === "storage" ? "storage" : "working";
    }

    let relativePaths: string[] = [];
    const rawPaths =
      (req.query.webkitRelativePaths as string | undefined) ??
      (req.body.webkitRelativePaths as string | undefined); // body fallback for backwards-compat

    if (rawPaths) {
      try {
        const parsed = JSON.parse(decodeURIComponent(rawPaths));
        if (!Array.isArray(parsed)) {
          return res.status(400).json({
            success: false,
            message: "webkitRelativePaths must be an array",
          });
        }
        relativePaths = parsed;
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: "Invalid webkitRelativePaths: " + (e as Error).message,
        });
      }
    }

    if (relativePaths.length > 0 && relativePaths.length !== files.length) {
      return res.status(400).json({
        success: false,
        message: `Path count (${relativePaths.length}) does not match file count (${files.length})`,
      });
    }

    const mapping = await SupervisorMapping.findOne({
      subordinateId: req.user!.userId,
      status: "active",
    });

    const created = await Promise.all(
      files.map(async (file, idx) => {
        const relativePath = relativePaths[idx] || file.originalname;
        const parts = relativePath.split("/");
        const fileName = parts.pop() ?? file.originalname;

        // Rebuild folder hierarchy using upsert to avoid race conditions.
        // When multiple files in a folder upload run concurrently (Promise.all),
        // two files may both try to create the same parent folder at the same time.
        // findOneAndUpdate with upsert:true is atomic — whichever wins creates the
        // folder; the loser gets back the existing one instead of a duplicate key error.
        let parentFolderId = null;
        let currentPath = "";
        for (const segment of parts) {
          currentPath += `/${segment}`;
          const folder = (await FolderModel.findOneAndUpdate(
            { path: currentPath, ownerId: req.user!.userId },
            {
              $setOnInsert: {
                name: segment,
                path: currentPath,
                parentFolderId,
                ownerId: req.user!.userId,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          )) as any;
          if (!folder) {
            throw new Error("Folder creation failed unexpectedly");
          }
          parentFolderId = folder._id;
        }

        const fileUrl = getLocalFileUrl(file.filename);
        const contentText = await extractTextContent(
          file.path,
          file.mimetype,
          file.originalname,
        );

        const doc = await DocumentModel.create({
          title: fileName,
          description,
          folderId: parentFolderId,
          fileType: file.mimetype,
          contentText,
          fileName: file.originalname,
          fileKey: file.filename,
          fileUrl,
          fileSize: file.size,
          modifiedBy: new mongoose.Types.ObjectId(req.user!.userId),
          modifiedAt: new Date(),
          priority:
            documentType !== "working" ? (rawPriority ?? "medium") : undefined,
          ownerId: req.user!.userId,
          supervisorId: mapping?.supervisorId,
          departmentId: department ?? mapping?.departmentName,
          tags: tags ? (Array.isArray(tags) ? tags : [tags]) : [],
          documentType: documentType ?? "working",
          categoryId:
            documentType === "learning" && categoryId ? categoryId : undefined,
          status: "draft",
        });

        await enqueueDocumentProcessing({
          documentId: doc._id.toString(),
          fileKey: file.filename,
          fileType: file.mimetype,
        });
        await invalidateCache(req.user!.userId);
        await createAuditLog({
          documentId: doc._id.toString(),
          actorId: req.user!.userId,
          action: "created",
        });
        return doc;
      }),
    );

    return res.status(201).json({
      success: true,
      message: `${created.length} document(s) uploaded`,
      data: attachSignedUrlsToMany(created),
    });
  } catch (err) {
    next(err);
    return;
  }
};

// ─────────────────────────────────────────────────────────────────
// LIST DOCUMENTS
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// GET DOCUMENT TYPE COUNTS
//
// Powers the Working / Stored (/ Learning) tab badges. Previously
// each page counted root-level documents ONLY (`folderId=null`),
// which under-counted anything sitting inside a folder, and didn't
// count folders themselves at all — a tab could show "0" while
// actually containing an entire folder full of files.
//
// This counts, per type, both: folders of that type (any depth,
// same visibility rules as getDocuments) and documents of that type
// across ALL folders (not just root) — then reports folders,
// documents, and their sum for each tab.
// ─────────────────────────────────────────────────────────────────
export const getDocumentTypeCounts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const uid = new mongoose.Types.ObjectId(req.user!.userId);
    const role = req.user!.role;

    // Same visibility rule getDocuments uses for documents.
    const docFilter: Record<string, unknown> = { isDeleted: { $ne: true } };
    if (role === "user") {
      const activeTasks = await TaskModel.find({
        status: "in_progress",
        documentId: { $exists: true },
        collaborators: { $elemMatch: { userId: uid, status: "active" } },
      }).select("documentId");
      const linkedIds = activeTasks.map((t) => t.documentId).filter(Boolean);
      docFilter["$or"] = [
        { ownerId: uid },
        { _id: { $in: linkedIds } },
        { documentType: "learning" },
      ];
    } else if (role === "supervisor") {
      const maps = await SupervisorMapping.find({
        supervisorId: uid,
        status: "active",
      }).select("subordinateId");
      const subs = maps.map((m) => m.subordinateId);
      docFilter["$or"] = [
        { ownerId: uid },
        { ownerId: { $in: subs } },
        { supervisorId: uid },
        { documentType: "learning" },
      ];
    }
    // ceo: no filter — sees everything

    // Same visibility rule getRootContents/getFolderContents use for folders.
    let folderOwnerFilter: Record<string, unknown> = {};
    if (role === "supervisor") {
      const maps = await SupervisorMapping.find({
        supervisorId: uid,
        status: "active",
      }).select("subordinateId");
      const subIds = maps.map((m) => m.subordinateId);
      folderOwnerFilter = { ownerId: { $in: [uid, ...subIds] } };
    } else if (role === "user") {
      folderOwnerFilter = { ownerId: uid };
    }
    // ceo: no filter

    // Self-heal any folder in scope that predates the documentType
    // field, before counting — otherwise the count here can race
    // against getRootContents (which only heals folders it happens
    // to render) and briefly undercount a tab by one.
    const untagged = await FolderModel.find({
      ...folderOwnerFilter,
      documentType: { $exists: false },
    });
    await Promise.all(untagged.map((f) => resolveFolderType(f)));

    const types = ["working", "storage", "learning"] as const;

    const [docCounts, folderCounts] = await Promise.all([
      Promise.all(
        types.map((t) =>
          DocumentModel.countDocuments({ ...docFilter, documentType: t }),
        ),
      ),
      Promise.all(
        types.map((t) =>
          FolderModel.countDocuments({
            ...folderOwnerFilter,
            documentType: t,
            isDeleted: { $ne: true },
          }),
        ),
      ),
    ]);

    const counts: Record<
      string,
      { folders: number; documents: number; total: number }
    > = {};
    types.forEach((t, i) => {
      counts[t] = {
        folders: folderCounts[i],
        documents: docCounts[i],
        total: folderCounts[i] + docCounts[i],
      };
    });

    res.json({ success: true, data: { counts } });
    return;
  } catch (err) {
    next(err);
    return;
  }
};

export const getDocuments = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const cacheKey = buildCacheKey(req.user!.userId, req.query);
    const cached = redis ? await redis.get(cacheKey) : null;
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }

    const {
      priority,
      page = "1",
      limit = "20",
      ownerId: ownerF,
      supervisorId: supF,
      folderId,
      documentType,
      search,
      allFolders,
      starred,
      tags,
      readStatus,
      categoryId,
    } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
    if (priority) filter["priority"] = priority;
    if (documentType) filter["documentType"] = documentType;
    if (search) filter["title"] = { $regex: search, $options: "i" };
    if (starred === "true") filter["isStarred"] = true;
    if (categoryId) filter["categoryId"] = categoryId;
    if (tags) {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tagList.length) filter["tags"] = { $in: tagList };
    }

    const uid = new mongoose.Types.ObjectId(req.user!.userId);

    // readStatus narrows to documents the requester has/hasn't opened
    // (per DocumentRead). A user's read history is small relative to
    // the whole library, so pulling their read ids up front and
    // folding them into the main filter is cheap and keeps this
    // compatible with normal pagination — unlike filtering after the
    // page is fetched, the totals/pagination stay accurate.
    if (readStatus === "read" || readStatus === "unread") {
      const readIds = await DocumentReadModel.find({ user: uid }).distinct(
        "documentId",
      );
      filter["_id"] =
        readStatus === "read" ? { $in: readIds } : { $nin: readIds };
    }

    if (req.user!.role === "user") {
      // Own docs + docs linked to active tasks where user is collaborator
      const activeTasks = await TaskModel.find({
        status: "in_progress",
        documentId: { $exists: true },
        collaborators: { $elemMatch: { userId: uid, status: "active" } },
      }).select("documentId");
      const linkedIds = activeTasks.map((t) => t.documentId).filter(Boolean);

      filter["$or"] = [
        { ownerId: uid },
        { _id: { $in: linkedIds } },
        { documentType: "learning" },
      ];
    } else if (req.user!.role === "supervisor") {
      const maps = await SupervisorMapping.find({
        supervisorId: uid,
        status: "active",
      }).select("subordinateId");
      const subs = maps.map((m) => m.subordinateId);
      filter["$or"] = [
        { ownerId: uid },
        { ownerId: { $in: subs } },
        { supervisorId: uid },
        { documentType: "learning" },
      ];
    } else if (req.user!.role === "ceo") {
      if (ownerF) filter["ownerId"] = new mongoose.Types.ObjectId(ownerF);
      if (supF) filter["supervisorId"] = new mongoose.Types.ObjectId(supF);
    }

    // By default the document browser only shows the current folder
    // (folderId: null = root). Pickers that need a flat list of every
    // matching document regardless of which folder it lives in (e.g.
    // "choose a working document to attach to this task") pass
    // allFolders=true to skip this constraint — the Starred view does
    // the same thing implicitly, since a starred file could live
    // anywhere in the tree.
    if (allFolders === "true" || starred === "true") {
      // no folderId constraint — search across all folders
    } else if (folderId === "null") {
      filter["folderId"] = null;
    } else if (folderId) {
      filter["folderId"] = new mongoose.Types.ObjectId(folderId);
    } else {
      filter["folderId"] = null;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [documents, total] = await Promise.all([
      DocumentModel.find(filter)
        .populate("ownerId", "name email")
        .populate("supervisorId", "name email")
        .populate("folderId", "name path")
        .populate("categoryId", "name color icon")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      DocumentModel.countDocuments(filter),
    ]);

    // Read receipts — cheap enough to attach on every list response
    // (indexed on documentId/user), and the library view needs both
    // "have I read this" and "how many people have" per card.
    const docIds = documents.map((d) => d._id);
    const [myReads, readerCounts] = docIds.length
      ? await Promise.all([
          DocumentReadModel.find({
            documentId: { $in: docIds },
            user: uid,
          })
            .select("documentId")
            .lean(),
          DocumentReadModel.aggregate([
            { $match: { documentId: { $in: docIds } } },
            { $group: { _id: "$documentId", count: { $sum: 1 } } },
          ]),
        ])
      : [[], []];
    const myReadSet = new Set(myReads.map((r) => r.documentId.toString()));
    const readerCountMap = new Map(
      readerCounts.map((r) => [r._id.toString(), r.count as number]),
    );
    const documentsWithReadState = documents.map((d) => ({
      ...d,
      hasRead: myReadSet.has(d._id.toString()),
      readerCount: readerCountMap.get(d._id.toString()) ?? 0,
    }));

    const response = {
      success: true,
      message: "Documents retrieved",
      data: { documents: attachSignedUrlsToMany(documentsWithReadState) },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    };
    if (redis) await redis.set(cacheKey, JSON.stringify(response), "EX", 60);
    res.json(response);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// GET ONE DOCUMENT
// ─────────────────────────────────────────────────────────────────
export const getDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id)
      .populate("ownerId", "name email")
      .populate("supervisorId", "name email")
      .populate("folderId", "name path")
      .populate("categoryId", "name color icon");

    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "viewed",
    });

    const [myRead, readerCount] = await Promise.all([
      DocumentReadModel.findOne({
        documentId: doc._id,
        user: req.user!.userId,
      }).lean(),
      DocumentReadModel.countDocuments({ documentId: doc._id }),
    ]);

    res.json({
      success: true,
      data: {
        document: {
          ...attachSignedUrls(doc),
          hasRead: !!myRead,
          readerCount,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// MARK AS READ
// Idempotent read receipt: creates the (document, user) row on first
// call, otherwise bumps lastReadAt/readCount on the existing one.
// Anyone with access to the document can mark it read — this mirrors
// canAccess rather than the narrower canManage, since reading a
// resource isn't a management action.
// ─────────────────────────────────────────────────────────────────
export const markDocumentRead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id).select(
      "ownerId supervisorId documentType _id",
    );
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const now = new Date();
    const existing = await DocumentReadModel.findOne({
      documentId: doc._id,
      user: req.user!.userId,
    });

    let read;
    if (existing) {
      read = await DocumentReadModel.findByIdAndUpdate(
        existing._id,
        { $set: { lastReadAt: now }, $inc: { readCount: 1 } },
        { new: true },
      );
    } else {
      try {
        read = await DocumentReadModel.create({
          documentId: doc._id,
          user: req.user!.userId,
          firstReadAt: now,
          lastReadAt: now,
          readCount: 1,
        });
      } catch (createErr: any) {
        // Two near-simultaneous first-reads both missed `existing` —
        // the unique (documentId, user) index rejected the second
        // insert. Fall back to updating the row the other request won.
        if (createErr?.code === 11000) {
          read = await DocumentReadModel.findOneAndUpdate(
            { documentId: doc._id, user: req.user!.userId },
            { $set: { lastReadAt: now }, $inc: { readCount: 1 } },
            { new: true },
          );
        } else {
          throw createErr;
        }
      }
    }

    await invalidateCache(req.user!.userId);

    const readerCount = await DocumentReadModel.countDocuments({
      documentId: doc._id,
    });

    res.json({
      success: true,
      message: "Marked as read",
      data: { read, readerCount },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// LIST READERS
// Who has read this document, and when — the "read receipts" panel.
// Same access rule as viewing the document itself.
// ─────────────────────────────────────────────────────────────────
export const getDocumentReaders = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id).select(
      "ownerId supervisorId documentType _id",
    );
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const reads = await DocumentReadModel.find({ documentId: doc._id })
      .populate("user", "name email role")
      .sort({ lastReadAt: -1 })
      .lean();

    res.json({
      success: true,
      data: { readers: reads, total: reads.length },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE METADATA
// Working docs: title, description only.
// Storage/learning: title, description, priority, tags.
// ─────────────────────────────────────────────────────────────────
export const updateDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    if (!canModify(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "Only the owner or CEO can update this document",
      });
      return;
    }

    const { title, description, priority, tags, categoryId } =
      req.body as Partial<{
        title: string;
        description: string;
        priority: DocumentPriority;
        tags: string[];
        categoryId: string | null;
      }>;

    // findByIdAndUpdate rather than doc.field = x; doc.save() — a
    // full save() re-validates every required field on the document,
    // not just the ones being touched here. Any pre-existing record
    // missing an unrelated required field (e.g. a legacy row created
    // before fileKey/fileUrl were mandatory) would otherwise fail to
    // save at all, even for a title rename. $set + runValidators only
    // checks the fields actually being written.
    const update: Record<string, unknown> = {};
    if (title) update.title = title;
    if (description !== undefined) update.description = description;
    if (doc.documentType !== "working") {
      if (priority) update.priority = priority;
      if (tags) update.tags = tags;
    }
    if (doc.documentType === "learning" && categoryId !== undefined) {
      update.categoryId = categoryId
        ? new mongoose.Types.ObjectId(categoryId)
        : null;
    }

    await DocumentModel.findByIdAndUpdate(doc._id, { $set: update });
    Object.assign(doc, update); // keep the response in sync with what was actually written
    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "edited",
    });
    res.json({
      success: true,
      message: "Document updated",
      data: { document: attachSignedUrls(doc) },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// PATCH INLINE TEXT CONTENT  (Yjs / rich-text editor persistence)
// Owner or CEO only — saves the editor's text back to contentText.
// ─────────────────────────────────────────────────────────────────
export const patchDocumentContent = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { content } = req.body as { content: string };
    if (content === undefined) {
      res.status(400).json({ success: false, message: "content is required" });
      return;
    }

    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    if (!canModify(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "Only the owner or CEO can edit content",
      });
      return;
    }

    doc.contentText = content;
    doc.description = content.slice(0, 500);
    await doc.save();
    await invalidateCache(req.user!.userId);
    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "edited",
    });
    res.json({
      success: true,
      message: "Content saved",
      data: { document: attachSignedUrls(doc) },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// DELETE DOCUMENT
// Owner or CEO; physically removes the file from disk.
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// TRASH DOCUMENT (soft delete)
// Owner or CEO; moves the document to Trash. The physical file is
// left on disk untouched — it's only removed by
// permanentlyDeleteDocument or when Trash is emptied.
// ─────────────────────────────────────────────────────────────────
export const deleteDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    if (!canModify(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "Only the owner or CEO can delete this document",
      });
      return;
    }

    // $set-only update, not doc.field = x; doc.save() — see the
    // comment on updateDocument above for why: save() validates the
    // entire document, and this exact call is what was 500-ing on
    // legacy records missing an unrelated required field.
    await DocumentModel.findByIdAndUpdate(doc._id, {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: new mongoose.Types.ObjectId(req.user!.userId),
      },
    });

    await invalidateCache(req.user!.userId);
    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "trashed",
    });
    res.json({ success: true, message: "Document moved to Trash" });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// RESTORE DOCUMENT (out of Trash)
// If the document's folder is missing or itself still trashed, the
// document is restored to root instead of resurrecting into a
// dangling/hidden folder.
// ─────────────────────────────────────────────────────────────────
export const restoreDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }
    if (!canModify(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }
    if (!doc.isDeleted) {
      res.json({ success: true, message: "Document is not in Trash", data: { document: attachSignedUrls(doc) } });
      return;
    }

    const update: Record<string, unknown> = {
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
    };
    if (doc.folderId) {
      const parent = await FolderModel.findById(doc.folderId);
      if (!parent || parent.isDeleted) {
        update.folderId = null;
      }
    }

    await DocumentModel.findByIdAndUpdate(doc._id, { $set: update });
    Object.assign(doc, update);

    await invalidateCache(req.user!.userId);
    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "restored",
    });
    res.json({
      success: true,
      message: "Document restored",
      data: { document: attachSignedUrls(doc) },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// PERMANENTLY DELETE DOCUMENT
// Only allowed once the document is already in Trash — actually
// removes the DB row, its comments, and the file on disk.
// ─────────────────────────────────────────────────────────────────
export const permanentlyDeleteDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }
    if (!canModify(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "Only the owner or CEO can delete this document",
      });
      return;
    }
    if (!doc.isDeleted) {
      res.status(400).json({
        success: false,
        message: "Move the document to Trash before deleting it permanently",
      });
      return;
    }

    if (doc.fileKey) {
      const p = path.join(process.env.UPLOAD_DIR ?? "./uploads", doc.fileKey);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* non-fatal */
        }
      }
    }

    await doc.deleteOne();
    await CommentModel.deleteMany({ documentId: doc._id });
    await DocumentReadModel.deleteMany({ documentId: doc._id });
    await invalidateCache(req.user!.userId);
    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "permanently_deleted",
    });
    res.json({ success: true, message: "Document permanently deleted" });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// TOGGLE STAR
// ─────────────────────────────────────────────────────────────────
export const toggleStarDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }
    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }
    const newStarred = !doc.isStarred;
    await DocumentModel.findByIdAndUpdate(doc._id, {
      $set: { isStarred: newStarred },
    });
    doc.isStarred = newStarred;
    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: doc.isStarred ? "starred" : "unstarred",
    });
    res.json({ success: true, data: { document: attachSignedUrls(doc) } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// COPY / DUPLICATE DOCUMENT
// Anyone with read access can make their own copy (mirrors Drive's
// "Make a copy"). The copy is always owned by the requester, its
// file is physically duplicated on disk, and it starts life outside
// of Trash and unstarred regardless of the original's state.
// ─────────────────────────────────────────────────────────────────
export const copyDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }
    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const { targetFolderId } = req.body as { targetFolderId?: string | null };
    const destFolderId =
      targetFolderId !== undefined
        ? targetFolderId
          ? new mongoose.Types.ObjectId(targetFolderId)
          : null
        : doc.folderId;

    // Same-folder copies get a "(copy)" suffix so they don't look like
    // the original was just renamed; copies moved to a different
    // folder keep the original name, matching Drive's behavior.
    const movingElsewhere =
      targetFolderId !== undefined &&
      String(targetFolderId || "") !== String(doc.folderId || "");
    const titleOverride = movingElsewhere ? doc.title : `${doc.title} (copy)`;

    const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
    const copy = await cloneDocumentRecord(
      doc,
      destFolderId as any,
      req.user!.userId,
      uploadDir,
      titleOverride,
    );

    await createAuditLog({
      documentId: String(copy._id),
      actorId: req.user!.userId,
      action: "copied",
      details: { sourceDocumentId: String(doc._id) },
    });
    await invalidateCache(req.user!.userId);

    res.json({
      success: true,
      message: "Document copied",
      data: { document: attachSignedUrls(copy) },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// BULK DELETE DOCUMENTS (moves to Trash)
// Same rule as single delete (owner or CEO), applied per-document.
// Items the requester can't modify or that don't exist are skipped
// and reported back in `failed` rather than failing the whole batch —
// a multi-select delete shouldn't abort just because one item in the
// selection belongs to someone else or was already removed.
// ─────────────────────────────────────────────────────────────────
export const bulkDeleteDocuments = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { ids } = req.body as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      res
        .status(400)
        .json({ success: false, message: "No document ids provided" });
      return;
    }

    const uniqueIds = [...new Set(ids)].filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    );
    const docs = await DocumentModel.find({ _id: { $in: uniqueIds } });
    const foundIds = new Set(docs.map((d) => String(d._id)));

    const deletedIds: string[] = [];
    const failed: { id: string; reason: "not_found" | "forbidden" }[] = [];
    for (const id of uniqueIds) {
      if (!foundIds.has(id)) failed.push({ id, reason: "not_found" });
    }

    const now = new Date();
    for (const doc of docs) {
      if (!canModify(doc, req.user!.userId, req.user!.role)) {
        failed.push({ id: String(doc._id), reason: "forbidden" });
        continue;
      }

      await DocumentModel.findByIdAndUpdate(doc._id, {
        $set: {
          isDeleted: true,
          deletedAt: now,
          deletedBy: new mongoose.Types.ObjectId(req.user!.userId),
        },
      });
      await createAuditLog({
        documentId: String(doc._id),
        actorId: req.user!.userId,
        action: "trashed",
      });
      deletedIds.push(String(doc._id));
    }

    await invalidateCache(req.user!.userId);

    res.json({
      success: true,
      message: `${deletedIds.length} document${deletedIds.length === 1 ? "" : "s"} moved to Trash${
        failed.length ? `, ${failed.length} skipped` : ""
      }`,
      data: { deletedIds, failed },
    });
  } catch (err) {
    next(err);
  }
};

// ═════════════════════════════════════════════════════════════════
// REPLACE FILE (no versioning — old file is deleted, new one takes over)
// ═════════════════════════════════════════════════════════════════
export const replaceFile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    if (!canModify(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({
        success: false,
        message: "Only the owner or CEO can replace this file",
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, message: "No file provided" });
      return;
    }

    // Delete the old file from disk — same missing-fileKey guard as
    // deleteDocument above, so replacing a file on a malformed record
    // doesn't 500 either.
    if (doc.fileKey) {
      const oldPath = path.join(
        process.env.UPLOAD_DIR ?? "./uploads",
        doc.fileKey,
      );
      if (fs.existsSync(oldPath))
        try {
          fs.unlinkSync(oldPath);
        } catch {
          /* non-fatal */
        }
    }

    const fileUrl = getLocalFileUrl(req.file.filename);
    const extracted = await extractTextContent(
      req.file.path,
      req.file.mimetype,
      req.file.originalname,
    );

    doc.fileName = req.file.originalname;
    doc.fileKey = req.file.filename;
    doc.fileUrl = fileUrl;
    doc.fileSize = req.file.size;
    doc.fileType = req.file.mimetype;
    doc.modifiedBy = new mongoose.Types.ObjectId(req.user!.userId);
    doc.modifiedAt = new Date();
    if (extracted !== undefined) doc.contentText = extracted;

    await doc.save();
    await invalidateCache(req.user!.userId);
    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "edited",
    });

    res.json({
      success: true,
      message: "File replaced",
      data: { document: attachSignedUrls(doc) },
    });
  } catch (err) {
    next(err);
  }
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
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id).select(
      "ownerId supervisorId documentType _id",
    );
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const { text } = req.body as { text: string };
    if (!text?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Comment text is required" });
      return;
    }

    const comment = await CommentModel.create({
      documentId: doc._id,
      user: req.user!.userId,
      text: text.trim(),
    });

    const populated = await comment.populate("user", "name email role");
    res.status(201).json({
      success: true,
      message: "Comment added",
      data: { comment: populated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// LIST COMMENTS
// ─────────────────────────────────────────────────────────────────
export const getComments = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id).select(
      "ownerId supervisorId documentType _id",
    );
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const comments = await CommentModel.find({ documentId: req.params.id })
      .populate("user", "name email role")
      .sort({ createdAt: 1 });
    res.json({ success: true, data: { comments } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE COMMENT
// Only the comment's author can edit it.
// ─────────────────────────────────────────────────────────────────
export const updateComment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { commentId } = req.params as { commentId: string };
    const { text } = req.body as { text: string };

    if (!text?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Comment text is required" });
      return;
    }

    const comment = await CommentModel.findById(commentId);
    if (!comment) {
      res.status(404).json({ success: false, message: "Comment not found" });
      return;
    }

    if (comment.user.toString() !== req.user!.userId) {
      res.status(403).json({
        success: false,
        message: "You can only edit your own comments",
      });
      return;
    }

    comment.text = text.trim();
    await comment.save();

    const populated = await comment.populate("user", "name email role");
    res.json({
      success: true,
      message: "Comment updated",
      data: { comment: populated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// DELETE COMMENT
// The comment's author, the document owner, or the CEO can delete.
// ─────────────────────────────────────────────────────────────────
export const deleteComment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id, commentId } = req.params as { id: string; commentId: string };
    const comment = await CommentModel.findById(commentId);
    if (!comment) {
      res.status(404).json({ success: false, message: "Comment not found" });
      return;
    }

    const doc = await DocumentModel.findById(id).select("ownerId");
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    const isAuthor = comment.user.toString() === req.user!.userId;
    const isDocOwner = doc.ownerId.toString() === req.user!.userId;
    const isCEO = req.user!.role === "ceo";

    if (!isAuthor && !isDocOwner && !isCEO) {
      res.status(403).json({
        success: false,
        message: "Not authorised to delete this comment",
      });
      return;
    }

    await comment.deleteOne();
    res.json({ success: true, message: "Comment deleted" });
  } catch (err) {
    next(err);
  }
};

// ═════════════════════════════════════════════════════════════════
// PREVIEW, DOWNLOAD, MOVE, ACTIVITY
// ═════════════════════════════════════════════════════════════════

export const previewDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false });
      return;
    }

    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    if (!doc.fileKey) {
      res.status(404).json({ success: false, message: "No file found" });
      return;
    }

    const filePath = path.join(
      process.env.UPLOAD_DIR ?? "./uploads",
      doc.fileKey,
    );
    const mimeType = doc.fileType;

    // DOCX → HTML via mammoth (no LibreOffice)
    const isDocx =
      mimeType.includes("wordprocessingml") || mimeType.includes("msword");
    if (isDocx && fs.existsSync(filePath)) {
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({ path: filePath });
        res.json({
          success: true,
          type: "html",
          html: result.value,
          url: buildSignedFileUrl(doc.fileKey),
        });
        return;
      } catch (e) {
        console.error("mammoth failed, falling back:", e);
      }
    }

    // PDF / images / everything else → return URL for browser rendering
    res.json({
      success: true,
      type: mimeType,
      url: buildSignedFileUrl(doc.fileKey),
    });
  } catch (err) {
    next(err);
  }
};

export const downloadDocument = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    if (!doc.fileKey) {
      res.status(404).json({ success: false, message: "File not found" });
      return;
    }

    await createAuditLog({
      documentId: req.params.id,
      actorId: req.user!.userId,
      action: "downloaded",
    });

    const filePath = path.join(
      process.env.UPLOAD_DIR ?? "./uploads",
      doc.fileKey,
    );
    if (!fs.existsSync(filePath)) {
      res
        .status(404)
        .json({ success: false, message: "File missing from disk" });
      return;
    }

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(doc.fileName)}"`,
    );
    res.setHeader("Content-Type", doc.fileType);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    next(err);
  }
};

export const moveDocument = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false });
      return;
    }
    if (!canModify(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({ success: false });
      return;
    }
    await DocumentModel.findByIdAndUpdate(doc._id, {
      $set: { folderId: req.body.targetFolderId || null },
    });
    await invalidateCache(req.user!.userId);
    res.json({ success: true, message: "Document moved" });
    return;
  } catch {
    res.status(500).json({ success: false });
    return;
  }
};

export const getDocumentActivity = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const doc = await DocumentModel.findById(req.params.id).select(
      "ownerId supervisorId documentType",
    );
    if (!doc) {
      res.status(404).json({ success: false });
      return;
    }

    // Same visibility rule as the rest of the document — without this,
    // any authenticated user could read another document's full audit
    // trail (who viewed/edited/downloaded it) just by guessing its ID.
    const access = await canAccess(
      doc as Parameters<typeof canAccess>[0],
      req.user!.userId,
      req.user!.role,
    );
    if (!access) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const logs = await AuditLog.find({ documentId: req.params.id }).sort({
      createdAt: -1,
    });
    res.json({ success: true, data: logs });
    return;
  } catch {
    res.status(500).json({ success: false });
    return;
  }
};