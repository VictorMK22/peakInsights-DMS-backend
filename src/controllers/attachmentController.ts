import { Response, NextFunction } from "express";
import { Model } from "mongoose";
import { AuthRequest } from "../types/auth";
import { getLocalFileUrl } from "../middleware/upload";
import { IAttachment } from "../models/shared/AttachmentSchema";

// One generic factory instead of three near-identical controllers —
// tickets/assets/deployments all attach files the same way (same
// upload middleware, same subdocument shape), so the only thing that
// differs per resource is which Mongoose model to operate on.

export const enrichAttachments = <T extends { attachments?: IAttachment[] }>(
  doc: T,
) => {
  const attachments = (doc.attachments ?? []).map((a) => ({
    ...(typeof (a as unknown as { toObject?: () => IAttachment }).toObject ===
    "function"
      ? (a as unknown as { toObject: () => IAttachment }).toObject()
      : a),
    url: getLocalFileUrl(a.fileKey),
  }));
  return { ...(doc as unknown as Record<string, unknown>), attachments };
};

export const makeAddAttachments =
  (model: Model<any>) =>
  async (
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const files: Express.Multer.File[] = req.files
        ? Array.isArray(req.files)
          ? req.files
          : Object.values(req.files).flat()
        : req.file
          ? [req.file]
          : [];

      if (!files.length) {
        res
          .status(400)
          .json({ success: false, message: "No file(s) provided" });
        return;
      }

      const newAttachments = files.map((f) => ({
        fileKey: f.filename,
        filename: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
        uploadedBy: req.user!.userId,
        uploadedAt: new Date(),
      }));

      const doc = await model.findByIdAndUpdate(
        req.params.id,
        { $push: { attachments: { $each: newAttachments } } },
        { new: true },
      );
      if (!doc) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
      }
      res
        .status(201)
        .json({
          success: true,
          message: "Attachment(s) added",
          data: enrichAttachments(doc.toObject()),
        });
    } catch (err) {
      next(err);
    }
  };

export const makeRemoveAttachment =
  (model: Model<any>) =>
  async (
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const doc = await model.findByIdAndUpdate(
        req.params.id,
        { $pull: { attachments: { _id: req.params.attachmentId } } },
        { new: true },
      );
      if (!doc) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
      }
      res.json({
        success: true,
        message: "Attachment removed",
        data: enrichAttachments(doc.toObject()),
      });
    } catch (err) {
      next(err);
    }
  };
