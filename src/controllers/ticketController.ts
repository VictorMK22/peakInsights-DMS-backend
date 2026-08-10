import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { Ticket, SLA_HOURS, TicketPriority } from "../models/Ticket";
import { enrichAttachments } from "./attachmentController";

const nextTicketNumber = async (): Promise<string> => {
  const last = await Ticket.findOne()
    .sort({ createdAt: -1 })
    .select("ticketNumber");
  const lastNum = last
    ? parseInt(last.ticketNumber.replace("TCK-", ""), 10)
    : 3000;
  return `TCK-${lastNum + 1}`;
};

export const listTickets = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Auto-escalation: anything still open/in_progress past its SLA
    // becomes escalated the moment anyone looks at the queue, rather
    // than needing a human to notice or a cron job to exist. A
    // dedicated periodic job (see scripts/ict-sla-check.ts) covers the
    // case where nobody opens the Help Desk before the SLA lapses.
    await Ticket.updateMany(
      {
        status: { $in: ["open", "in_progress"] },
        slaDueAt: { $lt: new Date() },
      },
      { $set: { status: "escalated" } },
    );

    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = req.query.status;
    const tickets = await Ticket.find(filter)
      .populate("requester", "name email department")
      .populate("assignee", "name email")
      .sort({ createdAt: -1 });

    const withSla = tickets.map((t) => {
      const obj = t.toObject();
      const slaHoursLeft =
        t.status === "resolved" || t.status === "closed"
          ? null
          : Math.round(((t.slaDueAt.getTime() - Date.now()) / 3600000) * 10) /
            10;
      const resolutionTimeHrs = t.resolvedAt
        ? Math.round(
            ((t.resolvedAt.getTime() - t.createdAt.getTime()) / 3600000) * 10,
          ) / 10
        : undefined;
      return { ...enrichAttachments(obj), slaHoursLeft, resolutionTimeHrs };
    });

    res.json({
      success: true,
      message: "Tickets retrieved",
      data: { tickets: withSla },
    });
  } catch (err) {
    next(err);
  }
};

export const createTicket = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { subject, description, department, category, priority, requester } =
      req.body as {
        subject: string;
        description?: string;
        department?: string;
        category?: string;
        priority?: TicketPriority;
        requester?: string;
      };
    if (!subject?.trim()) {
      res.status(400).json({ success: false, message: "Subject is required" });
      return;
    }
    const finalPriority = priority ?? "medium";
    const slaDueAt = new Date(Date.now() + SLA_HOURS[finalPriority] * 3600000);
    const ticket = await Ticket.create({
      ticketNumber: await nextTicketNumber(),
      subject: subject.trim(),
      description,
      department,
      category,
      priority: finalPriority,
      requester: requester ?? req.user!.userId,
      slaDueAt,
    });
    res
      .status(201)
      .json({ success: true, message: "Ticket created", data: { ticket } });
  } catch (err) {
    next(err);
  }
};

export const updateTicket = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const updates: Record<string, unknown> = { ...req.body };
    if (updates.status === "resolved" || updates.status === "closed") {
      updates.resolvedAt = new Date();
    }
    const ticket = await Ticket.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    if (!ticket) {
      res.status(404).json({ success: false, message: "Ticket not found" });
      return;
    }
    res.json({ success: true, message: "Ticket updated", data: { ticket } });
  } catch (err) {
    next(err);
  }
};

export const addTicketNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { note } = req.body as { note: string };
    if (!note?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Note text is required" });
      return;
    }
    const ticket = await Ticket.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          internalNotes: {
            note: note.trim(),
            by: req.user!.userId,
            at: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!ticket) {
      res.status(404).json({ success: false, message: "Ticket not found" });
      return;
    }
    res.json({ success: true, message: "Note added", data: { ticket } });
  } catch (err) {
    next(err);
  }
};
