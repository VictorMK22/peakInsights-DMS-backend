import mongoose from "mongoose";
import {
  MeetingActivityModel,
  MeetingActivityAction,
} from "../models/MeetingActivity";

/**
 * Writes one automatic activity entry. Fire-and-forget from the
 * caller's perspective — logging a lifecycle event must never fail
 * the request that triggered it, so this swallows its own errors.
 */
export const logMeetingActivity = async (params: {
  meetingId: string | mongoose.Types.ObjectId;
  seriesId?: string | mongoose.Types.ObjectId;
  clientId?: string | mongoose.Types.ObjectId;
  actorId: string | mongoose.Types.ObjectId;
  action: MeetingActivityAction;
  message: string;
  details?: Record<string, unknown>;
}): Promise<void> => {
  try {
    await MeetingActivityModel.create({
      meetingId: params.meetingId,
      seriesId: params.seriesId,
      clientId: params.clientId,
      actorId: params.actorId,
      action: params.action,
      message: params.message,
      details: params.details,
    });
  } catch (err) {
    console.error("Failed to log meeting activity:", err);
  }
};

/** Full activity history for one meeting, oldest first (reads like a log). */
export const getMeetingActivity = async (meetingId: string) => {
  return MeetingActivityModel.find({ meetingId })
    .populate("actorId", "name email role")
    .sort({ timestamp: 1 })
    .lean();
};

/**
 * A client's automatically-generated activity timeline — every
 * meeting lifecycle event tied to that client, newest first. This is
 * what makes "the meeting automatically appears in the client's
 * activity timeline" true without anyone hand-entering it.
 */
export const getClientMeetingActivity = async (
  clientId: string,
  limit = 100,
) => {
  return MeetingActivityModel.find({ clientId })
    .populate("actorId", "name email role")
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

/** Org-wide recent activity feed, for dashboards/reports. Pass
 * `meetingIds` to scope it to a role-visible subset of meetings
 * instead of the whole organization (e.g. a supervisor's team). */
export const getRecentMeetingActivity = async (
  limit = 50,
  meetingIds?: mongoose.Types.ObjectId[] | string[],
) => {
  const filter = meetingIds ? { meetingId: { $in: meetingIds } } : {};
  return MeetingActivityModel.find(filter)
    .populate("actorId", "name email role")
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};
