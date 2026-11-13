import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { ClientModel } from "../models/Client";
import { ClientExtraFieldModel } from "../models/ClientExtraField";
import { encryptToken, decryptToken } from "../utils/tokenCrypto";
import { getAccountantSupervisorIds } from "../utils/accountantSupervisors";
import { User } from "../models/User";
import { isTechDepartmentName } from "../middleware/auth";

// ═══════════════════════════════════════════════════════════════
// CLIENT EXTRA INFO — custom label/value pairs (iTax / eTIMS logins, …)
//
// Only for WON or EXISTING clients (never a live prospect), and only for:
//   - the CEO,
//   - a Tech department supervisor (NOT every tech user),
//   - the accountant(s) assigned to the client,
//   - the sales person who won the client.
// The same rule governs reading and writing.
// ═══════════════════════════════════════════════════════════════

const MASK = "••••••••";

type Access =
  | { ok: true }
  | { ok: false; status: number; message: string };

const checkAccess = async (req: AuthRequest): Promise<Access> => {
  const { userId, role } = req.user!;
  if (!mongoose.Types.ObjectId.isValid(req.params.id))
    return { ok: false, status: 404, message: "Client not found" };

  const client = await ClientModel.findById(req.params.id).select(
    "assignedTo createdBy isSalesLead salesStage",
  );
  if (!client) return { ok: false, status: 404, message: "Client not found" };

  // Prospects still in the pipeline have nothing to store yet.
  const wonOrExisting = !client.isSalesLead || client.salesStage === "won";
  if (!wonOrExisting)
    return {
      ok: false,
      status: 400,
      message: "Extra info is only available for won or existing clients",
    };

  const deny: Access = {
    ok: false,
    status: 403,
    message:
      "Only the CEO, the assigned accountant(s) or the sales person who won this client can access this information",
  };

  if (role === "ceo") return { ok: true };

  // Tech access is limited to Tech-department supervisors; ordinary tech
  // users get nothing here.
  if (role === "supervisor") {
    const me = await User.findById(userId).select("department");
    if (isTechDepartmentName(me?.department)) return { ok: true };
  }

  const isAssigned = client.assignedTo.some((id) => id.toString() === userId);

  if (role === "accountant" && isAssigned) return { ok: true };
  if (role === "supervisor" && isAssigned) {
    // Only supervisors who actually work as accountants count.
    const supervisorIds = await getAccountantSupervisorIds();
    if (supervisorIds.has(userId)) return { ok: true };
  }
  // The sales person who won the client (they created the lead).
  if (
    role === "sales_person" &&
    client.isSalesLead &&
    client.createdBy?.toString() === userId
  )
    return { ok: true };

  return deny;
};

const serialize = (f: any) => ({
  _id: String(f._id),
  label: f.label,
  value: f.isSecret ? MASK : f.value,
  isSecret: f.isSecret,
  createdBy: f.createdBy,
  updatedBy: f.updatedBy,
  createdAt: f.createdAt,
  updatedAt: f.updatedAt,
});

const cleanInput = (body: any) => {
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";
  return { label, value, isSecret: body?.isSecret === true };
};

// GET /clients/:id/extra-info
export const getClientExtraInfo = async (req: AuthRequest, res: Response) => {
  try {
    const access = await checkAccess(req);
    if (!access.ok)
      return res
        .status(access.status)
        .json({ success: false, message: access.message });

    const fields = await ClientExtraFieldModel.find({ clientId: req.params.id })
      .sort({ createdAt: 1 })
      .populate("createdBy", "name")
      .populate("updatedBy", "name")
      .lean();
    return res.json({
      success: true,
      data: { fields: fields.map(serialize) },
    });
  } catch {
    return res.status(500).json({ success: false });
  }
};

// POST /clients/:id/extra-info  { label, value, isSecret? }
export const createClientExtraField = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const access = await checkAccess(req);
    if (!access.ok)
      return res
        .status(access.status)
        .json({ success: false, message: access.message });

    const { label, value, isSecret } = cleanInput(req.body);
    if (!label || label.length > 100)
      return res.status(400).json({
        success: false,
        message: "Field name is required (max 100 characters)",
      });
    if (!value.trim() || value.length > 4000)
      return res.status(400).json({
        success: false,
        message: "Value is required (max 4000 characters)",
      });

    const created = await ClientExtraFieldModel.create({
      clientId: req.params.id,
      label,
      value: isSecret ? encryptToken(value) : value,
      isSecret,
      createdBy: req.user!.userId,
    });
    return res.status(201).json({
      success: true,
      data: { field: serialize(created.toObject()) },
    });
  } catch {
    return res.status(500).json({ success: false });
  }
};

// PUT /clients/:id/extra-info/:fieldId  { label?, value?, isSecret? }
// Omit `value` to keep the stored value (e.g. just rename a secret field
// without having to reveal and re-type it).
export const updateClientExtraField = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const access = await checkAccess(req);
    if (!access.ok)
      return res
        .status(access.status)
        .json({ success: false, message: access.message });
    if (!mongoose.Types.ObjectId.isValid(req.params.fieldId))
      return res.status(404).json({ success: false });

    const field = await ClientExtraFieldModel.findOne({
      _id: req.params.fieldId,
      clientId: req.params.id,
    });
    if (!field) return res.status(404).json({ success: false });

    const { label, value } = cleanInput(req.body);
    const nextSecret =
      typeof req.body?.isSecret === "boolean"
        ? req.body.isSecret
        : field.isSecret;

    if (req.body?.label !== undefined) {
      if (!label || label.length > 100)
        return res.status(400).json({
          success: false,
          message: "Field name is required (max 100 characters)",
        });
      field.label = label;
    }

    if (req.body?.value !== undefined && value !== "") {
      if (value.length > 4000)
        return res
          .status(400)
          .json({ success: false, message: "Value is too long" });
      field.value = nextSecret ? encryptToken(value) : value;
    } else if (nextSecret !== field.isSecret) {
      // Toggling secrecy without a new value: re-store the existing one.
      const plain = field.isSecret ? decryptToken(field.value) : field.value;
      field.value = nextSecret ? encryptToken(plain) : plain;
    }
    field.isSecret = nextSecret;
    field.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    await field.save();

    return res.json({
      success: true,
      data: { field: serialize(field.toObject()) },
    });
  } catch {
    return res.status(500).json({ success: false });
  }
};

// DELETE /clients/:id/extra-info/:fieldId
export const deleteClientExtraField = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const access = await checkAccess(req);
    if (!access.ok)
      return res
        .status(access.status)
        .json({ success: false, message: access.message });
    if (!mongoose.Types.ObjectId.isValid(req.params.fieldId))
      return res.status(404).json({ success: false });

    const removed = await ClientExtraFieldModel.findOneAndDelete({
      _id: req.params.fieldId,
      clientId: req.params.id,
    });
    if (!removed) return res.status(404).json({ success: false });
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ success: false });
  }
};

// GET /clients/:id/extra-info/:fieldId/reveal → { value }
// The only place a secret is ever decrypted. Never cached.
export const revealClientExtraField = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const access = await checkAccess(req);
    if (!access.ok)
      return res
        .status(access.status)
        .json({ success: false, message: access.message });
    if (!mongoose.Types.ObjectId.isValid(req.params.fieldId))
      return res.status(404).json({ success: false });

    const field = await ClientExtraFieldModel.findOne({
      _id: req.params.fieldId,
      clientId: req.params.id,
    });
    if (!field) return res.status(404).json({ success: false });

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      success: true,
      data: {
        value: field.isSecret ? decryptToken(field.value) : field.value,
      },
    });
  } catch {
    return res.status(500).json({ success: false });
  }
};