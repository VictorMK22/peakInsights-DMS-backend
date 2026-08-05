import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { canAccess } from "./clientController";
import { ClientNoteModel } from "../models/ClientNote";
import { ClientMeetingModel } from "../models/ClientMeeting";
import { MeetingModel } from "../models/Meeting";
import { getClientMeetingActivity } from "../services/meetingActivityService";
import { ClientCallModel } from "../models/ClientCall";
import {
  ClientInvoiceModel,
  ClientInvoiceStatus,
} from "../models/ClientInvoice";
import { TaskModel } from "../models/Task";
import { getLocalFileUrl } from "../middleware/upload";

const authorized = async (req: AuthRequest) =>
  canAccess(req.params.id, req.user!.userId, req.user!.role);

// ═══════════════════════════════════════════════════════════════
// NOTES — simple running log, separate from sales-stage notes
// ═══════════════════════════════════════════════════════════════

export const getClientNotes = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const notes = await ClientNoteModel.find({ clientId: req.params.id })
    .populate("authorId", "name role profilePicture")
    .sort({ createdAt: -1 })
    .lean();
  return res.json({ success: true, data: { notes } });
};

export const createClientNote = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const { body } = req.body as { body: string };
  if (!body?.trim())
    return res
      .status(400)
      .json({ success: false, message: "Note body is required" });
  const note = await ClientNoteModel.create({
    clientId: req.params.id,
    authorId: req.user!.userId,
    body: body.trim(),
  });
  const populated = await note.populate("authorId", "name role profilePicture");
  return res.status(201).json({ success: true, data: { note: populated } });
};

export const deleteClientNote = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  await ClientNoteModel.findOneAndDelete({
    _id: req.params.noteId,
    clientId: req.params.id,
  });
  return res.json({ success: true });
};

// ═══════════════════════════════════════════════════════════════
// MEETINGS
//
// Two sources, on purpose:
//   - ClientMeetingModel: a manual log, for meetings that happened
//     off-system (a hallway chat, a meeting booked elsewhere) that
//     someone wants a record of after the fact.
//   - MeetingModel (below, getClientScheduledMeetings): every meeting
//     actually scheduled through the Meeting & Calendar module with
//     this client attached — populated automatically, live status/
//     RSVPs, zero manual entry. This is the primary path; the manual
//     log is the fallback for things that never went through the
//     calendar at all.
// ═══════════════════════════════════════════════════════════════

export const getClientMeetings = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const meetings = await ClientMeetingModel.find({ clientId: req.params.id })
    .populate("authorId", "name role profilePicture")
    .sort({ scheduledAt: -1 })
    .lean();
  return res.json({ success: true, data: { meetings } });
};

/**
 * Meetings auto-synced from the Meeting & Calendar module for this
 * client — no manual entry involved. This is what a client's
 * "activity timeline" for meetings should actually show.
 */
export const getClientScheduledMeetings = async (
  req: AuthRequest,
  res: Response,
) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const meetings = await MeetingModel.find({ clientId: req.params.id })
    .populate("organizer", "name email role")
    .populate("attendees.userId", "name email role")
    .sort({ startTime: -1 })
    .lean();
  return res.json({ success: true, data: { meetings } });
};

/**
 * The automatic activity trail (created / invited / accepted /
 * declined / rescheduled / cancelled / completed) for every meeting
 * tied to this client — this is what makes the timeline "automatic"
 * rather than something someone has to write up.
 */
export const getClientMeetingActivityFeed = async (
  req: AuthRequest,
  res: Response,
) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const activity = await getClientMeetingActivity(req.params.id);
  return res.json({ success: true, data: { activity } });
};

export const createClientMeeting = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const { title, scheduledAt, attendees, location, outcome, notes } =
    req.body as {
      title: string;
      scheduledAt: string;
      attendees?: string[] | string;
      location?: string;
      outcome?: string;
      notes?: string;
    };
  if (!title?.trim() || !scheduledAt)
    return res
      .status(400)
      .json({ success: false, message: "Title and date/time are required" });
  const meeting = await ClientMeetingModel.create({
    clientId: req.params.id,
    authorId: req.user!.userId,
    title: title.trim(),
    scheduledAt: new Date(scheduledAt),
    attendees: Array.isArray(attendees)
      ? attendees
      : attendees
        ? String(attendees)
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        : [],
    location,
    outcome,
    notes,
  });
  const populated = await meeting.populate(
    "authorId",
    "name role profilePicture",
  );
  return res.status(201).json({ success: true, data: { meeting: populated } });
};

export const updateClientMeeting = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const meeting = await ClientMeetingModel.findOneAndUpdate(
    { _id: req.params.meetingId, clientId: req.params.id },
    { $set: req.body },
    { new: true, runValidators: true },
  ).populate("authorId", "name role profilePicture");
  if (!meeting) return res.status(404).json({ success: false });
  return res.json({ success: true, data: { meeting } });
};

export const deleteClientMeeting = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  await ClientMeetingModel.findOneAndDelete({
    _id: req.params.meetingId,
    clientId: req.params.id,
  });
  return res.json({ success: true });
};

// ═══════════════════════════════════════════════════════════════
// CALLS
// ═══════════════════════════════════════════════════════════════

export const getClientCalls = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const calls = await ClientCallModel.find({ clientId: req.params.id })
    .populate("authorId", "name role profilePicture")
    .sort({ calledAt: -1 })
    .lean();
  return res.json({ success: true, data: { calls } });
};

export const createClientCall = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const { direction, calledAt, durationMinutes, summary } = req.body as {
    direction: "outbound" | "inbound";
    calledAt: string;
    durationMinutes?: number;
    summary: string;
  };
  if (!direction || !calledAt || !summary?.trim())
    return res.status(400).json({
      success: false,
      message: "Direction, date/time, and summary are required",
    });
  const call = await ClientCallModel.create({
    clientId: req.params.id,
    authorId: req.user!.userId,
    direction,
    calledAt: new Date(calledAt),
    durationMinutes,
    summary: summary.trim(),
  });
  const populated = await call.populate("authorId", "name role profilePicture");
  return res.status(201).json({ success: true, data: { call: populated } });
};

export const deleteClientCall = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  await ClientCallModel.findOneAndDelete({
    _id: req.params.callId,
    clientId: req.params.id,
  });
  return res.json({ success: true });
};

// ═══════════════════════════════════════════════════════════════
// INVOICES — a lightweight reference record (amount/status/optional
// file), not a substitute for PeakBooks' real accounting.
// ═══════════════════════════════════════════════════════════════

const withInvoiceFileUrl = (invoice: any) =>
  invoice?.file?.fileKey
    ? {
        ...invoice,
        file: { ...invoice.file, url: getLocalFileUrl(invoice.file.fileKey) },
      }
    : invoice;

export const getClientInvoices = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const invoices = await ClientInvoiceModel.find({ clientId: req.params.id })
    .populate("authorId", "name role")
    .sort({ issuedAt: -1 })
    .lean();
  return res.json({
    success: true,
    data: { invoices: invoices.map(withInvoiceFileUrl) },
  });
};

export const createClientInvoice = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const { invoiceNumber, amount, currency, status, issuedAt, dueDate, notes } =
    req.body as {
      invoiceNumber?: string;
      amount: string | number;
      currency?: string;
      status?: ClientInvoiceStatus;
      issuedAt?: string;
      dueDate?: string;
      notes?: string;
    };
  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0)
    return res
      .status(400)
      .json({ success: false, message: "A valid amount is required" });

  const uploadedFile = (req.files as Express.Multer.File[] | undefined)?.[0];

  const invoice = await ClientInvoiceModel.create({
    clientId: req.params.id,
    authorId: req.user!.userId,
    invoiceNumber,
    amount: numericAmount,
    currency: currency || "USD",
    status: status || "unpaid",
    issuedAt: issuedAt ? new Date(issuedAt) : new Date(),
    dueDate: dueDate ? new Date(dueDate) : undefined,
    notes,
    file: uploadedFile
      ? {
          filename: uploadedFile.originalname,
          fileKey: uploadedFile.filename,
          size: uploadedFile.size,
          mimeType: uploadedFile.mimetype,
        }
      : undefined,
  });
  const populated = await invoice.populate("authorId", "name role");
  return res.status(201).json({
    success: true,
    data: { invoice: withInvoiceFileUrl(populated.toObject()) },
  });
};

export const updateClientInvoice = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const { status, paidAt, notes, dueDate } = req.body as {
    status?: ClientInvoiceStatus;
    paidAt?: string;
    notes?: string;
    dueDate?: string;
  };
  const update: Record<string, unknown> = {};
  if (status) update.status = status;
  if (status === "paid" && !paidAt) update.paidAt = new Date();
  if (paidAt) update.paidAt = new Date(paidAt);
  if (notes !== undefined) update.notes = notes;
  if (dueDate) update.dueDate = new Date(dueDate);

  const invoice = await ClientInvoiceModel.findOneAndUpdate(
    { _id: req.params.invoiceId, clientId: req.params.id },
    { $set: update },
    { new: true, runValidators: true },
  )
    .populate("authorId", "name role")
    .lean();
  if (!invoice) return res.status(404).json({ success: false });
  return res.json({
    success: true,
    data: { invoice: withInvoiceFileUrl(invoice) },
  });
};

export const deleteClientInvoice = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  await ClientInvoiceModel.findOneAndDelete({
    _id: req.params.invoiceId,
    clientId: req.params.id,
  });
  return res.json({ success: true });
};

// ═══════════════════════════════════════════════════════════════
// TASKS — proxies the existing Task system, filtered to this client.
// Creating/updating tasks still goes through the normal /tasks
// endpoints (with clientId in the body); this just lists them here.
// ═══════════════════════════════════════════════════════════════

export const getClientTasks = async (req: AuthRequest, res: Response) => {
  if (!(await authorized(req)))
    return res.status(403).json({ success: false, message: "Access denied" });
  const tasks = await TaskModel.find({
    clientId: new mongoose.Types.ObjectId(req.params.id),
  })
    .populate("assignedBy", "name role")
    .populate("assignedTo", "name role")
    .sort({ createdAt: -1 })
    .lean();
  return res.json({ success: true, data: { tasks } });
};
