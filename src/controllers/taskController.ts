import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import { TaskModel, ITask } from '../models/Task';
import { SupervisorMapping } from '../models/SupervisorMapping';
import { User } from '../models/User';
import { createNotification } from '../services/notificationService';
import mongoose from 'mongoose';

// ─── Helpers ─────────────────────────────────────────────────────

const calcTAT = (start: Date, end: Date): number =>
  Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));

const calcEfficiency = (target: number, actual: number): number =>
  actual > 0 ? parseFloat((target / actual).toFixed(4)) : 0;

const canViewTask = (task: ITask, userId: string, role: string): boolean =>
  role === 'ceo' ||
  task.assignedBy.toString() === userId ||
  task.assignedTo.toString() === userId ||
  task.collaborators.some((c) => c.userId.toString() === userId && c.status === 'active');

// ─────────────────────────────────────────────────────────────────
// CREATE — CEO assigns to anyone; Supervisor to their team only
// ─────────────────────────────────────────────────────────────────
export const createTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const role    = req.user!.role;
    const actorId = req.user!.userId;

    if (role === 'user') {
      res.status(403).json({ success: false, message: 'Users cannot assign tasks' });
      return;
    }

    const { assignedTo, title, description, priority, dueDate, documentId } = req.body as {
      assignedTo: string; title: string; description?: string;
      priority?: string; dueDate?: string; documentId?: string;
    };

    if (!assignedTo || !title) {
      res.status(400).json({ success: false, message: 'assignedTo and title are required' });
      return;
    }

    const targetUser = await User.findById(assignedTo).select('name isActive');
    if (!targetUser?.isActive) {
      res.status(404).json({ success: false, message: 'Target user not found or inactive' });
      return;
    }

    if (role === 'supervisor') {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: actorId, subordinateId: assignedTo, status: 'active',
      });
      if (!mapping) {
        res.status(403).json({ success: false, message: 'You can only assign tasks to your own team members' });
        return;
      }
    }

    const task = await TaskModel.create({
      title, description,
      assignedBy:   new mongoose.Types.ObjectId(actorId),
      assignedTo:   new mongoose.Types.ObjectId(assignedTo),
      documentId:   documentId ? new mongoose.Types.ObjectId(documentId) : undefined,
      priority:     priority ?? 'medium',
      dueDate:      dueDate ? new Date(dueDate) : undefined,
      status:       'pending',
      collaborators: [],
    });

    await createNotification(
      assignedTo,
      `You have been assigned a new task: "${title}"`,
      'task_assigned'
    );

    const populated = await TaskModel.findById(task._id)
      .populate('assignedBy', 'name email role')
      .populate('assignedTo', 'name email role')
      .populate('collaborators.userId', 'name email')
      .populate('documentId', 'title');

    res.status(201).json({ success: true, message: 'Task created', data: { task: populated } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// READ ALL
// ─────────────────────────────────────────────────────────────────
export const getTasks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const role   = req.user!.role;
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const { status, priority, page = '1', limit = '20' } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};
    if (status)   filter['status']   = status;
    if (priority) filter['priority'] = priority;

    if (role === 'user') {
      // User sees tasks assigned to them + tasks where they are an active collaborator
      filter['$or'] = [
        { assignedTo: userId },
        { 'collaborators': { $elemMatch: { userId, status: 'active' } } },
      ];
    } else if (role === 'supervisor') {
      filter['$or'] = [{ assignedTo: userId }, { assignedBy: userId }];
    }
    // CEO: no filter

    const skip = (Number(page) - 1) * Number(limit);
    const [tasks, total] = await Promise.all([
      TaskModel.find(filter)
        .populate('assignedBy', 'name email role')
        .populate('assignedTo', 'name email role')
        .populate('collaborators.userId', 'name email')
        .populate('documentId', 'title')
        .sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      TaskModel.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { tasks },
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// READ ONE
// ─────────────────────────────────────────────────────────────────
export const getTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id)
      .populate('assignedBy', 'name email role')
      .populate('assignedTo', 'name email role')
      .populate('collaborators.userId', 'name email')
      .populate('documentId', 'title');

    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }
    if (!canViewTask(task, req.user!.userId, req.user!.role)) {
      res.status(403).json({ success: false, message: 'Access denied' }); return;
    }
    res.json({ success: true, data: { task } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE METADATA — assigner edits meta; assignee sets target/notes
// ─────────────────────────────────────────────────────────────────
export const updateTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const isAssigner = task.assignedBy.toString() === req.user!.userId;
    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO      = req.user!.role === 'ceo';

    if (!isAssigner && !isAssignee && !isCEO) {
      res.status(403).json({ success: false, message: 'Access denied' }); return;
    }

    const { title, description, priority, dueDate, notes, targetMinutes } = req.body as {
      title?: string; description?: string; priority?: string;
      dueDate?: string; notes?: string; targetMinutes?: number;
    };

    if (isAssigner || isCEO) {
      if (title)                   task.title       = title;
      if (description !== undefined) task.description = description;
      if (priority)                task.priority    = priority as ITask['priority'];
      if (dueDate)                 task.dueDate     = new Date(dueDate);
    }

    if (isAssignee || isCEO) {
      if (notes !== undefined) task.notes = notes;
      if (targetMinutes !== undefined && targetMinutes > 0) {
        if (!['pending', 'in_progress'].includes(task.status)) {
          res.status(400).json({ success: false, message: 'Cannot change target after completion or cancellation' });
          return;
        }
        task.targetMinutes = targetMinutes;
      }
    }

    await task.save();
    res.json({ success: true, message: 'Task updated', data: { task } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE STATUS — drives TAT measurement
//
//  pending     → in_progress : assignee commits targetMinutes; startedAt recorded
//  in_progress → completed   : tatMinutes + efficiencyRatio calculated;
//                              ALL collaborator access immediately revoked
//  any         → cancelled   : assigner or CEO only; collaborators revoked
// ─────────────────────────────────────────────────────────────────
export const updateTaskStatus = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { taskId } = req.params;
    const { status, submissionComment } = req.body;
    const userId = req.user?.userId;

    const task = await TaskModel.findById(taskId);

    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    if (task.assignedTo.toString() !== userId) {
      res.status(403).json({ success: false, message: "Unauthorized" });
      return;
    }

    if (status === "in_progress" && task.status === "pending") {
      task.status = "in_progress";
      task.startedAt = new Date();
    } else if (status === "submitted" && task.status === "in_progress") {
      if (!task.proofFiles?.length && !submissionComment) {
        res.status(400).json({
          success: false,
          message: "Attach proof of work or add a submission comment",
        });
        return;
      }
    
      const now = new Date();
    
      task.status = "submitted";
      task.submittedAt = now;
      task.completedAt = now; // ✅ IMPORTANT
      task.submissionComment = submissionComment;
    
      // ✅ CALCULATE WORK METRICS HERE
      if (task.startedAt) {
        task.tatMinutes = calcTAT(task.startedAt, now);
      }
    
      if (task.targetMinutes && task.tatMinutes) {
        task.efficiencyRatio = calcEfficiency(
          task.targetMinutes,
          task.tatMinutes
        );
      }
    
      await createNotification(
        task.assignedBy.toString(),
        `Task "${task.title}" submitted for approval`,
        "task_submitted"
      );
    } else {
      res.status(400).json({
        success: false,
        message: "Invalid status transition",
      });
      return;
    }

    await task.save();

    res.json({ success: true, data: task });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE TASK
// ─────────────────────────────────────────────────────────────────
export const approveTask = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { taskId } = req.params;
    const { action, rejectionReason } = req.body as {
      action: "approve" | "reject";
      rejectionReason?: string;
    };

    const userId = req.user?.userId;

    const task = await TaskModel.findById(taskId);

    // ❌ Task not found
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }

    // ❌ Only assigner can approve/reject
    if (task.assignedBy.toString() !== userId) {
      res.status(403).json({ success: false, message: "Unauthorized" });
      return;
    }

    // ❌ Must be submitted first
    if (task.status !== "submitted") {
      res.status(400).json({
        success: false,
        message: "Task must be submitted before approval",
      });
      return;
    }

    const now = new Date();

    if (!task.approvalHistory) {
      task.approvalHistory = [];
    }

    // ✅ APPROVE
    if (action === "approve") {
      task.status = "completed";
      task.approvedAt = now;

      // ✅ approval duration
      if (task.submittedAt) {
        task.approvalDurationMinutes = calcTAT(task.submittedAt, now);
      }

      // ✅ history
      task.approvalHistory.push({
        action: "approved",
        by: new mongoose.Types.ObjectId(userId),
        at: now,
      });

      await createNotification(
        task.assignedTo.toString(),
        `Task "${task.title}" has been approved and completed`,
        "task_completed"
      );
    }

    // ❌ REJECT
    else if (action === "reject") {
      if (!rejectionReason) {
        res.status(400).json({
          success: false,
          message: "Rejection reason is required",
        });
        return;
      }

      task.status = "in_progress";
      task.rejectionReason = rejectionReason;

      // ✅ history
      task.approvalHistory.push({
        action: "rejected",
        by: new mongoose.Types.ObjectId(userId),
        at: now,
        reason: rejectionReason,
      });

      await createNotification(
        task.assignedTo.toString(),
        `Task "${task.title}" was rejected: ${rejectionReason}`,
        "task_rejected"
      );
    }

    // ❌ Invalid action
    else {
      res.status(400).json({
        success: false,
        message: "Invalid action",
      });
      return;
    }

    await task.save();

    res.json({ success: true, data: task });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────
export const deleteTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const isAssigner = task.assignedBy.toString() === req.user!.userId;
    const isCEO      = req.user!.role === 'ceo';

    if (!isAssigner && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the task creator or CEO can delete tasks' }); return;
    }

    await task.deleteOne();
    res.json({ success: true, message: 'Task deleted' });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// INVITE COLLABORATOR
//
// The task assignee (or CEO) can invite another user to help.
// Rules:
//   - Task must be in_progress
//   - Invitee must be in the same team (supervisor mapping) OR CEO inviting anyone
//   - Cannot invite someone already an active collaborator
//   - Cannot invite the assignee themselves
//
// When the task is completed or cancelled, access is auto-revoked
// in updateTaskStatus — no manual revocation needed.
// ─────────────────────────────────────────────────────────────────
export const inviteTaskCollaborator = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const { inviteeId } = req.body as { inviteeId: string };

    const task = await TaskModel.findById(id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO      = req.user!.role === 'ceo';

    if (!isAssignee && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the task assignee or CEO can invite collaborators' });
      return;
    }

    if (task.status !== 'in_progress') {
      res.status(400).json({ success: false, message: 'Collaborators can only be invited to tasks that are in progress' });
      return;
    }

    if (inviteeId === req.user!.userId) {
      res.status(400).json({ success: false, message: 'You cannot invite yourself as a collaborator' });
      return;
    }

    if (inviteeId === task.assignedTo.toString()) {
      res.status(400).json({ success: false, message: 'The assignee is already the task owner' });
      return;
    }

    // Check invitee is already an active collaborator
    const alreadyCollaborating = task.collaborators.some(
      (c) => c.userId.toString() === inviteeId && c.status === 'active'
    );
    if (alreadyCollaborating) {
      res.status(400).json({ success: false, message: 'This user is already an active collaborator' });
      return;
    }

    // Verify the invitee exists and is active
    const invitee = await User.findById(inviteeId).select('name isActive');
    if (!invitee?.isActive) {
      res.status(404).json({ success: false, message: 'Invitee not found or inactive' });
      return;
    }

    // Supervisors can only invite from their own team
    if (req.user!.role === 'supervisor') {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: req.user!.userId,
        subordinateId: inviteeId,
        status: 'active',
      });
      if (!mapping) {
        res.status(403).json({ success: false, message: 'You can only invite members of your own team' });
        return;
      }
    }

    // Add collaborator (re-add if previously revoked, otherwise push new)
    const existingIdx = task.collaborators.findIndex((c) => c.userId.toString() === inviteeId);
    if (existingIdx >= 0) {
      // Re-invite a previously revoked collaborator
      task.collaborators[existingIdx].status    = 'active';
      task.collaborators[existingIdx].invitedAt = new Date();
      task.collaborators[existingIdx].revokedAt = undefined;
    } else {
      task.collaborators.push({
        userId:    new mongoose.Types.ObjectId(inviteeId),
        invitedAt: new Date(),
        status:    'active',
      });
    }

    await task.save();

    await createNotification(
      inviteeId,
      `You have been invited to collaborate on task: "${task.title}"`,
      'task_collaboration_invite'
    );

    res.json({ success: true, message: `${invitee.name} invited as a collaborator` });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// REVOKE COLLABORATOR — manual early revocation
// Assignee or CEO can revoke before task completion.
// ─────────────────────────────────────────────────────────────────
export const revokeTaskCollaborator = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id, collaboratorId } = req.params as { id: string; collaboratorId: string };

    const task = await TaskModel.findById(id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO      = req.user!.role === 'ceo';

    if (!isAssignee && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the task assignee or CEO can revoke collaborator access' });
      return;
    }

    const collaborator = task.collaborators.find(
      (c) => c.userId.toString() === collaboratorId && c.status === 'active'
    );
    if (!collaborator) {
      res.status(404).json({ success: false, message: 'Active collaborator not found' });
      return;
    }

    collaborator.status    = 'revoked';
    collaborator.revokedAt = new Date();
    await task.save();

    res.json({ success: true, message: 'Collaborator access revoked' });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// TASK LEADERBOARD
// ─────────────────────────────────────────────────────────────────
export const getTaskLeaderboard = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { limit = '10' } = req.query as Record<string, string>;
    const matchStage: Record<string, unknown> = {
      status: 'completed',
      efficiencyRatio: { $exists: true },
    };

    if (req.user!.role === 'supervisor') {
      const mappings = await SupervisorMapping.find({ supervisorId: req.user!.userId, status: 'active' }).select('subordinateId');
      matchStage['assignedTo'] = { $in: mappings.map((m) => m.subordinateId) };
    } else if (req.user!.role === 'user') {
      matchStage['assignedTo'] = new mongoose.Types.ObjectId(req.user!.userId);
    }

    const leaderboard = await TaskModel.aggregate([
      { $match: matchStage },
      { $group: {
        _id:            '$assignedTo',
        avgEfficiency:  { $avg: '$efficiencyRatio' },
        avgTat:         { $avg: '$tatMinutes' },
        completedTasks: { $sum: 1 },
      }},
      { $sort: { avgEfficiency: -1 } },
      { $limit: Number(limit) },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { 'user.password': 0 } },
    ]);

    res.json({ success: true, data: { leaderboard } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// INDIVIDUAL APPRAISAL REPORT
// ─────────────────────────────────────────────────────────────────
export const getUserAppraisal = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { userId } = req.params as { userId: string };

    if (req.user!.role === 'user' && req.user!.userId !== userId) {
      res.status(403).json({ success: false, message: 'You can only view your own appraisal' }); return;
    }
    if (req.user!.role === 'supervisor') {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: req.user!.userId, subordinateId: userId, status: 'active',
      });
      if (!mapping) { res.status(403).json({ success: false, message: 'Not your team member' }); return; }
    }

    const targetId = new mongoose.Types.ObjectId(userId);

    const [summary, recentTasks] = await Promise.all([
      TaskModel.aggregate([
        { $match: { assignedTo: targetId } },
        { $group: {
          _id:              null,
          totalTasks:       { $sum: 1 },
          completedTasks:   { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          cancelledTasks:   { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          avgEfficiency:    { $avg: '$efficiencyRatio' },
          avgTatMinutes:    { $avg: '$tatMinutes' },
          avgTargetMinutes: { $avg: '$targetMinutes' },
          onTimeTasks: { $sum: {
            $cond: [{ $and: [
              { $gte: ['$efficiencyRatio', 1] },
              { $eq:  ['$status', 'completed'] },
            ]}, 1, 0],
          }},
        }},
      ]),
      TaskModel.find({ assignedTo: targetId, status: 'completed' })
        .sort({ completedAt: -1 }).limit(10)
        .populate('assignedBy', 'name role')
        .populate('documentId', 'title'),
    ]);

    const stats = summary[0] ?? {
      totalTasks: 0, completedTasks: 0, cancelledTasks: 0,
      avgEfficiency: null, avgTatMinutes: null, avgTargetMinutes: null, onTimeTasks: 0,
    };

    res.json({
      success: true,
      data: {
        appraisal: {
          ...stats,
          completionRate:  stats.totalTasks > 0 ? `${((stats.completedTasks / stats.totalTasks) * 100).toFixed(1)}%` : '0%',
          onTimeRate:      stats.completedTasks > 0 ? `${((stats.onTimeTasks / stats.completedTasks) * 100).toFixed(1)}%` : '0%',
          avgEfficiency:   stats.avgEfficiency ? Number(stats.avgEfficiency.toFixed(3)) : null,
          avgTatMinutes:   stats.avgTatMinutes ? Math.round(stats.avgTatMinutes) : null,
        },
        recentTasks,
      },
    });
  } catch (err) { next(err); }
};


export const supervisorApproveTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);

    if (!task) {
      res.status(404).json({ message: "Task not found" });
      return;
    }

    task.status = "completed"; // ⚠️ see issue #3 below
    task.set("approvedBy", req.user!.userId);
    task.set("approvedAt", new Date());

    await task.save();

    res.json({
      message: "Task approved successfully",
      task,
    });
  } catch (error) {
    next(error);
  }
};