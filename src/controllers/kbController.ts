import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { KbArticle } from "../models/KbArticle";

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
    const articles = await KbArticle.find(filter).populate("author", "name").sort({ updatedAt: -1 });
    res.json({ success: true, message: "Articles retrieved", data: { articles } });
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
    res.json({ success: true, message: "Article retrieved", data: { article } });
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
      res.status(400).json({ success: false, message: "title and body are required" });
      return;
    }
    const article = await KbArticle.create({
      title: title.trim(),
      body,
      category,
      author: req.user!.userId,
    });
    res.status(201).json({ success: true, message: "Article created", data: { article } });
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
    const article = await KbArticle.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!article) {
      res.status(404).json({ success: false, message: "Article not found" });
      return;
    }
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
