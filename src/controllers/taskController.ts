import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import { TaskModel, TaskStatus, ITask } from '../models/Task';
import { SupervisorMapping } from '../models/SupervisorMapping';
import { User } from '../models/User';
import { DocumentModel } from '../models/Document';
import { createNotification } from '../services/notificationService';
import { getLocalFileUrl } from '../middleware/upload';
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
// CREATE TASK
// CEO/Supervisor can upload files when creating the task.
// These files serve as context/brief/requirements for the assignee.
// ─────────────────────────────────────────────────────────────────
export const createTask = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
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

    // Build taskFiles from any uploaded files
    const uploadedFiles = (req.files as Express.Multer.File[]) ?? [];
    const taskFiles = uploadedFiles.map((file) => ({
      fileName:   file.originalname,
      fileKey:    file.filename,
      fileUrl:    getLocalFileUrl(file.filename),
      fileSize:   file.size,
      fileType:   file.mimetype,
      uploadedBy: new mongoose.Types.ObjectId(actorId),
      uploadedAt: new Date(),
    }));

    const task = await TaskModel.create({
      title, description,
      assignedBy:   new mongoose.Types.ObjectId(actorId),
      assignedTo:   new mongoose.Types.ObjectId(assignedTo),
      documentId:   documentId ? new mongoose.Types.ObjectId(documentId) : undefined,
      taskFiles,
      submissionDocuments: [],
      priority:     priority ?? 'medium',
      dueDate:      dueDate ? new Date(dueDate) : undefined,
      status:       'pending',
      collaborators: [],
      approvalHistory: [],
    });

    const assigner = await User.findById(actorId).select('name').lean();

    await createNotification(
      assignedTo,
      `You have been assigned a new task: "${title}"`,
      'task_assigned',
      {
        taskTitle:       title,
        taskDescription: description,
        taskPriority:    priority ?? 'medium',
        taskDueDate:     dueDate,
        taskId:          task._id.toString(),
        assignerName:    assigner?.name ?? 'Your manager',
      }
    );

    const populated = await TaskModel.findById(task._id)
      .populate('assignedBy', 'name email role')
      .populate('assignedTo', 'name email role')
      .populate('collaborators.userId', 'name email')
      .populate('documentId', 'title fileType')
      .populate('submissionDocuments', 'title fileType createdAt');

    res.status(201).json({ success: true, message: 'Task created', data: { task: populated } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// READ ALL — role-scoped, paginated
// ─────────────────────────────────────────────────────────────────
export const getTasks = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const role   = req.user!.role;
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const { status, priority, page = '1', limit = '20' } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};
    if (status)   filter['status']   = status;
    if (priority) filter['priority'] = priority;

    if (role === 'user') {
      filter['$or'] = [
        { assignedTo: userId },
        { 'collaborators': { $elemMatch: { userId, status: 'active' } } },
      ];
    } else if (role === 'supervisor') {
      filter['$or'] = [{ assignedTo: userId }, { assignedBy: userId }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [tasks, total] = await Promise.all([
      TaskModel.find(filter)
        .populate('assignedBy', 'name email role')
        .populate('assignedTo', 'name email role')
        .populate('collaborators.userId', 'name email')
        .populate('documentId', 'title fileType')
        .populate('submissionDocuments', 'title fileType createdAt')
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
// READ ONE — includes all linked documents for review
// ─────────────────────────────────────────────────────────────────
export const getTask = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id)
      .populate('assignedBy', 'name email role')
      .populate('assignedTo', 'name email role')
      .populate('collaborators.userId', 'name email')
      .populate('documentId', 'title fileType versionHistory')
      .populate('submissionDocuments', 'title fileType versionHistory createdAt')
      .populate('approvalHistory.by', 'name role');

    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }
    if (!canViewTask(task, req.user!.userId, req.user!.role)) {
      res.status(403).json({ success: false, message: 'Access denied' }); return;
    }
    res.json({ success: true, data: { task } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE METADATA
// ─────────────────────────────────────────────────────────────────
export const updateTask = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
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
// UPDATE STATUS — TAT lifecycle
//
//  pending     → in_progress : assignee commits targetMinutes
//  in_progress → submitted   : assignee attaches supporting documents
//  submitted   → completed   : approver (supervisor/CEO) reviews docs + approves
//  submitted   → rejected    : approver rejects with reason (goes back to in_progress)
//  any         → cancelled   : assigner or CEO only
// ─────────────────────────────────────────────────────────────────
export const updateTaskStatus = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const userId     = req.user!.userId;
    const isAssignee = task.assignedTo.toString() === userId;
    const isAssigner = task.assignedBy.toString() === userId;
    const isCEO      = req.user!.role === 'ceo';
    const isSupervisor = req.user!.role === 'supervisor';

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

    const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'submitted', 'completed', 'rejected', 'cancelled'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, message: 'Invalid status' }); return;
    }

    if (status === 'cancelled' && !isAssigner && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the task creator or CEO can cancel tasks' }); return;
    }

    if (['in_progress', 'submitted'].includes(status) && !isAssignee && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the task assignee can start or submit tasks' }); return;
    }

    if (['completed', 'rejected'].includes(status) && !isAssigner && !isCEO && !isSupervisor) {
      res.status(403).json({ success: false, message: 'Only the task creator, supervisor, or CEO can approve/reject tasks' }); return;
    }

    const now = new Date();

    // ── pending → in_progress ────────────────────────────────────
    if (status === 'in_progress' && task.status === 'pending') {
      const target = targetMinutes ?? task.targetMinutes;
      if (!target || target < 1) {
        res.status(400).json({
          success: false,
          message: 'You must set targetMinutes before starting. This is your personal commitment.',
        }); return;
      }
      task.targetMinutes = target;
      task.startedAt     = now;
      task.status        = 'in_progress';
    }

    // ── in_progress → submitted ───────────────────────────────────
    // Assignee submits for approval and can link supporting documents
    else if (status === 'submitted' && task.status === 'in_progress') {
      task.status           = 'submitted';
      task.submittedAt      = now;
      if (submissionComment) task.submissionComment = submissionComment;

      // Attach documents the assignee is submitting as proof of work
      if (submissionDocumentIds?.length) {
        const validIds = submissionDocumentIds.map(id => new mongoose.Types.ObjectId(id));
        task.submissionDocuments = validIds;
      }

      await createNotification(
        task.assignedBy.toString(),
        `Task "${task.title}" has been submitted for your review`,
        'task_submitted'
      );
    }

    // ── submitted → completed (APPROVAL) ─────────────────────────
    else if (status === 'completed' && task.status === 'submitted') {
      task.completedAt = now;
      task.status      = 'completed';

      if (task.startedAt) {
        task.tatMinutes = calcTAT(task.startedAt, now);
        if (task.targetMinutes) {
          task.efficiencyRatio = calcEfficiency(task.targetMinutes, task.tatMinutes);
        }
      }

      // Revoke all collaborators
      const revokedAt = now;
      task.collaborators = task.collaborators.map((c) => ({
        ...c, status: 'revoked' as const, revokedAt,
      }));

      task.approvalHistory.push({
        action: 'approved',
        by:     new mongoose.Types.ObjectId(userId),
        at:     now,
      });

      const assigneeUser = await User.findById(task.assignedTo).select('name').lean();
      await createNotification(
        task.assignedTo.toString(),
        `Task "${task.title}" has been approved and marked complete`,
        'task_completed',
        {
          taskTitle:       task.title,
          assigneeName:    assigneeUser?.name ?? 'The assignee',
          efficiencyRatio: task.efficiencyRatio,
        }
      );
    }

    // ── submitted → rejected ──────────────────────────────────────
    else if (status === 'rejected' && task.status === 'submitted') {
      if (!rejectionReason) {
        res.status(400).json({ success: false, message: 'A rejection reason is required' }); return;
      }
      task.status          = 'in_progress'; // returns to in_progress so assignee can rework
      task.rejectionReason = rejectionReason;

      task.approvalHistory.push({
        action: 'rejected',
        by:     new mongoose.Types.ObjectId(userId),
        at:     now,
        reason: rejectionReason,
      });

      await createNotification(
        task.assignedTo.toString(),
        `Task "${task.title}" was rejected: ${rejectionReason}`,
        'task_rejected'
      );
    }

    // ── cancellation ─────────────────────────────────────────────
    else if (status === 'cancelled') {
      task.status = 'cancelled';
      const revokedAt = now;
      task.collaborators = task.collaborators.map((c) => ({
        ...c, status: 'revoked' as const, revokedAt,
      }));
    }

    else if (task.status === status) {
      res.status(400).json({ success: false, message: `Task is already ${status}` }); return;
    } else {
      res.status(400).json({
        success: false,
        message: `Cannot transition from "${task.status}" to "${status}"`,
      }); return;
    }

    if (notes !== undefined) task.notes = notes;
    await task.save();

    // Return fully populated task so the reviewer can see all linked docs
    const populated = await TaskModel.findById(task._id)
      .populate('assignedBy', 'name email role')
      .populate('assignedTo', 'name email role')
      .populate('collaborators.userId', 'name email')
      .populate('documentId', 'title fileType versionHistory')
      .populate('submissionDocuments', 'title fileType versionHistory createdAt')
      .populate('approvalHistory.by', 'name role');

    res.json({ success: true, message: 'Task updated', data: { task: populated } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────
export const deleteTask = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
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
// ─────────────────────────────────────────────────────────────────
export const inviteTaskCollaborator = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params as { id: string };
    const { inviteeId } = req.body as { inviteeId: string };

    const task = await TaskModel.findById(id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO      = req.user!.role === 'ceo';

    if (!isAssignee && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the task assignee or CEO can invite collaborators' }); return;
    }

    if (task.status !== 'in_progress') {
      res.status(400).json({ success: false, message: 'Collaborators can only be invited to in-progress tasks' }); return;
    }

    if (inviteeId === req.user!.userId) {
      res.status(400).json({ success: false, message: 'You cannot invite yourself' }); return;
    }

    const alreadyActive = task.collaborators.some(
      (c) => c.userId.toString() === inviteeId && c.status === 'active'
    );
    if (alreadyActive) {
      res.status(400).json({ success: false, message: 'This user is already an active collaborator' }); return;
    }

    const invitee = await User.findById(inviteeId).select('name isActive');
    if (!invitee?.isActive) {
      res.status(404).json({ success: false, message: 'Invitee not found or inactive' }); return;
    }

    if (req.user!.role === 'supervisor') {
      const mapping = await SupervisorMapping.findOne({
        supervisorId: req.user!.userId, subordinateId: inviteeId, status: 'active',
      });
      if (!mapping) {
        res.status(403).json({ success: false, message: 'You can only invite members of your own team' }); return;
      }
    }

    const existingIdx = task.collaborators.findIndex((c) => c.userId.toString() === inviteeId);
    if (existingIdx >= 0) {
      task.collaborators[existingIdx].status    = 'active';
      task.collaborators[existingIdx].invitedAt = new Date();
      task.collaborators[existingIdx].revokedAt = undefined;
    } else {
      task.collaborators.push({
        userId: new mongoose.Types.ObjectId(inviteeId), invitedAt: new Date(), status: 'active',
      });
    }

    await task.save();

    const inviter = await User.findById(req.user!.userId).select('name').lean();
    await createNotification(
      inviteeId,
      `You have been invited to collaborate on task: "${task.title}"`,
      'task_collaboration_invite',
      { taskTitle: task.title, inviterName: inviter?.name ?? 'A colleague' }
    );

    res.json({ success: true, message: `${invitee.name} invited as a collaborator` });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// REVOKE COLLABORATOR
// ─────────────────────────────────────────────────────────────────
export const revokeTaskCollaborator = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id, collaboratorId } = req.params as { id: string; collaboratorId: string };
    const task = await TaskModel.findById(id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const isAssignee = task.assignedTo.toString() === req.user!.userId;
    const isCEO      = req.user!.role === 'ceo';

    if (!isAssignee && !isCEO) {
      res.status(403).json({ success: false, message: 'Only the task assignee or CEO can revoke collaborator access' }); return;
    }

    const collaborator = task.collaborators.find(
      (c) => c.userId.toString() === collaboratorId && c.status === 'active'
    );
    if (!collaborator) {
      res.status(404).json({ success: false, message: 'Active collaborator not found' }); return;
    }

    collaborator.status    = 'revoked';
    collaborator.revokedAt = new Date();
    await task.save();

    res.json({ success: true, message: 'Collaborator access revoked' });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────────────────────────
export const getTaskLeaderboard = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { limit = '10' } = req.query as Record<string, string>;
    const matchStage: Record<string, unknown> = {
      status: 'completed', efficiencyRatio: { $exists: true },
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
// INDIVIDUAL APPRAISAL
// ─────────────────────────────────────────────────────────────────
export const getUserAppraisal = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
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
          onTimeTasks: { $sum: { $cond: [{ $and: [
            { $gte: ['$efficiencyRatio', 1] }, { $eq: ['$status', 'completed'] },
          ]}, 1, 0] }},
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
          completionRate: stats.totalTasks > 0 ? `${((stats.completedTasks / stats.totalTasks) * 100).toFixed(1)}%` : '0%',
          onTimeRate:     stats.completedTasks > 0 ? `${((stats.onTimeTasks / stats.completedTasks) * 100).toFixed(1)}%` : '0%',
          avgEfficiency:  stats.avgEfficiency ? Number(stats.avgEfficiency.toFixed(3)) : null,
          avgTatMinutes:  stats.avgTatMinutes ? Math.round(stats.avgTatMinutes) : null,
        },
        recentTasks,
      },
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// APPROVE TASK  (PATCH /:id/approve)
// Convenience endpoint: CEO or Supervisor can approve a submitted
// task without going through the full updateTaskStatus flow.
// Equivalent to PATCH /:id/status with { status: 'completed' }.
// ─────────────────────────────────────────────────────────────────
export const approveTask = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const task = await TaskModel.findById(req.params.id);
    if (!task) { res.status(404).json({ success: false, message: 'Task not found' }); return; }

    const userId = req.user!.userId;
    const role   = req.user!.role;

    if (role !== 'ceo' && role !== 'supervisor') {
      res.status(403).json({ success: false, message: 'Only CEO or Supervisor can approve tasks' }); return;
    }

    if (task.status !== 'submitted') {
      res.status(400).json({
        success: false,
        message: `Cannot approve a task that is "${task.status}" — task must be submitted first`,
      }); return;
    }

    const now = new Date();
    task.status      = 'completed';
    task.completedAt = now;

    if (task.startedAt) {
      task.tatMinutes = calcTAT(task.startedAt, now);
      if (task.targetMinutes) {
        task.efficiencyRatio = calcEfficiency(task.targetMinutes, task.tatMinutes);
      }
    }

    // Auto-revoke all active collaborators on completion
    task.collaborators = task.collaborators.map((c) => ({
      ...c, status: 'revoked' as const, revokedAt: now,
    }));

    task.approvalHistory.push({
      action: 'approved',
      by:     new mongoose.Types.ObjectId(userId),
      at:     now,
    });

    await task.save();

    const assigneeUser = await User.findById(task.assignedTo).select('name').lean();
    await createNotification(
      task.assignedTo.toString(),
      `Task "${task.title}" has been approved and marked complete`,
      'task_completed',
      {
        taskTitle:       task.title,
        assigneeName:    assigneeUser?.name ?? 'The assignee',
        efficiencyRatio: task.efficiencyRatio,
      }
    );

    const populated = await TaskModel.findById(task._id)
      .populate('assignedBy', 'name email role')
      .populate('assignedTo', 'name email role')
      .populate('collaborators.userId', 'name email')
      .populate('documentId', 'title fileType versionHistory')
      .populate('submissionDocuments', 'title fileType versionHistory createdAt')
      .populate('approvalHistory.by', 'name role');

    res.json({ success: true, message: 'Task approved and completed', data: { task: populated } });
  } catch (err) { next(err); }
};