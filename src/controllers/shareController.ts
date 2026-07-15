import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { ShareLink } from "../models/ShareLink";
import { DocumentModel } from "../models/Document";
import { AuthRequest } from "../types/auth";

const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;

// Sharing a document publicly is at least as sensitive as editing or
// deleting it — same rule as canModify in documentController: owner,
// CEO, or a supervisor managing a 'learning' document.
const canShare = (
  doc: { ownerId: { toString(): string }; documentType?: string },
  userId: string,
  role: string,
): boolean => {
  if (role === "ceo") return true;
  if (doc.ownerId.toString() === userId) return true;
  if (role === "supervisor" && doc.documentType === "learning") return true;
  return false;
};

/**
 * POST /documents/:documentId/share
 * Creates a public, token-protected link to the document's current
 * file. Requires authentication and ownership — anyone who *can* see
 * this endpoint already had access to the document; this just lets
 * them deliberately extend that access to someone outside the app.
 */
export const createShareLink = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { documentId } = req.params;
    const { expiresInDays } = req.body as { expiresInDays?: number };

    const doc = await DocumentModel.findById(documentId).select(
      "ownerId documentType",
    );
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    if (!canShare(doc, req.user!.userId, req.user!.role)) {
      res
        .status(403)
        .json({
          success: false,
          message: "Only the owner or CEO can share this document",
        });
      return;
    }

    const days = Math.min(
      Math.max(Math.trunc(expiresInDays ?? DEFAULT_EXPIRY_DAYS), 1),
      MAX_EXPIRY_DAYS,
    );
    const token = crypto.randomBytes(24).toString("hex");

    const link = await ShareLink.create({
      documentId,
      token,
      createdBy: req.user!.userId,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    });

    res.status(201).json({
      success: true,
      data: {
        url: `${process.env.FRONTEND_URL ?? "http://localhost:5173"}/share/${token}`,
        token,
        expiresAt: link.expiresAt,
      },
    });
  } catch (err) {
    console.error("createShareLink error:", err);
    res.status(500).json({ success: false });
  }
};

/**
 * GET /documents/:documentId/share
 * Lists active/past share links for a document, for the owner/CEO to
 * review or manage — there was previously no way to even see what had
 * been shared.
 */
export const listShareLinks = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { documentId } = req.params;
    const doc = await DocumentModel.findById(documentId).select(
      "ownerId documentType",
    );
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    if (!canShare(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const links = await ShareLink.find({ documentId }).sort({ createdAt: -1 });
    res.json({ success: true, data: { links } });
  } catch (err) {
    console.error("listShareLinks error:", err);
    res.status(500).json({ success: false });
  }
};

/**
 * DELETE /share-links/:linkId
 * Revokes a link early, before its natural expiration.
 */
export const revokeShareLink = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { linkId } = req.params;
    const link = await ShareLink.findById(linkId);
    if (!link) {
      res.status(404).json({ success: false, message: "Share link not found" });
      return;
    }

    const doc = await DocumentModel.findById(link.documentId).select(
      "ownerId documentType",
    );
    if (!doc || !canShare(doc, req.user!.userId, req.user!.role)) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    link.revokedAt = new Date();
    await link.save();
    res.json({ success: true, message: "Share link revoked" });
  } catch (err) {
    console.error("revokeShareLink error:", err);
    res.status(500).json({ success: false });
  }
};

/**
 * GET /share/:token/info  — PUBLIC, no authentication.
 * Returns just enough metadata for the public landing page to show
 * what's being shared, without serving the file itself.
 */
export const getSharedDocumentInfo = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { token } = req.params;
    const link = await ShareLink.findOne({ token });

    if (!link) {
      res.status(404).json({ success: false, message: "Link not found" });
      return;
    }
    if (link.revokedAt) {
      res
        .status(403)
        .json({ success: false, message: "This link has been revoked" });
      return;
    }
    if (link.expiresAt < new Date()) {
      res
        .status(403)
        .json({ success: false, message: "This link has expired" });
      return;
    }

    const doc = await DocumentModel.findById(link.documentId).select("title");
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
      return;
    }

    res.json({
      success: true,
      data: { title: doc.title, expiresAt: link.expiresAt },
    });
  } catch (err) {
    console.error("getSharedDocumentInfo error:", err);
    res.status(500).json({ success: false });
  }
};

/**
 * GET /share/:token  — PUBLIC, no authentication.
 *
 * The token itself is the credential (32 random bytes, unguessable),
 * so anyone holding a valid, non-expired, non-revoked link can view
 * the file. This actually streams the file — it does NOT redirect to
 * an authenticated route, which is what made the old version
 * non-functional for real external sharing.
 */
export const accessSharedDocument = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { token } = req.params;
    const link = await ShareLink.findOne({ token });

    if (!link) {
      res.status(404).json({ success: false, message: "Link not found" });
      return;
    }
    if (link.revokedAt) {
      res
        .status(403)
        .json({ success: false, message: "This link has been revoked" });
      return;
    }
    if (link.expiresAt < new Date()) {
      res
        .status(403)
        .json({ success: false, message: "This link has expired" });
      return;
    }

    const doc = await DocumentModel.findById(link.documentId);
    if (!doc) {
      res.status(404).json({ success: false, message: "Document not found" });
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
    if (!fs.existsSync(filePath)) {
      res
        .status(404)
        .json({ success: false, message: "File missing from disk" });
      return;
    }

    link.accessCount = (link.accessCount ?? 0) + 1;
    link.lastAccessedAt = new Date();
    await link.save();

    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(doc.fileName)}"`,
    );
    res.setHeader("Content-Type", doc.fileType);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("accessSharedDocument error:", err);
    res.status(500).json({ success: false });
  }
};
