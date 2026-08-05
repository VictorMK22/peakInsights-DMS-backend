import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { Asset } from "../models/Asset";

export const listAssets = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    const assets = await Asset.find(filter).populate("owner", "name email").sort({ createdAt: -1 });
    res.json({ success: true, message: "Assets retrieved", data: { assets } });
  } catch (err) {
    next(err);
  }
};

export const createAsset = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { name, type, owner, department, status, purchaseDate, warrantyExpiry } = req.body;
    if (!name?.trim() || !type) {
      res.status(400).json({ success: false, message: "name and type are required" });
      return;
    }
    const asset = await Asset.create({
      name: name.trim(),
      type,
      owner,
      department,
      status,
      purchaseDate,
      warrantyExpiry,
      createdBy: req.user!.userId,
    });
    res.status(201).json({ success: true, message: "Asset created", data: { asset } });
  } catch (err) {
    next(err);
  }
};

export const updateAsset = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const asset = await Asset.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!asset) {
      res.status(404).json({ success: false, message: "Asset not found" });
      return;
    }
    res.json({ success: true, message: "Asset updated", data: { asset } });
  } catch (err) {
    next(err);
  }
};

export const deleteAsset = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await Asset.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Asset deleted", data: {} });
  } catch (err) {
    next(err);
  }
};
