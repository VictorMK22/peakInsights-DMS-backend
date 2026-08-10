import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { KbArticle } from "../models/KbArticle";
import { getLocalFileUrl } from "../middleware/upload";

export const listKbArticles = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { q, category } = req.query as { q?: string; category?: string };
    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (q) filter.$text = { $search: q };
    const articles = await KbArticle.find(filter)
      .populate("author", "name")
      .sort({ updatedAt: -1 });
    res.json({
      success: true,
      message: "Articles retrieved",
      data: { articles },
    });
  } catch (err) {
    next(err);
  }
};

export const getKbArticle = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const article = await KbArticle.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true },
    ).populate("author", "name");
    if (!article) {
      res.status(404).json({ success: false, message: "Article not found" });
      return;
    }
    res.json({
      success: true,
      message: "Article retrieved",
      data: { article },
    });
  } catch (err) {
    next(err);
  }
};

export const createKbArticle = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { title, body, category } = req.body;
    if (!title?.trim() || !body?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "title and body are required" });
      return;
    }
    const article = await KbArticle.create({
      title: title.trim(),
      body,
      category,
      author: req.user!.userId,
    });
    res
      .status(201)
      .json({ success: true, message: "Article created", data: { article } });
  } catch (err) {
    next(err);
  }
};

export const updateKbArticle = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const existing = await KbArticle.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Article not found" });
      return;
    }

    const { title, body, category } = req.body as {
      title?: string;
      body?: string;
      category?: string;
    };
    const update: Record<string, unknown> = {};
    if (title !== undefined) update.title = title;
    if (category !== undefined) update.category = category;

    // Only snapshot + bump body when it actually changed — editing
    // just the title/category shouldn't clutter version history with
    // a no-op "edit".
    if (body !== undefined && body !== existing.body) {
      update.body = body;
      update.$push = {
        versions: {
          body: existing.body,
          editedBy: req.user!.userId,
          editedAt: new Date(),
        },
      };
    }

    const article = await KbArticle.findByIdAndUpdate(req.params.id, update, {
      new: true,
    });
    res.json({ success: true, message: "Article updated", data: { article } });
  } catch (err) {
    next(err);
  }
};

export const deleteKbArticle = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await KbArticle.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Article deleted", data: {} });
  } catch (err) {
    next(err);
  }
};

// Standalone image upload for the markdown editor's "insert image"
// button — deliberately not tied to a specific article (the article
// may not exist yet while someone is drafting it). Returns a signed
// URL to embed directly as markdown: ![alt](url). Uses the same S3
// upload pipeline as everything else (see middleware/upload.ts).
export const uploadKbImage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No image provided" });
      return;
    }
    // Unlike a one-off document preview link, this URL gets baked
    // directly into the article's markdown body and needs to keep
    // working long after upload — the default 30-minute expiry
    // (see buildSignedFileUrl) would silently break every embedded
    // image shortly after the article was saved.
    const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
    const url = getLocalFileUrl(req.file.filename, ONE_YEAR_SECONDS);
    res
      .status(201)
      .json({ success: true, message: "Image uploaded", data: { url } });
  } catch (err) {
    next(err);
  }
};
