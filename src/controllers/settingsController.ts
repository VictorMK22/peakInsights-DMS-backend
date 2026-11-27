import { Response } from "express";
import { AuthRequest } from "../types/auth";
import { createAuditLog } from "../utils/auditLogger";
import {
  canToggleDeletion,
  getDocumentDeletionSetting,
  setUserDeleteEnabled,
} from "../utils/documentDeletionPolicy";

// GET /api/settings/document-deletion
// Readable by any signed-in user (the UI needs it to show/hide Delete
// buttons). `canToggle` tells the UI whether to render the switch.
export const getDocumentDeletion = async (req: AuthRequest, res: Response) => {
  try {
    const [setting, canToggle] = await Promise.all([
      getDocumentDeletionSetting(),
      canToggleDeletion(req.user!.userId, req.user!.role),
    ]);
    res.json({
      success: true,
      data: {
        userDeleteEnabled: setting.userDeleteEnabled,
        canToggle,
        updatedAt: setting.updatedAt ?? null,
      },
    });
  } catch (err) {
    console.error("getDocumentDeletion error:", err);
    res.status(500).json({ success: false });
  }
};

// PUT /api/settings/document-deletion   { userDeleteEnabled: boolean }
// CEO or Tech supervisor only. The switch never changes what the CEO or a
// Tech supervisor themselves may delete — see utils/documentDeletionPolicy.
export const setDocumentDeletion = async (req: AuthRequest, res: Response) => {
  try {
    const { userId, role } = req.user!;
    if (!(await canToggleDeletion(userId, role))) {
      res.status(403).json({
        success: false,
        message:
          "Only the CEO or a Tech supervisor can change this setting",
      });
      return;
    }
    const enabled = req.body?.userDeleteEnabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({
        success: false,
        message: "userDeleteEnabled must be true or false",
      });
      return;
    }

    const setting = await setUserDeleteEnabled(enabled, userId);
    await createAuditLog({
      actorId: userId,
      action: "edited",
      details: { setting: "documentDeletion", userDeleteEnabled: enabled },
    });
    res.json({
      success: true,
      message: enabled
        ? "Users can now delete their documents"
        : "Document deletion is now off for users",
      data: {
        userDeleteEnabled: setting.userDeleteEnabled,
        canToggle: true,
        updatedAt: setting.updatedAt ?? null,
      },
    });
  } catch (err) {
    console.error("setDocumentDeletion error:", err);
    res.status(500).json({ success: false });
  }
};