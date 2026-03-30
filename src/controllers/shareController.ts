import crypto from "crypto";
import { Request, Response } from "express";
import { ShareLink } from "../models/ShareLink";

export const createShareLink = async (req: Request, res: Response) => {
  const { documentId } = req.params;

  const token = crypto.randomBytes(24).toString("hex");

  const link = await ShareLink.create({
    documentId,
    token,
    isPublic: true
  });

  res.json({
    success: true,
    url: `${process.env.APP_URL}/share/${token}`
  });
};

export const accessSharedDocument = async (req: Request, res: Response) => {
    const { token } = req.params;
  
    const link = await ShareLink.findOne({ token });
  
    if (!link) {
      return res.status(404).json({ success: false });
    }
  
    if (link.expiresAt && link.expiresAt < new Date()) {
      return res.status(403).json({ success: false, message: "Link expired" });
    }
  
    res.redirect(`/api/documents/${link.documentId}/preview`);
  };