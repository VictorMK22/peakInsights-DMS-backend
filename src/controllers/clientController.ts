import { Response } from "express";
import { AuthRequest } from "../types/auth";
import { ClientModel, SALES_STAGES, SalesStage } from "../models/Client";
import {
  ClientEmailModel,
  IClientEmailAttachment,
} from "../models/ClientEmail";
import { DocumentModel } from "../models/Document";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { sendDirectUserEmail } from "../services/emailService";
import { getLocalFileUrl } from "../middleware/upload";
import { createNotification } from "../services/notificationService";
import mongoose from "mongoose";

// ── helpers ───────────────────────────────────────────────────────

const isCEO = (r: AuthRequest) =>
  r.user!.role === "ceo" || r.user!.role === "tech";
const isSalesPerson = (r: AuthRequest) => r.user!.role === "sales_person";

/** Attach fresh short-lived signed URLs to a set of stored attachments. */
const withSignedAttachmentUrls = (attachments: IClientEmailAttachment[] = []) =>
  attachments.map((a) => ({
    ...(typeof (a as any).toObject === "function" ? (a as any).toObject() : a),
    url: getLocalFileUrl(a.fileKey),
  }));

/** Check whether this user can access a client's data */
export const canAccess = async (
  clientId: string,
  userId: string,
  role: string,
): Promise<boolean> => {
  if (role === "ceo" || role === "tech") return true;
  const client = await ClientModel.findById(clientId).select("assignedTo");
  if (!client) return false;
  // Direct assignee
  if (client.assignedTo.some((id) => id.toString() === userId)) return true;
  // Supervisor whose subordinate is assigned
  if (role === "supervisor") {
    const maps = await SupervisorMapping.find({
      supervisorId: userId,
      status: "active",
    }).select("subordinateId");
    const subIds = maps.map((m) => m.subordinateId.toString());
    return client.assignedTo.some((id) => subIds.includes(id.toString()));
  }
  return false;
};

// ═══════════════════════════════════════════════════════════════
// CLIENTS CRUD
// ═══════════════════════════════════════════════════════════════

export const createClient = async (req: AuthRequest, res: Response) => {
  // CEO can create any client. Sales persons (BD officers) can create
  // their own leads directly — these enter the sales pipeline and are
  // auto-assigned to the sales person who created them.
  if (!isCEO(req) && !isSalesPerson(req))
    return res.status(403).json({
      success: false,
      message: "Only CEO or a sales person can create clients",
    });
  try {
    const { name, email, phone, company, industry, address, notes } = req.body;
    if (!name?.trim())
      return res
        .status(400)
        .json({ success: false, message: "Client name is required" });

    const salesPersonCreating = isSalesPerson(req);
    const client = await ClientModel.create({
      name: name.trim(),
      email,
      phone,
      company,
      industry,
      address,
      notes,
      createdBy: req.user!.userId,
      assignedTo: salesPersonCreating ? [req.user!.userId] : [],
      assignedAt: salesPersonCreating ? new Date() : undefined,
      isSalesLead: salesPersonCreating,
      salesStage: salesPersonCreating ? "in_discussion" : undefined,
      salesStageHistory: salesPersonCreating
        ? [
            {
              stage: "in_discussion",
              changedBy: req.user!.userId,
              changedAt: new Date(),
            },
          ]
        : [],
    });
    res.status(201).json({ success: true, data: { client } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

export const getClients = async (req: AuthRequest, res: Response) => {
  try {
    const {
      page = "1",
      limit = "20",
      search,
      salesStage,
      salesOnly,
    } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);
    const uid = new mongoose.Types.ObjectId(req.user!.userId);

    const filter: Record<string, unknown> = {};

    if (isCEO(req)) {
      // CEO: all clients
    } else if (req.user!.role === "supervisor") {
      // Supervisor: clients where they are directly assigned OR any of their subordinates are assigned
      const maps = await SupervisorMapping.find({
        supervisorId: uid,
        status: "active",
      }).select("subordinateId");
      const subIds = maps.map((m) => m.subordinateId);
      filter.assignedTo = { $in: [uid, ...subIds] };
    } else {
      // User / Sales person: only directly assigned
      filter.assignedTo = uid;
    }

    // Sales pipeline filters — e.g. GET /clients?salesOnly=true&salesStage=won
    if (salesOnly === "true") filter.isSalesLead = true;
    if (salesStage) filter.salesStage = salesStage;
    if (search)
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { company: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];

    const [clients, total] = await Promise.all([
      ClientModel.find(filter)
        .populate("assignedTo", "name email role profilePicture")
        .populate("allocatedAccountant", "name email")
        .populate("createdBy", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      ClientModel.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { clients },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

export const getClient = async (req: AuthRequest, res: Response) => {
  try {
    const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
    if (!ok)
      return res.status(403).json({ success: false, message: "Access denied" });
    const client = await ClientModel.findById(req.params.id)
      .populate("assignedTo", "name email role profilePicture department")
      .populate("allocatedAccountant", "name email")
      .populate("createdBy", "name");
    if (!client) return res.status(404).json({ success: false });
    res.json({ success: true, data: { client } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

export const updateClient = async (req: AuthRequest, res: Response) => {
  const allowed =
    isCEO(req) ||
    (isSalesPerson(req) &&
      (await canAccess(req.params.id, req.user!.userId, req.user!.role)));
  if (!allowed)
    return res.status(403).json({
      success: false,
      message: "Only CEO or the assigned sales person can update this client",
    });
  try {
    const { name, email, phone, company, industry, address, notes } = req.body;

    const client = await ClientModel.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          name,
          email,
          phone,
          company,
          industry,
          address,
          notes,
        },
      },
      { new: true, runValidators: true },
    ).populate("assignedTo", "name email role profilePicture");
    if (!client) return res.status(404).json({ success: false });
    res.json({ success: true, data: { client } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

export const deleteClient = async (req: AuthRequest, res: Response) => {
  if (!isCEO(req))
    return res
      .status(403)
      .json({ success: false, message: "Only CEO can delete clients" });
  try {
    await ClientModel.findByIdAndDelete(req.params.id);
    await ClientEmailModel.deleteMany({ clientId: req.params.id });
    res.json({ success: true });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// ═══════════════════════════════════════════════════════════════
// ASSIGNMENT  POST /clients/:id/assign  { userIds: string[] }
// ═══════════════════════════════════════════════════════════════

export const assignClient = async (req: AuthRequest, res: Response) => {
  if (!isCEO(req))
    return res
      .status(403)
      .json({ success: false, message: "Only CEO can assign clients" });
  try {
    const { userIds } = req.body as { userIds: string[] };
    if (!Array.isArray(userIds))
      return res
        .status(400)
        .json({ success: false, message: "userIds must be an array" });
    const client = await ClientModel.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          assignedTo: userIds.map((id) => new mongoose.Types.ObjectId(id)),
          assignedAt: new Date(),
        },
      },
      { new: true },
    ).populate("assignedTo", "name email role profilePicture");
    if (!client) return res.status(404).json({ success: false });
    res.json({ success: true, data: { client } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// ═══════════════════════════════════════════════════════════════
// WON CLIENTS → CEO ALLOCATES AN ACCOUNTANT
// ═══════════════════════════════════════════════════════════════

// GET /clients/awaiting-allocation — won leads that have no accountant yet.
// CEO only. (A won client that already has an accountant among its
// assignees — e.g. assigned by hand before this flow existed — is not
// listed, so old data doesn't show up as pending.)
export const getAwaitingAllocation = async (
  req: AuthRequest,
  res: Response,
) => {
  if (!isCEO(req))
    return res
      .status(403)
      .json({ success: false, message: "Only the CEO can allocate accountants" });
  try {
    const clients = await ClientModel.find({
      isSalesLead: true,
      salesStage: "won",
      allocatedAccountant: { $exists: false },
    })
      .populate("assignedTo", "name email role")
      .populate("createdBy", "name")
      .sort({ wonAt: -1, updatedAt: -1 })
      .limit(100)
      .lean();

    const pending = clients.filter(
      (c: any) =>
        !(c.assignedTo ?? []).some((u: any) => u?.role === "accountant"),
    );
    res.json({ success: true, data: { clients: pending } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// POST /clients/:id/allocate-accountant  { accountantId }
// CEO only. Adds the accountant to the client's assignees (keeping the sales
// person who won it) and records the allocation. Calling it again with a
// different accountant re-allocates: the previous allocated accountant is
// removed.
export const allocateAccountant = async (req: AuthRequest, res: Response) => {
  if (!isCEO(req))
    return res
      .status(403)
      .json({ success: false, message: "Only the CEO can allocate accountants" });
  try {
    const { accountantId } = req.body as { accountantId?: string };
    if (!accountantId || !mongoose.Types.ObjectId.isValid(accountantId))
      return res
        .status(400)
        .json({ success: false, message: "accountantId is required" });

    const [client, accountant] = await Promise.all([
      ClientModel.findById(req.params.id),
      User.findById(accountantId).select("name email role isActive"),
    ]);
    if (!client)
      return res.status(404).json({ success: false, message: "Client not found" });
    if (client.salesStage !== "won")
      return res.status(400).json({
        success: false,
        message: "An accountant can only be allocated to a client that has been won",
      });
    if (!accountant || !accountant.isActive || accountant.role !== "accountant")
      return res
        .status(400)
        .json({ success: false, message: "Choose an active accountant" });

    const previous = client.allocatedAccountant?.toString();
    const next = accountant._id.toString();
    const assignees = client.assignedTo
      .map((id) => id.toString())
      .filter((id) => id !== previous);
    if (!assignees.includes(next)) assignees.push(next);

    client.assignedTo = assignees.map((id) => new mongoose.Types.ObjectId(id));
    client.assignedAt = new Date();
    client.allocatedAccountant = accountant._id as mongoose.Types.ObjectId;
    client.allocatedAt = new Date();
    client.allocatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    await client.save();

    // Tell the accountant, and the sales person who won the client.
    if (previous !== next) {
      try {
        await createNotification(
          next,
          `You have been allocated a new client: ${client.name}`,
          "client_allocated",
          { clientId: String(client._id) },
        );
        const salesId = client.createdBy?.toString();
        if (salesId && salesId !== req.user!.userId && salesId !== next) {
          await createNotification(
            salesId,
            `${client.name} has been allocated to ${accountant.name}`,
            "client_allocated",
            { clientId: String(client._id) },
          );
        }
      } catch (err) {
        console.error("❌ client_allocated notify failed:", err);
      }
    }

    const populated = await client.populate([
      { path: "assignedTo", select: "name email role profilePicture" },
      { path: "allocatedAccountant", select: "name email" },
    ]);
    res.json({ success: true, data: { client: populated } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// ═══════════════════════════════════════════════════════════════
// SALES PIPELINE — PATCH /clients/:id/stage  { stage, note? }
// Moves a client through: In discussion → Proposal Sent →
// Awaiting Client Decision → Agreement Sent → Won / Lost.
// Any note left with the change is kept as part of that stage's
// history entry (not just the client's general notes field).
// ═══════════════════════════════════════════════════════════════

export const updateClientStage = async (req: AuthRequest, res: Response) => {
  try {
    const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
    if (!ok)
      return res.status(403).json({ success: false, message: "Access denied" });

    const { stage, note } = req.body as { stage: SalesStage; note?: string };
    if (!SALES_STAGES.includes(stage))
      return res.status(400).json({
        success: false,
        message: `Stage must be one of: ${SALES_STAGES.join(", ")}`,
      });

    const client = await ClientModel.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false });

    const justWon = stage === "won" && client.salesStage !== "won";
    client.isSalesLead = true;
    client.salesStage = stage;
    if (justWon) client.wonAt = new Date();
    client.salesStageHistory.push({
      stage,
      note: note?.trim() || undefined,
      changedBy: new mongoose.Types.ObjectId(req.user!.userId),
      changedAt: new Date(),
    });

    await client.save();

    // A won lead moves to the CEO, who allocates an accountant to serve it.
    if (justWon && !client.allocatedAccountant) {
      try {
        const [ceos, actor] = await Promise.all([
          User.find({ role: "ceo", isActive: true }).select("_id").lean(),
          User.findById(req.user!.userId).select("name").lean(),
        ]);
        await Promise.all(
          ceos
            .filter((u) => String(u._id) !== req.user!.userId)
            .map((u) =>
              createNotification(
                String(u._id),
                `${client.name} was won${actor?.name ? ` by ${actor.name}` : ""} — allocate an accountant to serve them`,
                "client_won",
                { clientId: String(client._id) },
              ),
            ),
        );
      } catch (err) {
        console.error("❌ client_won notify failed:", err);
      }
    }

    const populated = await client.populate([
      { path: "assignedTo", select: "name email role profilePicture" },
      { path: "allocatedAccountant", select: "name email" },
      { path: "createdBy", select: "name" },
      { path: "salesStageHistory.changedBy", select: "name role" },
    ]);

    res.json({ success: true, data: { client: populated } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// ═══════════════════════════════════════════════════════════════
// EMAIL CHANNEL
// ═══════════════════════════════════════════════════════════════

// GET /clients/:id/emails  — paginated thread visible to CEO, supervisors, and assigned user
export const getClientEmails = async (req: AuthRequest, res: Response) => {
  try {
    const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
    if (!ok)
      return res.status(403).json({ success: false, message: "Access denied" });

    const { page = "1", limit = "30" } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);

    const [emails, total] = await Promise.all([
      ClientEmailModel.find({ clientId: req.params.id })
        .populate("authorId", "name role email profilePicture")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      ClientEmailModel.countDocuments({ clientId: req.params.id }),
    ]);

    res.json({
      success: true,
      data: {
        emails: emails.map((e) => ({
          ...e,
          attachments: withSignedAttachmentUrls(e.attachments),
        })),
      },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// POST /clients/:id/emails/send  — send outbound email to client
// Body: { subject, body } + optional multipart file(s) under any field
// name (see middleware/upload.ts uploadToLocal.any()).
// Uses emailService to actually deliver it to the client's email address,
// with any uploaded files attached to the real outgoing SMTP message.
export const sendClientEmail = async (req: AuthRequest, res: Response) => {
  try {
    const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
    if (!ok)
      return res.status(403).json({ success: false, message: "Access denied" });

    const client = await ClientModel.findById(req.params.id).select(
      "email name",
    );
    if (!client) return res.status(404).json({ success: false });
    if (!client.email)
      return res
        .status(400)
        .json({ success: false, message: "Client has no email address" });

    const { subject, body } = req.body as { subject: string; body: string };
    if (!subject?.trim())
      return res
        .status(400)
        .json({ success: false, message: "Subject is required" });
    if (!body?.trim())
      return res
        .status(400)
        .json({ success: false, message: "Body is required" });

    const uploadedFiles =
      (req.files as Express.Multer.File[] | undefined) ?? [];
    const attachments: IClientEmailAttachment[] = uploadedFiles.map((f) => ({
      filename: f.originalname,
      fileKey: f.filename,
      size: f.size,
      mimeType: f.mimetype,
    }));

    // Store in DB first (so it shows immediately even if email delivery lags)
    const record = await ClientEmailModel.create({
      clientId: req.params.id,
      authorId: req.user!.userId,
      direction: "outbound",
      subject: subject.trim(),
      body: body.trim(),
      toEmail: client.email,
      attachments,
      status: "sent",
      sentAt: new Date(),
    });

    // Actually send via emailService (non-blocking — fire and forget with error catch)
    const sender = await User.findById(req.user!.userId).select("name email");
    try {
      await sendDirectUserEmail({
        toEmail: client.email,
        subject: subject.trim(),
        body: body.trim(),
        fromName: sender?.name ?? "Account Manager",
        fromEmail: sender?.email,
        attachments: uploadedFiles.map((f) => ({
          filename: f.originalname,
          // memoryStorage (Vercel) has no f.path — send the buffer
          content: f.buffer,
          contentType: f.mimetype,
        })),
      });
    } catch (mailErr) {
      console.error("Client email delivery failed (record saved):", mailErr);
      // Reflect the real delivery outcome so the supervisor/CEO viewing
      // this thread aren't shown "sent" for an email the client never got.
      record.status = "failed";
      await record.save();
    }

    const populated = await record.populate(
      "authorId",
      "name role email profilePicture",
    );
    const emailObj = populated.toObject();
    res.status(201).json({
      success: true,
      data: {
        email: {
          ...emailObj,
          attachments: withSignedAttachmentUrls(emailObj.attachments),
        },
      },
    });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// Manual inbound-logging was removed — received emails are now captured
// exclusively through Zoho sync (see services/emailSyncService.ts). This
// keeps ClientEmail records with direction "inbound" trustworthy as
// actually-received mail, rather than a mix of real and self-reported ones.

// DELETE /clients/:id/emails/:emailId
export const deleteClientEmail = async (req: AuthRequest, res: Response) => {
  try {
    const record = await ClientEmailModel.findById(req.params.emailId);
    if (!record) return res.status(404).json({ success: false });
    const isAuthor = record.authorId.toString() === req.user!.userId;
    if (!isAuthor && !isCEO(req))
      return res.status(403).json({ success: false });
    await record.deleteOne();
    res.json({ success: true });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// ═══════════════════════════════════════════════════════════════
// LINKED WORKING DOCUMENTS
// CEO sees all working docs from every assigned employee.
// Supervisor sees docs from their subordinates assigned to this client.
// User sees only their own.
// ═══════════════════════════════════════════════════════════════

export const getClientDocuments = async (req: AuthRequest, res: Response) => {
  try {
    const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
    if (!ok)
      return res.status(403).json({ success: false, message: "Access denied" });

    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);

    // Documents uploaded against this client (POST /documents with
    // clientId). Everyone with access to the client sees the same list.
    const filter = {
      clientId: new mongoose.Types.ObjectId(req.params.id),
      isDeleted: { $ne: true },
    };
    const [documents, total] = await Promise.all([
      DocumentModel.find(filter)
        .populate("ownerId", "name email role")
        .select(
          "title fileType fileName fileSize documentType createdAt description folderId ownerId",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      DocumentModel.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { documents },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

// GET /clients/employees  — list of assignable employees (CEO only)
export const getAssignableEmployees = async (
  req: AuthRequest,
  res: Response,
) => {
  if (!isCEO(req)) return res.status(403).json({ success: false });
  try {
    const employees = await User.find({
      role: { $in: ["supervisor", "sales_person", "accountant"] },
      isActive: true,
    })
      .select("_id name email role profilePicture department")
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: { employees } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};