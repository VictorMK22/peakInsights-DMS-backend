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
import { getAccountantSupervisorIds } from "../utils/accountantSupervisors";
import mongoose from "mongoose";
import * as XLSX from "xlsx";

// ── helpers ───────────────────────────────────────────────────────

const isCEO = (r: AuthRequest) =>
  r.user!.role === "ceo" || r.user!.role === "tech";
const isSalesPerson = (r: AuthRequest) => r.user!.role === "sales_person";

/**
 * True when this request adds a PROSPECT — a lead that enters the sales
 * pipeline and goes through the stages before it is won:
 *   - a sales person always adds prospects;
 *   - the CEO adds a prospect only from the Sales workspace (`asLead: true`).
 * Anything else the CEO adds is an EXISTING client — one that was already
 * won before this system — so it skips the pipeline entirely.
 * (`asLead` arrives as a boolean in JSON and as "true" in the multipart import.)
 */
const addsProspect = (r: AuthRequest) =>
  isSalesPerson(r) ||
  (isCEO(r) && (r.body?.asLead === true || r.body?.asLead === "true"));

/**
 * Who may serve an existing / won client: an accountant or an accountant
 * supervisor (the CEO is also allowed, but that check needs the caller's id,
 * so each caller handles "self" itself).
 */
const canServeClient = (
  role: string,
  id: string,
  accountantSupervisorIds: Set<string>,
) => role === "accountant" || accountantSupervisorIds.has(id);

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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when ANY client (whoever owns it) already has this email, or the same
 * name + company. Used to stop a sales person re-adding a client the CEO or
 * another rep already has — the caller must not reveal who owns the match.
 */
const clientAlreadyExists = async (
  name: string,
  company?: string,
  email?: string,
): Promise<boolean> => {
  const or: Record<string, unknown>[] = [];
  if (email?.trim()) or.push({ email: email.trim().toLowerCase() });
  or.push({
    name: new RegExp(`^${escapeRegex(name.trim())}$`, "i"),
    company: company?.trim()
      ? new RegExp(`^${escapeRegex(company.trim())}$`, "i")
      : { $in: [null, ""] },
  });
  return !!(await ClientModel.exists({ $or: or }));
};

// ═══════════════════════════════════════════════════════════════
// CLIENTS CRUD
// ═══════════════════════════════════════════════════════════════

export const createClient = async (req: AuthRequest, res: Response) => {
  // Two kinds of client can be added here (see addsProspect):
  //   - PROSPECTS — sales persons' leads, and the CEO's own leads from the
  //     Sales workspace (asLead: true). They enter the pipeline at "In
  //     Discussion" and are auto-assigned to whoever added them.
  //   - EXISTING clients — added by the CEO for clients won before this system
  //     existed. They skip the pipeline.
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

    const salesPersonCreating = addsProspect(req);
    if (
      salesPersonCreating &&
      (await clientAlreadyExists(name, company, email))
    )
      return res.status(409).json({
        success: false,
        message:
          "A client with these details already exists. Ask the CEO if you need access to them.",
      });
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

// ═══════════════════════════════════════════════════════════════
// BULK IMPORT  POST /clients/import  (multipart, field "file")
// Accepts .xlsx / .xls / .csv. Every valid row becomes a client using
// exactly the same rules as createClient (sales persons' rows enter the
// pipeline as "in_discussion" and are auto-assigned to them).
// ═══════════════════════════════════════════════════════════════

const IMPORT_MAX_ROWS = 1000;

// Header → field. Headers are normalised (lowercase, letters/digits only)
// so "Client Name", "client_name" and "CLIENT NAME" all match.
const IMPORT_HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "clientname", "contactname", "fullname", "client", "contact"],
  email: ["email", "emailaddress", "mail"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "tel", "telephone"],
  company: ["company", "companyname", "organization", "organisation"],
  industry: ["industry", "sector"],
  address: ["address", "location"],
  notes: ["notes", "note", "comments", "remarks"],
};

const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const downloadClientImportTemplate = async (
  _req: AuthRequest,
  res: Response,
) => {
  try {
    const rows = [
      {
        Name: "Jane Wanjiku",
        Email: "jane@acme.co.ke",
        Phone: "+254 700 000 000",
        Company: "Acme Ltd.",
        Industry: "Finance",
        Address: "123 Main Street, Nairobi",
        Notes: "Referred by an existing client",
      },
    ];
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [28, 28, 20, 24, 20, 34, 40].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Clients");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="client-import-template.xlsx"',
    );
    res.send(buf);
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};

export const importClients = async (req: AuthRequest, res: Response) => {
  if (!isCEO(req) && !isSalesPerson(req))
    return res.status(403).json({
      success: false,
      message: "Only CEO or a sales person can create clients",
    });
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file)
      return res
        .status(400)
        .json({ success: false, message: "Please choose an Excel or CSV file" });

    let records: Record<string, unknown>[];
    try {
      const wb = XLSX.read(file.buffer, { type: "buffer" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error("empty");
      // raw:false → cells come back as the text Excel displays, so phone
      // numbers keep their leading zeros / "+" and dates stay readable.
      records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
        raw: false,
      });
    } catch {
      return res.status(400).json({
        success: false,
        message: "Could not read that file. Upload a valid .xlsx, .xls or .csv",
      });
    }

    if (records.length === 0)
      return res
        .status(400)
        .json({ success: false, message: "The file has no data rows" });
    if (records.length > IMPORT_MAX_ROWS)
      return res.status(400).json({
        success: false,
        message: `Too many rows (${records.length}). Maximum is ${IMPORT_MAX_ROWS} per upload`,
      });

    // Map the sheet's actual headers onto our fields.
    const headerToField: Record<string, string> = {};
    Object.keys(records[0]).forEach((h) => {
      const n = normaliseHeader(h);
      for (const [field, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
        if (aliases.includes(n) && !Object.values(headerToField).includes(field)) {
          headerToField[h] = field;
          break;
        }
      }
    });
    if (!Object.values(headerToField).includes("name"))
      return res.status(400).json({
        success: false,
        message:
          'No "Name" column found. Download the template to see the expected columns',
      });

    const str = (v: unknown) => (v == null ? "" : String(v).trim());

    // Existing clients, for duplicate detection. Everyone is compared against
    // ALL clients, so a sales person can't re-add a client the CEO (or another
    // rep) already has. The skip reason stays generic on purpose — it must not
    // reveal who owns the existing record.
    const existing = await ClientModel.find({})
      .select("name company email")
      .lean();
    const keyOf = (name: string, company: string, email: string) =>
      email
        ? `e:${email.toLowerCase()}`
        : `n:${name.toLowerCase()}|${company.toLowerCase()}`;
    const seen = new Set(
      existing.map((c) => keyOf(c.name ?? "", c.company ?? "", c.email ?? "")),
    );

    const salesPersonCreating = addsProspect(req);
    const now = new Date();
    const docs: Record<string, unknown>[] = [];
    const skipped: { row: number; name: string; reason: string }[] = [];

    records.forEach((rec, i) => {
      const row = i + 2; // +1 for the header row, +1 for 1-based numbering
      const v: Record<string, string> = {};
      for (const [h, field] of Object.entries(headerToField))
        v[field] = str(rec[h]);

      // Skip fully blank rows silently
      if (Object.values(v).every((x) => !x)) return;

      if (!v.name) {
        skipped.push({ row, name: "", reason: "Name is missing" });
        return;
      }
      if (v.email && !EMAIL_RE.test(v.email)) {
        skipped.push({ row, name: v.name, reason: `Invalid email "${v.email}"` });
        return;
      }
      const key = keyOf(v.name, v.company ?? "", v.email ?? "");
      if (seen.has(key)) {
        skipped.push({
          row,
          name: v.name,
          reason: "Duplicate (already exists or repeated in file)",
        });
        return;
      }
      seen.add(key);

      docs.push({
        name: v.name,
        email: v.email || undefined,
        phone: v.phone || undefined,
        company: v.company || undefined,
        industry: v.industry || undefined,
        address: v.address || undefined,
        notes: v.notes || undefined,
        createdBy: req.user!.userId,
        assignedTo: salesPersonCreating ? [req.user!.userId] : [],
        assignedAt: salesPersonCreating ? now : undefined,
        isSalesLead: salesPersonCreating,
        salesStage: salesPersonCreating ? "in_discussion" : undefined,
        salesStageHistory: salesPersonCreating
          ? [
              {
                stage: "in_discussion",
                changedBy: req.user!.userId,
                changedAt: now,
              },
            ]
          : [],
      });
    });

    if (docs.length > 0) await ClientModel.insertMany(docs);

    res.status(201).json({
      success: true,
      data: { imported: docs.length, skipped },
    });
    return;
  } catch (err) {
    res.status(500).json({ success: false, message: "Import failed" });
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
      tab,
      mine,
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

    // GET /clients?mine=true — only clients assigned to the caller. Lets the
    // CEO, working in the Sales or Accountant workspace, see just their own
    // book instead of every client in the company.
    if (mine === "true") filter.assignedTo = uid;

    // Sales pipeline filters — e.g. GET /clients?salesOnly=true&salesStage=won
    if (salesOnly === "true") filter.isSalesLead = true;
    if (salesStage) filter.salesStage = salesStage;

    const and: Record<string, unknown>[] = [];
    // GET /clients?tab=prospects|won — the CEO's two client lists:
    //   prospects → leads still in the pipeline (any stage but won, lost included)
    //   won       → won clients plus existing clients added before the pipeline
    if (tab === "prospects")
      and.push({ isSalesLead: true, salesStage: { $ne: "won" } });
    else if (tab === "won")
      and.push({ $or: [{ isSalesLead: { $ne: true } }, { salesStage: "won" }] });
    if (search)
      and.push({
        $or: [
          { name: { $regex: search, $options: "i" } },
          { company: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ],
      });
    if (and.length) filter.$and = and;

    const [clients, total] = await Promise.all([
      ClientModel.find(filter)
        .populate("assignedTo", "name email role profilePicture")
        .populate("allocatedAccountant", "name email")
        .populate("createdBy", "name role")
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

// Only the CEO may delete a client. Sales persons (and everyone else) are
// denied, including for leads they added themselves.
export const deleteClient = async (req: AuthRequest, res: Response) => {
  if (!isCEO(req))
    return res.status(403).json({
      success: false,
      message: "Only the CEO can delete clients",
    });
  try {
    const client = await ClientModel.findById(req.params.id).select(
      "createdBy salesStage",
    );
    if (!client)
      return res
        .status(404)
        .json({ success: false, message: "Client not found" });

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
    if (userIds.some((id) => !mongoose.Types.ObjectId.isValid(id)))
      return res
        .status(400)
        .json({ success: false, message: "userIds contains an invalid id" });

    const current = await ClientModel.findById(req.params.id).select(
      "assignedTo isSalesLead salesStage",
    );
    if (!current) return res.status(404).json({ success: false });

    // Who may be newly assigned depends on what the client is:
    //   prospect (still in the pipeline)  → sales people
    //   existing / won client             → accountants and accountant
    //                                       supervisors
    // and in both cases the CEO may assign THEMSELF. People already on the
    // client (e.g. the sales person who won it) are kept as they are.
    const prospect = current.isSalesLead && current.salesStage !== "won";
    const already = new Set(current.assignedTo.map((id) => id.toString()));
    const newIds = [...new Set(userIds.map(String))].filter(
      (id) => !already.has(id),
    );
    const found = await User.find({ _id: { $in: newIds } })
      .select("role isActive")
      .lean();
    const supervisorIds = prospect
      ? new Set<string>()
      : await getAccountantSupervisorIds();
    const invalid = newIds.some((id) => {
      const u = found.find((f) => String(f._id) === id);
      if (!u || !u.isActive) return true;
      if (id === req.user!.userId && u.role === "ceo") return false; // self
      return prospect
        ? u.role !== "sales_person"
        : !canServeClient(u.role, id, supervisorIds);
    });
    if (invalid)
      return res.status(400).json({
        success: false,
        message: prospect
          ? "A prospect can only be assigned to sales people (or yourself)"
          : "A client can only be assigned to accountants, accountant supervisors (or yourself)",
      });

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
// BULK ASSIGNMENT  POST /clients/bulk-assign  { clientIds, userIds }
// CEO picks several won / existing clients and puts the chosen accountants
// / accountant supervisors (or themself) on all of them at once.
//
// It only ADDS people: everyone already on a client (including the sales
// person who won it) stays, because the selected clients each have a
// different set of assignees. Use the per-client assign to remove someone.
//
// A won prospect that has no allocated accountant yet also gets the FIRST
// person in `userIds` as its allocated accountant, so it stops showing as
// "Awaiting accountant". One that already has one keeps it.
// ═══════════════════════════════════════════════════════════════

const BULK_ASSIGN_MAX_CLIENTS = 200;

export const bulkAssignClients = async (req: AuthRequest, res: Response) => {
  if (!isCEO(req))
    return res
      .status(403)
      .json({ success: false, message: "Only CEO can assign clients" });
  try {
    const { clientIds, userIds } = req.body as {
      clientIds?: unknown;
      userIds?: unknown;
    };
    if (!Array.isArray(clientIds) || clientIds.length === 0)
      return res
        .status(400)
        .json({ success: false, message: "Select at least one client" });
    if (!Array.isArray(userIds) || userIds.length === 0)
      return res.status(400).json({
        success: false,
        message: "Choose at least one person to assign",
      });
    const validId = (id: unknown): id is string =>
      typeof id === "string" && mongoose.Types.ObjectId.isValid(id);
    if (!clientIds.every(validId) || !userIds.every(validId))
      return res
        .status(400)
        .json({ success: false, message: "Contains an invalid id" });

    const uniqueClientIds = [...new Set(clientIds as string[])];
    const uniqueUserIds = [...new Set(userIds as string[])];
    if (uniqueClientIds.length > BULK_ASSIGN_MAX_CLIENTS)
      return res.status(400).json({
        success: false,
        message: `You can assign up to ${BULK_ASSIGN_MAX_CLIENTS} clients at a time`,
      });

    const [clients, people, supervisorIds] = await Promise.all([
      ClientModel.find({ _id: { $in: uniqueClientIds } }).select(
        "name assignedTo isSalesLead salesStage allocatedAccountant",
      ),
      User.find({ _id: { $in: uniqueUserIds } })
        .select("role isActive")
        .lean(),
      getAccountantSupervisorIds(),
    ]);

    if (clients.length !== uniqueClientIds.length)
      return res.status(404).json({
        success: false,
        message: "Some of the selected clients no longer exist",
      });
    if (clients.some((c) => c.isSalesLead && c.salesStage !== "won"))
      return res.status(400).json({
        success: false,
        message:
          "Prospects can't be assigned here — select won or existing clients only",
      });

    const invalidPerson = uniqueUserIds.some((id) => {
      const u = people.find((p) => String(p._id) === id);
      if (!u || !u.isActive) return true;
      if (id === req.user!.userId && u.role === "ceo") return false; // self
      return !canServeClient(u.role, id, supervisorIds);
    });
    if (invalidPerson)
      return res.status(400).json({
        success: false,
        message:
          "Clients can only be assigned to accountants, accountant supervisors (or yourself)",
      });

    const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);
    const now = new Date();
    const primaryId = uniqueUserIds[0];
    const ops: mongoose.AnyBulkWriteOperation<any>[] = [];
    const newlyAssigned = new Map<string, { id: string; name: string }[]>();
    let alreadyAssigned = 0;

    for (const c of clients) {
      const have = new Set(c.assignedTo.map((id) => id.toString()));
      const added = uniqueUserIds.filter((id) => !have.has(id));
      const needsAllocation =
        !!c.isSalesLead && c.salesStage === "won" && !c.allocatedAccountant;
      if (added.length === 0 && !needsAllocation) {
        alreadyAssigned += 1;
        continue;
      }

      const $set: Record<string, unknown> = {};
      if (added.length > 0) $set.assignedAt = now;
      if (needsAllocation) {
        $set.allocatedAccountant = toObjectId(primaryId);
        $set.allocatedAt = now;
        $set.allocatedBy = toObjectId(req.user!.userId);
      }
      ops.push({
        updateOne: {
          filter: { _id: c._id },
          update: {
            $addToSet: { assignedTo: { $each: uniqueUserIds.map(toObjectId) } },
            $set,
          },
        },
      });
      for (const id of added) {
        newlyAssigned.set(id, [
          ...(newlyAssigned.get(id) ?? []),
          { id: String(c._id), name: c.name },
        ]);
      }
    }

    if (ops.length > 0) await ClientModel.bulkWrite(ops);

    // One notification per person (not one per client), so assigning 40
    // clients to an accountant doesn't send 40 pings.
    for (const [userId, assigned] of newlyAssigned) {
      if (userId === req.user!.userId) continue;
      try {
        await createNotification(
          userId,
          assigned.length === 1
            ? `You have been allocated a new client: ${assigned[0].name}`
            : `You have been allocated ${assigned.length} new clients`,
          "client_allocated",
          assigned.length === 1 ? { clientId: assigned[0].id } : undefined,
        );
      } catch (err) {
        console.error("❌ client_allocated notify failed:", err);
      }
    }

    res.json({
      success: true,
      data: { updated: ops.length, alreadyAssigned },
    });
    return;
  } catch (err) {
    console.error("bulkAssignClients error:", err);
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

    const supervisorIds = await getAccountantSupervisorIds();
    const pending = clients.filter(
      (c: any) =>
        !(c.assignedTo ?? []).some(
          (u: any) =>
            u && canServeClient(u.role, String(u._id), supervisorIds),
        ),
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
    // The CEO may keep a won client and serve it personally, so they are a
    // valid choice alongside the accountants.
    const allocatingToSelf =
      !!accountant &&
      accountant.role === "ceo" &&
      accountant._id.toString() === req.user!.userId;
    const supervisorIds =
      accountant && accountant.role === "supervisor"
        ? await getAccountantSupervisorIds()
        : new Set<string>();
    if (
      !accountant ||
      !accountant.isActive ||
      (!canServeClient(accountant.role, String(accountant._id), supervisorIds) &&
        !allocatingToSelf)
    )
      return res.status(400).json({
        success: false,
        message: "Choose an active accountant, accountant supervisor (or yourself)",
      });

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
        if (next !== req.user!.userId)
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

    // Existing clients (won before the pipeline existed) never enter it —
    // only prospects, added through the Sales workspace, have stages.
    if (!client.isSalesLead)
      return res.status(400).json({
        success: false,
        message: "Existing clients are not part of the sales pipeline",
      });

    const justWon = stage === "won" && client.salesStage !== "won";
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
    const [people, supervisorIds] = await Promise.all([
      User.find({
        role: { $in: ["supervisor", "sales_person", "accountant"] },
        isActive: true,
      })
        .select("_id name email role profilePicture department")
        .sort({ name: 1 })
        .lean(),
      getAccountantSupervisorIds(),
    ]);
    // Sales people (for prospects) and accountants are listed as they are.
    // Supervisors are listed ONLY when they supervise accountants — those
    // are the only supervisors a client can be assigned to — and are marked
    // so the UI can offer them next to the accountants.
    const employees = people
      .filter((p) => p.role !== "supervisor" || supervisorIds.has(String(p._id)))
      .map((p) =>
        p.role === "supervisor" ? { ...p, accountantSupervisor: true } : p,
      );
    res.json({ success: true, data: { employees } });
    return;
  } catch (err) {
    res.status(500).json({ success: false });
    return;
  }
};