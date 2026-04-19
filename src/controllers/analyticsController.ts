import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import { DocumentModel } from '../models/Document';
import { TaskModel } from '../models/Task';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { SupervisorMapping } from '../models/SupervisorMapping';
import { Collaboration } from '../models/Collaboration';
import mongoose from 'mongoose';
import { EmailLog } from '../models/EmailLog';

// ─── Design note ─────────────────────────────────────────────────
//
// TAT and efficiency are now measured on TASKS, not documents.
// Document analytics cover counts and activity only.
// Task analytics cover individual performance, appraisals, leaderboard.
//
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// TASK LEADERBOARD — top performers by efficiency ratio
// ─────────────────────────────────────────────────────────────────
export const getLeaderboard = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { limit = '10' } = req.query as Record<string, string>;
    const matchStage: Record<string, unknown> = {
      status: 'completed',
      efficiencyRatio: { $exists: true },
    };

    if (req.user?.role === 'supervisor') {
      const mappings = await SupervisorMapping.find({ supervisorId: req.user.userId, status: 'active' }).select('subordinateId');
      matchStage['assignedTo'] = { $in: mappings.map((m) => m.subordinateId) };
    }

    const leaderboard = await TaskModel.aggregate([
      { $match: matchStage },
      { $group: {
        _id: '$assignedTo',
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

    res.json({ success: true, message: 'Leaderboard retrieved', data: { leaderboard } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// BOTTLENECK ANALYSIS — tasks that consistently exceed target
// ─────────────────────────────────────────────────────────────────
export const getBottleneckAnalysis = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const matchBase: Record<string, unknown> = {
      status: 'completed',
      tatMinutes: { $exists: true },
      targetMinutes: { $exists: true },
    };

    if (req.user?.role === 'supervisor') {
      const mappings = await SupervisorMapping.find({ supervisorId: req.user.userId, status: 'active' }).select('subordinateId');
      matchBase['assignedTo'] = { $in: mappings.map((m) => m.subordinateId) };
    }

    const bottlenecks = await TaskModel.aggregate([
      { $match: matchBase },
      { $addFields: { exceeded: { $gt: ['$tatMinutes', '$targetMinutes'] } } },
      { $group: {
        _id: '$priority',
        totalTasks:       { $sum: 1 },
        exceededCount:    { $sum: { $cond: ['$exceeded', 1, 0] } },
        avgTatMinutes:    { $avg: '$tatMinutes' },
        avgTargetMinutes: { $avg: '$targetMinutes' },
        avgEfficiency:    { $avg: '$efficiencyRatio' },
      }},
      { $addFields: { bottleneckRate: { $divide: ['$exceededCount', '$totalTasks'] } } },
      { $sort: { bottleneckRate: -1 } },
    ]);

    res.json({ success: true, message: 'Bottleneck analysis retrieved', data: { bottlenecks } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// TREND ANALYSIS — task completion efficiency over time
// ─────────────────────────────────────────────────────────────────
export const getTrendAnalysis = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { userId, period = 'monthly' } = req.query as Record<string, string>;
    const matchStage: Record<string, unknown> = { status: 'completed' };
    if (userId) matchStage['assignedTo'] = new mongoose.Types.ObjectId(userId);

    const dateFormat = period === 'quarterly' ? '%Y-Q' : period === 'weekly' ? '%Y-%V' : '%Y-%m';

    const trends = await TaskModel.aggregate([
      { $match: matchStage },
      { $group: {
        _id: { $dateToString: { format: dateFormat, date: '$completedAt' } },
        avgEfficiency:  { $avg: '$efficiencyRatio' },
        totalCompleted: { $sum: 1 },
        avgTat:         { $avg: '$tatMinutes' },
      }},
      { $sort: { _id: 1 } },
    ]);

    res.json({ success: true, message: 'Trend analysis retrieved', data: { trends, period } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// DASHBOARD STATS — document counts + task performance summary
// ─────────────────────────────────────────────────────────────────
export const getDashboardStats = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const role   = req.user?.role;

    let docFilter: Record<string, unknown>  = {};
    let taskFilter: Record<string, unknown> = {};

    if (role === 'user') {
      docFilter['ownerId']   = new mongoose.Types.ObjectId(userId);
      taskFilter['assignedTo'] = new mongoose.Types.ObjectId(userId);
    } else if (role === 'supervisor') {
      const mappings = await SupervisorMapping.find({ supervisorId: userId, status: 'active' }).select('subordinateId');
      const ids = mappings.map((m) => m.subordinateId);
      docFilter['ownerId']     = { $in: ids };
      taskFilter['$or'] = [{ assignedTo: { $in: ids } }, { assignedBy: new mongoose.Types.ObjectId(userId) }];
    }

    const [
      totalDocs, completedDocs, inProgressDocs,
      totalTasks, completedTasks, pendingTasks, submittedTasks, inProgressTasks,
      totalUsers, recentAudit, collaborationStats,
    ] = await Promise.all([
      DocumentModel.countDocuments(docFilter),
      DocumentModel.countDocuments({ ...docFilter, status: 'completed' }),
      DocumentModel.countDocuments({ ...docFilter, status: 'in_progress' }),
      TaskModel.countDocuments(taskFilter),
      TaskModel.countDocuments({ ...taskFilter, status: 'completed' }),
      TaskModel.countDocuments({ ...taskFilter, status: 'pending' }),
      TaskModel.countDocuments({ ...taskFilter, status: 'submitted' }),
      TaskModel.countDocuments({ ...taskFilter, status: 'in_progress' }),
      role === 'ceo' ? User.countDocuments({ isActive: true }) : 0,
      AuditLog.find(userId && role === 'user' ? { actorId: new mongoose.Types.ObjectId(userId) } : {})
        .populate('actorId', 'name email').populate('documentId', 'title')
        .sort({ timestamp: -1 }).limit(10),
      role !== 'user'
        ? Collaboration.aggregate([
            { $group: { _id: '$inviterId', asRequester: { $sum: 1 } } },
            { $sort: { asRequester: -1 } }, { $limit: 5 },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
            { $unwind: '$user' },
          ])
        : Promise.resolve([]),
    ]);

    // Task efficiency stats (replaces document TAT stats)
    const taskEfficiency = await TaskModel.aggregate([
      { $match: { ...taskFilter, status: 'completed', efficiencyRatio: { $exists: true } } },
      { $group: {
        _id: null,
        avgEfficiency: { $avg: '$efficiencyRatio' },
        avgTat:        { $avg: '$tatMinutes' },
      }},
    ]);

    res.json({
      success: true, message: 'Dashboard stats retrieved',
      data: {
        stats: {
          // Document stats (counts only — no TAT here)
          totalDocs, completedDocs, inProgressDocs,
          docCompletionRate: totalDocs > 0 ? ((completedDocs / totalDocs) * 100).toFixed(1) : '0',
          // Task performance stats (the appraisal dimension)
          totalTasks, completedTasks, pendingTasks, submittedTasks, inProgressTasks,
          taskCompletionRate: totalTasks > 0 ? ((completedTasks / totalTasks) * 100).toFixed(1) : '0',
          avgTaskEfficiency: taskEfficiency[0]?.avgEfficiency?.toFixed(3) ?? 'N/A',
          avgTaskTatMinutes: Math.round(taskEfficiency[0]?.avgTat ?? 0),
          // Users (CEO only)
          totalUsers,
        },
        recentAudit,
        collaborationStats,
      },
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// AUDIT TRAIL — server-side search across actor + document
// ─────────────────────────────────────────────────────────────────
export const getAuditTrail = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { documentId, actorId, action, search, page = '1', limit = '30' } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};
    if (documentId) filter['documentId'] = new mongoose.Types.ObjectId(documentId);
    if (actorId)    filter['actorId']    = new mongoose.Types.ObjectId(actorId);
    if (action)     filter['action']     = action;
    if (req.user?.role === 'user') filter['actorId'] = new mongoose.Types.ObjectId(req.user.userId);

    if (search) {
      const [matchingUsers, matchingDocs] = await Promise.all([
        User.find({ name: { $regex: search, $options: 'i' } }).select('_id'),
        DocumentModel.find({ title: { $regex: search, $options: 'i' } }).select('_id'),
      ]);
      filter['$and'] = [{ $or: [
        { actorId:    { $in: matchingUsers.map((u) => u._id) } },
        { documentId: { $in: matchingDocs.map((d) => d._id) } },
      ]}];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate('actorId', 'name email role')
        .populate('targetUserId', 'name email')
        .populate('documentId', 'title')
        .populate('supervisorIdAtTime', 'name email')
        .sort({ timestamp: -1 }).skip(skip).limit(Number(limit)),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      success: true, message: 'Audit trail retrieved',
      data: { logs },
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────
// COLLABORATION FREQUENCY
// ─────────────────────────────────────────────────────────────────
export const getCollaborationFrequency = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stats = await Collaboration.aggregate([
      { $facet: {
        asRequester: [
          { $group: { _id: '$inviterId', requestCount: { $sum: 1 } } },
          { $sort: { requestCount: -1 } }, { $limit: 20 },
          { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
          { $unwind: '$user' }, { $project: { 'user.password': 0 } },
        ],
        asHelper: [
          { $group: { _id: '$inviteeId', helperCount: { $sum: 1 } } },
          { $sort: { helperCount: -1 } }, { $limit: 20 },
          { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
          { $unwind: '$user' }, { $project: { 'user.password': 0 } },
        ],
      }},
    ]);

    res.json({ success: true, message: 'Collaboration frequency retrieved', data: { stats: stats[0] } });
  } catch (err) { next(err); }
};


// ─────────────────────────────────────────────────────────────────
// EMAIL ANALYTICS
// ─────────────────────────────────────────────────────────────────
export const getEmailAnalytics = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const match = req.user?.role === 'ceo'
      ? {}
      : { senderId: req.user!.userId };

    const stats = await EmailLog.aggregate([
      { $match: match },

      {
        $facet: {
          statusBreakdown: [
            { $group: { _id: '$status', count: { $sum: 1 } } }
          ],

          volumeOverTime: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m", date: "$createdAt" }
                },
                sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
              }
            },
            { $sort: { _id: 1 } }
          ],

          topSenders: [
            {
              $group: {
                _id: "$senderId",
                total: { $sum: 1 },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }
              }
            },
            { $sort: { total: -1 } },
            { $limit: 10 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user"
              }
            },
            { $unwind: "$user" }
          ],

          failureRate: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }
              }
            },
            {
              $project: {
                failureRate: {
                  $divide: ["$failed", "$total"]
                }
              }
            }
          ]
        }
      }
    ]);

    res.json({
      success: true,
      data: stats[0]
    });

  } catch (err) {
    next(err);
  }
};