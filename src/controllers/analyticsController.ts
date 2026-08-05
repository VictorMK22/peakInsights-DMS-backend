import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { DocumentModel } from "../models/Document";
import { TaskModel } from "../models/Task";
import { User } from "../models/User";
import { AuditLog } from "../models/AuditLog";
import { SupervisorMapping } from "../models/SupervisorMapping";
import mongoose from "mongoose";
import { EmailLog } from "../models/EmailLog";
import { MeetingModel } from "../models/Meeting";
import { getRecentMeetingActivity } from "../services/meetingActivityService";

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
export const getLeaderboard = async (
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

    if (req.user?.role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: req.user.userId,
        status: "active",
      }).select("subordinateId");
      matchStage["assignedTo"] = { $in: mappings.map((m) => m.subordinateId) };
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

    res.json({
      success: true,
      message: "Leaderboard retrieved",
      data: { leaderboard },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// BOTTLENECK ANALYSIS — tasks that consistently exceed target
// ─────────────────────────────────────────────────────────────────
export const getBottleneckAnalysis = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const matchBase: Record<string, unknown> = {
      status: "completed",
      tatMinutes: { $exists: true },
      targetMinutes: { $exists: true },
    };

    if (req.user?.role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: req.user.userId,
        status: "active",
      }).select("subordinateId");
      matchBase["assignedTo"] = { $in: mappings.map((m) => m.subordinateId) };
    }

    const bottlenecks = await TaskModel.aggregate([
      { $match: matchBase },
      { $addFields: { exceeded: { $gt: ["$tatMinutes", "$targetMinutes"] } } },
      {
        $group: {
          _id: "$priority",
          totalTasks: { $sum: 1 },
          exceededCount: { $sum: { $cond: ["$exceeded", 1, 0] } },
          avgTatMinutes: { $avg: "$tatMinutes" },
          avgTargetMinutes: { $avg: "$targetMinutes" },
          avgEfficiency: { $avg: "$efficiencyRatio" },
        },
      },
      {
        $addFields: {
          bottleneckRate: { $divide: ["$exceededCount", "$totalTasks"] },
        },
      },
      { $sort: { bottleneckRate: -1 } },
    ]);

    res.json({
      success: true,
      message: "Bottleneck analysis retrieved",
      data: { bottlenecks },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// TREND ANALYSIS — task completion efficiency over time
// ─────────────────────────────────────────────────────────────────
export const getTrendAnalysis = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId, period = "monthly" } = req.query as Record<string, string>;
    const matchStage: Record<string, unknown> = { status: "completed" };

    if (req.user?.role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: req.user.userId,
        status: "active",
      }).select("subordinateId");
      const teamIds = mappings.map((m) => m.subordinateId.toString());

      if (userId) {
        // A supervisor can drill into an individual's trend, but only
        // someone on their own team — otherwise they could pull another
        // team's (or another supervisor's) performance data just by
        // guessing a userId.
        if (!teamIds.includes(userId)) {
          res.status(403).json({
            success: false,
            message: "You can only view trends for your own team",
          });
          return;
        }
        matchStage["assignedTo"] = new mongoose.Types.ObjectId(userId);
      } else {
        matchStage["assignedTo"] = {
          $in: mappings.map((m) => m.subordinateId),
        };
      }
    } else if (userId) {
      // CEO (or any other authorized role) can request any individual's trend.
      matchStage["assignedTo"] = new mongoose.Types.ObjectId(userId);
    }

    const dateFormat =
      period === "quarterly" ? "%Y-Q" : period === "weekly" ? "%Y-%V" : "%Y-%m";

    const trends = await TaskModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: "$completedAt" } },
          avgEfficiency: { $avg: "$efficiencyRatio" },
          totalCompleted: { $sum: 1 },
          avgTat: { $avg: "$tatMinutes" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      message: "Trend analysis retrieved",
      data: { trends, period },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// DASHBOARD STATS — document counts + task performance summary
// ─────────────────────────────────────────────────────────────────
export const getDashboardStats = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const role = req.user?.role;

    let docFilter: Record<string, unknown> = {};
    let taskFilter: Record<string, unknown> = {};

    if (role === "user" || role === "accountant") {
      docFilter["ownerId"] = new mongoose.Types.ObjectId(userId);
      taskFilter["assignedTo"] = new mongoose.Types.ObjectId(userId);
    } else if (role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: userId,
        status: "active",
      }).select("subordinateId");
      const ids = mappings.map((m) => m.subordinateId);
      docFilter["ownerId"] = { $in: ids };
      taskFilter["$or"] = [
        { assignedTo: { $in: ids } },
        { assignedBy: new mongoose.Types.ObjectId(userId) },
      ];
    }

    let auditFilter: Record<string, unknown> = {};
    if (role === "user" || role === "accountant") {
      auditFilter = { actorId: new mongoose.Types.ObjectId(userId) };
    } else if (role === "supervisor") {
      const supId = new mongoose.Types.ObjectId(userId);
      auditFilter = {
        $or: [{ supervisorIdAtTime: supId }, { actorId: supId }],
      };
    }

    // Meetings — same visibility rules as documents/tasks: everyone
    // sees their own, supervisors additionally see their team's, and
    // ceo/tech see everything.
    let meetingFilter: Record<string, unknown> = {};
    if (role === "ceo" || role === "tech") {
      meetingFilter = {};
    } else if (role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: userId,
        status: "active",
      }).select("subordinateId");
      const ids = [
        ...mappings.map((m) => m.subordinateId),
        new mongoose.Types.ObjectId(userId),
      ];
      meetingFilter = {
        $or: [
          { organizer: { $in: ids } },
          { "attendees.userId": { $in: ids } },
        ],
      };
    } else {
      const uid = new mongoose.Types.ObjectId(userId);
      meetingFilter = {
        $or: [{ organizer: uid }, { "attendees.userId": uid }],
      };
    }
    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalDocs,
      completedDocs,
      inProgressDocs,
      totalTasks,
      completedTasks,
      pendingTasks,
      submittedTasks,
      inProgressTasks,
      totalUsers,
      recentAudit,
      collaborationStats,
      upcomingMeetings,
      meetingsThisWeek,
      completedMeetings,
      cancelledMeetings,
      meetingIdsForActivity,
    ] = await Promise.all([
      DocumentModel.countDocuments(docFilter),
      DocumentModel.countDocuments({ ...docFilter, status: "completed" }),
      DocumentModel.countDocuments({ ...docFilter, status: "in_progress" }),
      TaskModel.countDocuments(taskFilter),
      TaskModel.countDocuments({ ...taskFilter, status: "completed" }),
      TaskModel.countDocuments({ ...taskFilter, status: "pending" }),
      TaskModel.countDocuments({ ...taskFilter, status: "submitted" }),
      TaskModel.countDocuments({ ...taskFilter, status: "in_progress" }),
      role === "ceo" || role === "tech"
        ? User.countDocuments({ isActive: true })
        : 0,
      AuditLog.find(auditFilter)
        .populate("actorId", "name email")
        .populate("documentId", "title")
        .sort({ timestamp: -1 })
        .limit(10),
      role !== "user" && role !== "accountant"
        ? TaskModel.aggregate([
            { $match: { ...taskFilter, "collaborators.0": { $exists: true } } },
            { $unwind: "$collaborators" },
            { $group: { _id: "$assignedTo", asRequester: { $sum: 1 } } },
            { $sort: { asRequester: -1 } },
            { $limit: 5 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
          ])
        : Promise.resolve([]),
      MeetingModel.countDocuments({
        ...meetingFilter,
        status: "scheduled",
        startTime: { $gte: now, $lte: weekAhead },
      }),
      MeetingModel.countDocuments({
        ...meetingFilter,
        startTime: { $gte: now, $lte: weekAhead },
      }),
      MeetingModel.countDocuments({
        ...meetingFilter,
        status: "completed",
        endTime: { $gte: thirtyDaysAgo },
      }),
      MeetingModel.countDocuments({
        ...meetingFilter,
        status: "cancelled",
        updatedAt: { $gte: thirtyDaysAgo },
      }),
      // ceo/tech get the org-wide activity feed unfiltered; everyone
      // else only sees activity for meetings they can actually see.
      role === "ceo" || role === "tech"
        ? Promise.resolve(undefined)
        : MeetingModel.find(meetingFilter).select("_id").limit(500).lean(),
    ]);

    const recentMeetingActivity = await getRecentMeetingActivity(
      10,
      meetingIdsForActivity
        ? (meetingIdsForActivity as { _id: mongoose.Types.ObjectId }[]).map(
            (m) => m._id,
          )
        : undefined,
    );

    // Task efficiency stats (replaces document TAT stats)
    const taskEfficiency = await TaskModel.aggregate([
      {
        $match: {
          ...taskFilter,
          status: "completed",
          efficiencyRatio: { $exists: true },
        },
      },
      {
        $group: {
          _id: null,
          avgEfficiency: { $avg: "$efficiencyRatio" },
          avgTat: { $avg: "$tatMinutes" },
        },
      },
    ]);

    res.json({
      success: true,
      message: "Dashboard stats retrieved",
      data: {
        stats: {
          // Document stats (counts only — no TAT here)
          totalDocs,
          completedDocs,
          inProgressDocs,
          docCompletionRate:
            totalDocs > 0
              ? ((completedDocs / totalDocs) * 100).toFixed(1)
              : "0",
          // Task performance stats (the appraisal dimension)
          totalTasks,
          completedTasks,
          pendingTasks,
          submittedTasks,
          inProgressTasks,
          taskCompletionRate:
            totalTasks > 0
              ? ((completedTasks / totalTasks) * 100).toFixed(1)
              : "0",
          avgTaskEfficiency:
            taskEfficiency[0]?.avgEfficiency?.toFixed(3) ?? "N/A",
          avgTaskTatMinutes: Math.round(taskEfficiency[0]?.avgTat ?? 0),
          // Users (CEO only)
          totalUsers,
          // Meetings & Calendar — automatically populated, nobody
          // logs these numbers by hand (spec: activity should show
          // up in dashboards without manual entry).
          upcomingMeetings,
          meetingsThisWeek,
          completedMeetings,
          cancelledMeetings,
        },
        recentAudit,
        collaborationStats,
        recentMeetingActivity,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// AUDIT TRAIL — server-side search across actor + document
// ─────────────────────────────────────────────────────────────────
export const getAuditTrail = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      documentId,
      actorId,
      action,
      search,
      page = "1",
      limit = "30",
    } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};
    if (documentId)
      filter["documentId"] = new mongoose.Types.ObjectId(documentId);
    if (actorId) filter["actorId"] = new mongoose.Types.ObjectId(actorId);
    if (action) filter["action"] = action;

    if (req.user?.role === "user" || req.user?.role === "accountant") {
      filter["actorId"] = new mongoose.Types.ObjectId(req.user.userId);
    } else if (req.user?.role === "supervisor") {
      // Without this, a supervisor could see the entire company's audit
      // trail (every team's actions) instead of just their own —
      // supervisorIdAtTime captures who supervised the actor when the
      // event happened, which is exactly what every other analytics
      // endpoint scopes by.
      const supId = new mongoose.Types.ObjectId(req.user.userId);
      filter["$or"] = [{ supervisorIdAtTime: supId }, { actorId: supId }];
    }

    if (search) {
      const [matchingUsers, matchingDocs] = await Promise.all([
        User.find({ name: { $regex: search, $options: "i" } }).select("_id"),
        DocumentModel.find({ title: { $regex: search, $options: "i" } }).select(
          "_id",
        ),
      ]);
      filter["$and"] = [
        {
          $or: [
            { actorId: { $in: matchingUsers.map((u) => u._id) } },
            { documentId: { $in: matchingDocs.map((d) => d._id) } },
          ],
        },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate("actorId", "name email role")
        .populate("targetUserId", "name email")
        .populate("documentId", "title")
        .populate("supervisorIdAtTime", "name email")
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number(limit)),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      message: "Audit trail retrieved",
      data: { logs },
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
// COLLABORATION FREQUENCY
// The legacy 'Collaboration' model this used to read from is dead —
// nothing in the app ever writes to it. Real collaboration data lives
// on Task.collaborators now (see taskController's invite/respond/revoke
// flow), so this aggregates that instead.
// ─────────────────────────────────────────────────────────────────
export const getCollaborationFrequency = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const matchStage: Record<string, unknown> = {};
    if (req.user?.role === "supervisor") {
      const mappings = await SupervisorMapping.find({
        supervisorId: req.user!.userId,
        status: "active",
      }).select("subordinateId");
      matchStage["assignedTo"] = { $in: mappings.map((m) => m.subordinateId) };
    }

    const stats = await TaskModel.aggregate([
      { $match: { ...matchStage, "collaborators.0": { $exists: true } } },
      { $unwind: "$collaborators" },
      {
        $facet: {
          // How often each person has invited others to help (regardless of response)
          asRequester: [
            { $group: { _id: "$assignedTo", requestCount: { $sum: 1 } } },
            { $sort: { requestCount: -1 } },
            { $limit: 20 },
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
          ],
          // How often each person has actually accepted and helped
          // (excludes invites that were declined, or revoked before ever
          // being accepted)
          asHelper: [
            {
              $match: {
                "collaborators.respondedAt": { $exists: true },
                "collaborators.status": { $ne: "declined" },
              },
            },
            {
              $group: {
                _id: "$collaborators.userId",
                helperCount: { $sum: 1 },
              },
            },
            { $sort: { helperCount: -1 } },
            { $limit: 20 },
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
          ],
        },
      },
    ]);

    res.json({
      success: true,
      message: "Collaboration frequency retrieved",
      data: { stats: stats[0] },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// EMAIL ANALYTICS
// ─────────────────────────────────────────────────────────────────
export const getEmailAnalytics = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const match =
      req.user?.role === "ceo" || req.user?.role === "tech"
        ? {}
        : { senderId: req.user!.userId };

    const stats = await EmailLog.aggregate([
      { $match: match },

      {
        $facet: {
          statusBreakdown: [{ $group: { _id: "$status", count: { $sum: 1 } } }],

          volumeOverTime: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m", date: "$createdAt" },
                },
                sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],

          topSenders: [
            {
              $group: {
                _id: "$senderId",
                total: { $sum: 1 },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
              },
            },
            { $sort: { total: -1 } },
            { $limit: 10 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
          ],

          failureRate: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
              },
            },
            {
              $project: {
                failureRate: {
                  $divide: ["$failed", "$total"],
                },
              },
            },
          ],
        },
      },
    ]);

    res.json({
      success: true,
      data: stats[0],
    });
  } catch (err) {
    next(err);
  }
};
