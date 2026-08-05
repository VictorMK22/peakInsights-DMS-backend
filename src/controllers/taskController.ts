import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { TaskModel, TaskStatus, ITask } from "../models/Task";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { User } from "../models/User";
import { DocumentModel } from "../models/Document";
import { createNotification } from "../services/notificationService";
import { sendTaskCollaborationInviteEmail } from "../services/emailService";
import { getLocalFileUrl } from "../middleware/upload";
import {
  attachSignedUrls,
  attachSignedUrlsToMany,
  idOf,
} from "./documentController";
import mongoose from "mongoose";

// ─── Helpers ─────────────────────────────────────────────────────

const calcTAT = (start: Date, end: Date): number =>
  Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));

const calcEfficiency = (target: number, actual: number): number =>
  actual > 0 ? parseFloat((target / actual).toFixed(4)) : 0;

// Extracts a comparable ID string whether the field is a raw
// ObjectId/string, or has been populated into a full sub-document —
// see documentController's idOf for the full explanation. Reused here
// since populateTaskDetail populates assignedBy/assignedTo/collaborators.userId.
interface TaskAccessShape {
  assignedBy: unknown;
  assignedTo: unknown;
  collaborators: { userId: unknown; status: string }[];
}

const canViewTask = (
  task: TaskAccessShape,
  userId: string,
  role: string,
): boolean =>
  role === "ceo" ||
  role === "tech" ||
  idOf(task.assignedBy) === userId ||
  idOf(task.assignedTo) === userId ||
  task.collaborators.some(
    (c) =>
      idOf(c.userId) === userId &&
      (c.status === "active" || c.status === "pending"),
  );

// An invited collaborator only gains the ability to actually perform
// task operations (start/submit) once they've accepted — status === 'active'.
const isActiveCollaborator = (task: TaskAccessShape, userId: string): boolean =>
  task.collaborators.some(
    (c) => idOf(c.userId) === userId && c.status === "active",
  );

// Shared "full detail" populate shape used by every endpoint that
// returns a single task for display (review docs, approval trail,
// collaborators, etc). Also re-signs file URLs on the populated
// documentId/submissionDocuments — same reasoning as
// documentController's attachSignedUrls: whatever was stored at
// upload time is stale/unsigned and not servable on its own.
const populateTaskDetail = async (taskId: mongoose.Types.ObjectId | string) => {
  const task = await TaskModel.findById(taskId)
    .populate("assignedBy", "name email role")
    .populate("assignedTo", "name email role")
    .populate("collaborators.userId", "name email")
    .populate("documentId", "title fileType versionHistory")
    .populate("submissionDocuments", "title fileType versionHistory createdAt")
    .populate("approvalHistory.by", "name role");

  if (!task) return task;

  const plain = task.toObject() as Record<string, any> & {
    documentId?: { fileKey?: string; fileUrl?: string } | null;
    submissionDocuments?: { fileKey?: string; fileUrl?: string }[];
  };
  if (plain.documentId) plain.documentId = attachSignedUrls(plain.documentId);
  if (plain.submissionDocuments?.length)
    plain.submissionDocuments = attachSignedUrlsToMany(
      plain.submissionDocuments,
    );
  return plain;
};

// ─────────────────────────────────────────────────────────────────
// CREATE TASK
// CEO/Supervisor can upload files when creating the task.
// These files serve as context/brief/requirements for the assignee.
// ─────────────────────────────────────────────────────────────────
export const createTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const role = req.user!.role;
    const actorId = req.user!.userId;

    if (role === "user" || role === "accountant") {
      res
        .status(403)
        .json({ success: false, message: "Users cannot assign tasks" });
      return;
    }

    const {
      assignedTo,
      title,
      description,
      priority,
      dueDate,
      documentId,
      clientId,
    } = req.body as {
      assignedTo: string;
      title: string;
      description?: string;
      priority?: string;
      dueDate?: string;
      documentId?: string;
      clientId?: string;
    };

    if (!assignedTo || !title) {
      res
        .status(400)
        .json({ success: false, message: "assignedTo and title are required" });
      return;
    }

    const targetUser = await User.findById(assignedTo).select("name isActive");
    if (!targetUser?.isActive) {
      res
        .status(404)
        .json({ success: false, message: "Target user not found or inactive" });
      return;
    }

    if (role === "supervisor") {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: actorId,
        subordinateId: assignedTo,
        status: "active",
      });
      if (!mapping) {
        res.status(403).json({
          success: false,
          message: "You can only assign tasks to your own team members",
        });
        return;
      }
    }

    // Build taskFiles from any uploaded files
    const uploadedFiles = (req.files as Express.Multer.File[]) ?? [];
    const taskFiles = uploadedFiles.map((file) => ({
      fileName: file.originalname,
      fileKey: file.filename,
      fileUrl: getLocalFileUrl(file.filename),
      fileSize: file.size,
      fileType: file.mimetype,
      uploadedBy: new mongoose.Types.ObjectId(actorId),
      uploadedAt: new Date(),
    }));

    const task = await TaskModel.create({
      title,
      description,
      assignedBy: new mongoose.Types.ObjectId(actorId),
      assignedTo: new mongoose.Types.ObjectId(assignedTo),
      documentId: documentId
        ? new mongoose.Types.ObjectId(documentId)
        : undefined,
      clientId: clientId ? new mongoose.Types.ObjectId(clientId) : undefined,
      taskFiles,
      submissionDocuments: [],
      priority: priority ?? "medium",
      dueDate: dueDate ? new Date(dueDate) : undefined,
      status: "pending",
      collaborators: [],
      approvalHistory: [],
    });

    const assigner = await User.findById(actorId).select("name").lean();

    await createNotification(
      assignedTo,
      `You have been assigned a new task: "${title}"`,
      "task_assigned",
      {
        taskTitle: title,
        taskDescription: description,
        taskPriority: priority ?? "medium",
        taskDueDate: dueDate,
        taskId: task._id.toString(),
        assignerName: assigner?.name ?? "Your manager",
      },
    );

    const populated = await TaskModel.findById(task._id)
      .populate("assignedBy", "name email role")
      .populate("assignedTo", "name email role")
      .populate("collaborators.userId", "name email")
      .populate("documentId", "title fileType")
      .populate("submissionDocuments", "title fileType createdAt");

    res.status(201).json({
      success: true,
      message: "Task created",
      data: { task: populated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// READ ALL — role-scoped, paginated
// ─────────────────────────────────────────────────────────────────
export const getTasks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const role = req.user!.role;
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const {
      status,
      priority,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};
    if (status) filter["status"] = status;
    if (priority) filter["priority"] = priority;

    if (role === "user" || role === "accountant") {
      filter["$or"] = [
        { assignedTo: userId },
        {
          collaborators: {
            $elemMatch: { userId, status: { $in: ["active", "pending"] } },
          },
        },
      ];
    } else if (role === "supervisor") {
      filter["$or"] = [{ assignedTo: userId }, { assignedBy: userId }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [tasks, total] = await Promise.all([
      TaskModel.find(filter)
        .populate("assignedBy", "name email role")
        .populate("assignedTo", "name email role")
        .populate("collaborators.userId", "name email")
        .populate("documentId", "title fileType")
        .populate("submissionDocuments", "title fileType createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      TaskModel.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { tasks },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// READ ONE — includes all linked documents for review
// ─────────────────────────────────────────────────────────────────
export const getTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const task = await populateTaskDetail(req.params.id);

    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }
    if (
      !canViewTask(
        task as unknown as TaskAccessShape,
        req.user!.userId,
        req.user!.role,
      )
    ) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE METADATA
// ─────────────────────────────────────────────────────────────────
export const updateTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const isAssigner = task.assignedBy.toString() === req.user!.userId;
    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO = req.user!.role === "ceo" || req.user!.role === "tech";

    if (!isAssigner && !isAssignee && !isCEO) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }

    const { title, description, priority, dueDate, notes, targetMinutes } =
      req.body as {
        title?: string;
        description?: string;
        priority?: string;
        dueDate?: string;
        notes?: string;
        targetMinutes?: number;
      };

    if (isAssigner || isCEO) {
      if (title) task.title = title;
      if (description !== undefined) task.description = description;
      if (priority) task.priority = priority as ITask["priority"];
      if (dueDate) task.dueDate = new Date(dueDate);
    }

    if (isAssignee || isCEO) {
      if (notes !== undefined) task.notes = notes;
      if (targetMinutes !== undefined && targetMinutes > 0) {
        if (!["pending", "in_progress"].includes(task.status)) {
          res.status(400).json({
            success: false,
            message: "Cannot change target after completion or cancellation",
          });
          return;
        }
        task.targetMinutes = targetMinutes;
      }
    }

    await task.save();
    res.json({ success: true, message: "Task updated", data: { task } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE STATUS — TAT lifecycle
//
//  pending     → in_progress : assignee commits targetMinutes
//  in_progress → submitted   : assignee attaches supporting documents
//  submitted   → completed   : approver (supervisor/CEO) reviews docs + approves
//  submitted   → rejected    : approver rejects with reason (goes back to in_progress)
//  any         → cancelled   : assigner or CEO only
// ─────────────────────────────────────────────────────────────────
export const updateTaskStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const userId = req.user!.userId;
    const isAssignee = task.assignedTo.toString() === userId;
    const isAssigner = task.assignedBy.toString() === userId;
    const isCEO = req.user!.role === "ceo" || req.user!.role === "tech";
    const isSupervisor = req.user!.role === "supervisor";

    const {
      status,
      targetMinutes,
      notes,
      submissionComment,
      submissionDocumentIds, // array of existing document IDs to attach
      rejectionReason,
    } = req.body as {
      status: TaskStatus;
      targetMinutes?: number;
      notes?: string;
      submissionComment?: string;
      submissionDocumentIds?: string[];
      rejectionReason?: string;
    };

    const validStatuses: TaskStatus[] = [
      "pending",
      "in_progress",
      "submitted",
      "completed",
      "rejected",
      "cancelled",
    ];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, message: "Invalid status" });
      return;
    }

    if (status === "cancelled" && !isAssigner && !isCEO) {
      res.status(403).json({
        success: false,
        message: "Only the task creator or CEO can cancel tasks",
      });
      return;
    }

    if (
      ["in_progress", "submitted"].includes(status) &&
      !isAssignee &&
      !isCEO &&
      !isActiveCollaborator(task, userId)
    ) {
      res.status(403).json({
        success: false,
        message:
          "Only the task assignee or an accepted collaborator can start or submit tasks",
      });
      return;
    }

    if (
      ["completed", "rejected"].includes(status) &&
      !isAssigner &&
      !isCEO &&
      !isSupervisor
    ) {
      res.status(403).json({
        success: false,
        message:
          "Only the task creator, supervisor, or CEO can approve/reject tasks",
      });
      return;
    }

    const now = new Date();

    // ── pending → in_progress ────────────────────────────────────
    if (status === "in_progress" && task.status === "pending") {
      const target = targetMinutes ?? task.targetMinutes;
      if (!target || target < 1) {
        res.status(400).json({
          success: false,
          message:
            "You must set targetMinutes before starting. This is your personal commitment.",
        });
        return;
      }
      task.targetMinutes = target;
      task.startedAt = now;
      task.status = "in_progress";
    }

    // ── in_progress → submitted ───────────────────────────────────
    // Assignee submits for approval and can link supporting documents
    else if (status === "submitted" && task.status === "in_progress") {
      task.status = "submitted";
      task.submittedAt = now;
      if (submissionComment) task.submissionComment = submissionComment;

      // Attach documents the assignee is submitting as proof of work.
      // Validate they exist and actually belong to the assignee so a
      // task can't be marked "submitted" with someone else's documents.
      if (submissionDocumentIds?.length) {
        const validIds = submissionDocumentIds.map(
          (id) => new mongoose.Types.ObjectId(id),
        );
        const ownedDocs = await DocumentModel.find({
          _id: { $in: validIds },
          ownerId: new mongoose.Types.ObjectId(userId),
        }).select("_id");

        if (ownedDocs.length !== validIds.length) {
          res.status(400).json({
            success: false,
            message:
              "One or more submitted documents were not found or are not owned by you",
          });
          return;
        }

        task.submissionDocuments = validIds;
      }

      await createNotification(
        task.assignedBy.toString(),
        `Task "${task.title}" has been submitted for your review`,
        "task_submitted",
      );
    }

    // ── submitted → completed (APPROVAL) ─────────────────────────
    else if (status === "completed" && task.status === "submitted") {
      task.completedAt = now;
      task.status = "completed";

      if (task.startedAt) {
        task.tatMinutes = calcTAT(task.startedAt, now);
        if (task.targetMinutes) {
          task.efficiencyRatio = calcEfficiency(
            task.targetMinutes,
            task.tatMinutes,
          );
        }
      }

      // Revoke any pending/active collaborators — their access (or
      // standing invitation) ends with the task. Leave declined
      // entries alone, they were never granted access in the first place.
      const revokedAt = now;
      task.collaborators = task.collaborators.map((c) =>
        c.status === "pending" || c.status === "active"
          ? { ...c, status: "revoked" as const, revokedAt }
          : c,
      );

      task.approvalHistory.push({
        action: "approved",
        by: new mongoose.Types.ObjectId(userId),
        at: now,
      });

      const assigneeUser = await User.findById(task.assignedTo)
        .select("name")
        .lean();
      await createNotification(
        task.assignedTo.toString(),
        `Task "${task.title}" has been approved and marked complete`,
        "task_completed",
        {
          taskTitle: task.title,
          assigneeName: assigneeUser?.name ?? "The assignee",
          efficiencyRatio: task.efficiencyRatio,
        },
      );
    }

    // ── submitted → rejected ──────────────────────────────────────
    else if (status === "rejected" && task.status === "submitted") {
      if (!rejectionReason) {
        res
          .status(400)
          .json({ success: false, message: "A rejection reason is required" });
        return;
      }
      task.status = "in_progress"; // returns to in_progress so assignee can rework
      task.rejectionReason = rejectionReason;

      task.approvalHistory.push({
        action: "rejected",
        by: new mongoose.Types.ObjectId(userId),
        at: now,
        reason: rejectionReason,
      });

      await createNotification(
        task.assignedTo.toString(),
        `Task "${task.title}" was rejected: ${rejectionReason}`,
        "task_rejected",
      );
    }

    // ── cancellation ─────────────────────────────────────────────
    else if (status === "cancelled") {
      task.status = "cancelled";
      const revokedAt = now;
      task.collaborators = task.collaborators.map((c) =>
        c.status === "pending" || c.status === "active"
          ? { ...c, status: "revoked" as const, revokedAt }
          : c,
      );
    } else if (task.status === status) {
      res
        .status(400)
        .json({ success: false, message: `Task is already ${status}` });
      return;
    } else {
      res.status(400).json({
        success: false,
        message: `Cannot transition from "${task.status}" to "${status}"`,
      });
      return;
    }

    if (notes !== undefined) task.notes = notes;
    await task.save();

    // Return fully populated task so the reviewer can see all linked docs
    const populated = await populateTaskDetail(task._id);

    res.json({
      success: true,
      message: "Task updated",
      data: { task: populated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────
export const deleteTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const isAssigner = task.assignedBy.toString() === req.user!.userId;
    const isCEO = req.user!.role === "ceo" || req.user!.role === "tech";

    if (!isAssigner && !isCEO) {
      res.status(403).json({
        success: false,
        message: "Only the task creator or CEO can delete tasks",
      });
      return;
    }

    await task.deleteOne();
    res.json({ success: true, message: "Task deleted" });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// INVITE COLLABORATOR
// Creates a *pending* invitation — the invitee must explicitly accept
// before they gain any ability to act on the task (see
// respondToTaskCollaboratorInvite below).
// ─────────────────────────────────────────────────────────────────
export const inviteTaskCollaborator = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const { inviteeId } = req.body as { inviteeId: string };

    const task = await TaskModel.findById(id);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO = req.user!.role === "ceo" || req.user!.role === "tech";

    if (!isAssignee && !isCEO) {
      res.status(403).json({
        success: false,
        message: "Only the task assignee or CEO can invite collaborators",
      });
      return;
    }

    if (task.status !== "in_progress") {
      res.status(400).json({
        success: false,
        message: "Collaborators can only be invited to in-progress tasks",
      });
      return;
    }

    if (inviteeId === req.user!.userId) {
      res
        .status(400)
        .json({ success: false, message: "You cannot invite yourself" });
      return;
    }

    if (inviteeId === task.assignedTo.toString()) {
      res.status(400).json({
        success: false,
        message: "The assignee already has full access to this task",
      });
      return;
    }

    const alreadyInvited = task.collaborators.some(
      (c) =>
        c.userId.toString() === inviteeId &&
        (c.status === "active" || c.status === "pending"),
    );
    if (alreadyInvited) {
      res.status(400).json({
        success: false,
        message: "This user already has an active or pending invitation",
      });
      return;
    }

    const invitee = await User.findById(inviteeId).select(
      "name email isActive supervisorId",
    );
    if (!invitee?.isActive) {
      res
        .status(404)
        .json({ success: false, message: "Invitee not found or inactive" });
      return;
    }

    // Collaborators are teammates — restrict invites to people who
    // share a supervisor with the inviter. CEO is exempt (oversees
    // everyone). Supervisors are restricted to their own subordinates
    // via SupervisorMapping (existing rule); regular users are
    // restricted to peers under the same supervisor.
    if (req.user!.role === "supervisor") {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: req.user!.userId,
        subordinateId: inviteeId,
        status: "active",
      });
      if (!mapping) {
        res.status(403).json({
          success: false,
          message: "You can only invite members of your own team",
        });
        return;
      }
    } else if (req.user!.role === "user") {
      const inviter = await User.findById(req.user!.userId).select(
        "supervisorId",
      );
      const sameTeam =
        inviter?.supervisorId &&
        invitee.supervisorId &&
        inviter.supervisorId.toString() === invitee.supervisorId.toString();
      if (!sameTeam) {
        res.status(403).json({
          success: false,
          message: "You can only invite teammates who share your supervisor",
        });
        return;
      }
    }

    const existingIdx = task.collaborators.findIndex(
      (c) => c.userId.toString() === inviteeId,
    );
    if (existingIdx >= 0) {
      // Re-inviting someone who previously declined or was revoked —
      // reset to a fresh pending invitation.
      task.collaborators[existingIdx].status = "pending";
      task.collaborators[existingIdx].invitedAt = new Date();
      task.collaborators[existingIdx].respondedAt = undefined;
      task.collaborators[existingIdx].revokedAt = undefined;
    } else {
      task.collaborators.push({
        userId: new mongoose.Types.ObjectId(inviteeId),
        invitedAt: new Date(),
        status: "pending",
      });
    }

    await task.save();

    const inviter = await User.findById(req.user!.userId)
      .select("name email")
      .lean();
    await createNotification(
      inviteeId,
      `${inviter?.name ?? "A colleague"} invited you to collaborate on task: "${task.title}"`,
      "task_collaboration_invite",
      {
        taskId: task._id.toString(),
        taskTitle: task.title,
        inviterName: inviter?.name ?? "A colleague",
      },
    );

    // Same reasoning as message notifications — email is the only
    // reliable way the invitee actually finds out about this right now.
    if (invitee.email) {
      sendTaskCollaborationInviteEmail(
        invitee.email,
        invitee.name,
        inviter?.name ?? "A colleague",
        task.title,
        inviter?.email,
      ).catch((err) =>
        console.error(
          "❌ sendTaskCollaborationInviteEmail failed (invite still saved):",
          err,
        ),
      );
    }

    res.json({
      success: true,
      message: `${invitee.name} invited — awaiting their response`,
      data: { task: await populateTaskDetail(task._id) },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// RESPOND TO COLLABORATION INVITE (accept / decline)
// Only the invited user themselves can respond to their own invite.
// Accepting flips status to 'active', which is what actually grants
// permission to start/submit the task (see updateTaskStatus above).
// ─────────────────────────────────────────────────────────────────
export const respondToTaskCollaboratorInvite = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const { accept } = req.body as { accept: boolean };

    if (typeof accept !== "boolean") {
      res
        .status(400)
        .json({ success: false, message: '"accept" (boolean) is required' });
      return;
    }

    const task = await TaskModel.findById(id);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const invite = task.collaborators.find(
      (c) => c.userId.toString() === req.user!.userId && c.status === "pending",
    );
    if (!invite) {
      res.status(404).json({
        success: false,
        message: "No pending invitation found for you on this task",
      });
      return;
    }

    invite.status = accept ? "active" : "declined";
    invite.respondedAt = new Date();
    await task.save();

    const responder = await User.findById(req.user!.userId)
      .select("name")
      .lean();
    await createNotification(
      task.assignedTo.toString(),
      `${responder?.name ?? "A teammate"} ${accept ? "accepted" : "declined"} your collaboration invite on task: "${task.title}"`,
      "task_collaboration_response",
      { taskId: task._id.toString(), taskTitle: task.title, accepted: accept },
    );

    const populated = await populateTaskDetail(task._id);

    res.json({
      success: true,
      message: accept
        ? "Invitation accepted — you can now work on this task"
        : "Invitation declined",
      data: { task: populated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// REVOKE COLLABORATOR
// Withdraws access for an active collaborator, or cancels a still-
// pending invitation outright.
// ─────────────────────────────────────────────────────────────────
export const revokeTaskCollaborator = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id, collaboratorId } = req.params as {
      id: string;
      collaboratorId: string;
    };
    const task = await TaskModel.findById(id);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO = req.user!.role === "ceo" || req.user!.role === "tech";

    if (!isAssignee && !isCEO) {
      res.status(403).json({
        success: false,
        message: "Only the task assignee or CEO can revoke collaborator access",
      });
      return;
    }

    const collaborator = task.collaborators.find(
      (c) =>
        c.userId.toString() === collaboratorId &&
        (c.status === "active" || c.status === "pending"),
    );
    if (!collaborator) {
      res.status(404).json({
        success: false,
        message: "Active or pending collaborator not found",
      });
      return;
    }

    collaborator.status = "revoked";
    collaborator.revokedAt = new Date();
    await task.save();

    await createNotification(
      collaboratorId,
      `Your collaboration access on task "${task.title}" has been revoked`,
      "task_collaboration_revoked",
      { taskId: task._id.toString(), taskTitle: task.title },
    );

    res.json({
      success: true,
      message: "Collaborator access revoked",
      data: { task: await populateTaskDetail(task._id) },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────────────────────────
export const getTaskLeaderboard = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { limit = "10" } = req.query as Record<string, string>;
    const matchStage: Record<string, unknown> = {
      status: "completed",
      efficiencyRatio: { $exists: true },
    };

    if (req.user!.role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: req.user!.userId,
        status: "active",
      }).select("subordinateId");
      matchStage["assignedTo"] = { $in: mappings.map((m) => m.subordinateId) };
    } else if (req.user!.role === "user") {
      matchStage["assignedTo"] = new mongoose.Types.ObjectId(req.user!.userId);
    }

    const leaderboard = await TaskModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$assignedTo",
          avgEfficiency: { $avg: "$efficiencyRatio" },
          avgTat: { $avg: "$tatMinutes" },
          completedTasks: { $sum: 1 },
        },
      },
      { $sort: { avgEfficiency: -1 } },
      { $limit: Number(limit) },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      { $project: { "user.password": 0 } },
    ]);

    res.json({ success: true, data: { leaderboard } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// INDIVIDUAL APPRAISAL
// ─────────────────────────────────────────────────────────────────
export const getUserAppraisal = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId } = req.params as { userId: string };

    if (
      (req.user!.role === "user" || req.user!.role === "accountant") &&
      req.user!.userId !== userId
    ) {
      res.status(403).json({
        success: false,
        message: "You can only view your own appraisal",
      });
      return;
    }
    if (req.user!.role === "supervisor") {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: req.user!.userId,
        subordinateId: userId,
        status: "active",
      });
      if (!mapping) {
        res
          .status(403)
          .json({ success: false, message: "Not your team member" });
        return;
      }
    }

    const targetId = new mongoose.Types.ObjectId(userId);

    const [summary, recentTasks] = await Promise.all([
      TaskModel.aggregate([
        { $match: { assignedTo: targetId } },
        {
          $group: {
            _id: null,
            totalTasks: { $sum: 1 },
            completedTasks: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
            cancelledTasks: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
            },
            avgEfficiency: { $avg: "$efficiencyRatio" },
            avgTatMinutes: { $avg: "$tatMinutes" },
            avgTargetMinutes: { $avg: "$targetMinutes" },
            onTimeTasks: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ["$efficiencyRatio", 1] },
                      { $eq: ["$status", "completed"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      TaskModel.find({ assignedTo: targetId, status: "completed" })
        .sort({ completedAt: -1 })
        .limit(10)
        .populate("assignedBy", "name role")
        .populate("documentId", "title"),
    ]);

    const stats = summary[0] ?? {
      totalTasks: 0,
      completedTasks: 0,
      cancelledTasks: 0,
      avgEfficiency: null,
      avgTatMinutes: null,
      avgTargetMinutes: null,
      onTimeTasks: 0,
    };

    res.json({
      success: true,
      data: {
        appraisal: {
          ...stats,
          completionRate:
            stats.totalTasks > 0
              ? `${((stats.completedTasks / stats.totalTasks) * 100).toFixed(1)}%`
              : "0%",
          onTimeRate:
            stats.completedTasks > 0
              ? `${((stats.onTimeTasks / stats.completedTasks) * 100).toFixed(1)}%`
              : "0%",
          avgEfficiency: stats.avgEfficiency
            ? Number(stats.avgEfficiency.toFixed(3))
            : null,
          avgTatMinutes: stats.avgTatMinutes
            ? Math.round(stats.avgTatMinutes)
            : null,
        },
        recentTasks,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// APPROVE TASK  (PATCH /:id/approve)
// Convenience endpoint: CEO or Supervisor can approve a submitted
// task without going through the full updateTaskStatus flow.
// Equivalent to PATCH /:id/status with { status: 'completed' }.
// ─────────────────────────────────────────────────────────────────
export const approveTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    const userId = req.user!.userId;
    const role = req.user!.role;

    if (role !== "ceo" && role !== "tech" && role !== "supervisor") {
      res.status(403).json({
        success: false,
        message: "Only CEO, Tech, or Supervisor can approve tasks",
      });
      return;
    }

    if (task.status !== "submitted") {
      res.status(400).json({
        success: false,
        message: `Cannot approve a task that is "${task.status}" — task must be submitted first`,
      });
      return;
    }

    const now = new Date();
    task.status = "completed";
    task.completedAt = now;

    if (task.startedAt) {
      task.tatMinutes = calcTAT(task.startedAt, now);
      if (task.targetMinutes) {
        task.efficiencyRatio = calcEfficiency(
          task.targetMinutes,
          task.tatMinutes,
        );
      }
    }

    // Revoke any pending/active collaborators — task is done.
    task.collaborators = task.collaborators.map((c) =>
      c.status === "pending" || c.status === "active"
        ? { ...c, status: "revoked" as const, revokedAt: now }
        : c,
    );

    task.approvalHistory.push({
      action: "approved",
      by: new mongoose.Types.ObjectId(userId),
      at: now,
    });

    await task.save();

    const assigneeUser = await User.findById(task.assignedTo)
      .select("name")
      .lean();
    await createNotification(
      task.assignedTo.toString(),
      `Task "${task.title}" has been approved and marked complete`,
      "task_completed",
      {
        taskTitle: task.title,
        assigneeName: assigneeUser?.name ?? "The assignee",
        efficiencyRatio: task.efficiencyRatio,
      },
    );

    const populated = await populateTaskDetail(task._id);

    res.json({
      success: true,
      message: "Task approved and completed",
      data: { task: populated },
    });
  } catch (err) {
    next(err);
  }
};
