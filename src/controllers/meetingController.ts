import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { MeetingModel, IMeeting, RsvpStatus } from "../models/Meeting";
import { MeetingAttendanceModel } from "../models/MeetingAttendance";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { createNotification } from "../services/notificationService";
import {
  checkConflicts,
  suggestAvailableSlots,
  expandRecurrence,
  newSeriesId,
  RecurrenceRuleInput,
} from "../services/calendarService";
import {
  sendMeetingInviteEmail,
  sendMeetingUpdatedEmail,
  sendMeetingCancelledEmail,
} from "../services/emailService";
import {
  logMeetingActivity,
  getMeetingActivity,
} from "../services/meetingActivityService";
import {
  ensureRoom,
  deleteRoom,
  createParticipantToken,
  startRoomRecording,
  stopRoomRecording,
  setPresenter,
  createBreakoutRooms,
  closeBreakoutRooms,
} from "../services/livekitService";
import { isLivekitConfigured } from "../config/livekit";
import { getSignedFileUrl } from "../services/s3Storage";

// A recurring series is capped so "invite everyone, repeat forever"
// can't silently generate an unbounded number of documents — see
// calendarService.expandRecurrence for the actual cap.
const MAX_RECURRING_OCCURRENCES = 52;

const idOf = (v: unknown): string =>
  v && typeof v === "object" && "_id" in (v as any)
    ? String((v as any)._id)
    : String(v);

const populateMeeting = (query: any) =>
  query
    .populate("organizer", "name email role")
    .populate("attendees.userId", "name email role")
    .populate("clientId", "name company");

const canManageMeeting = (meeting: { organizer: unknown }, userId: string) =>
  idOf(meeting.organizer) === userId;

const isParticipant = (
  meeting: { organizer: unknown; attendees: { userId: unknown }[] },
  userId: string,
) =>
  idOf(meeting.organizer) === userId ||
  meeting.attendees.some((a) => idOf(a.userId) === userId);

/**
 * Resolves the final, deduplicated set of attendee user IDs an
 * organizer is allowed to invite, expanding any department/org-wide
 * targeting requested (CEO/tech only) and enforcing the
 * supervisor-can-only-invite-their-team rule.
 */
const resolveAttendeeIds = async (
  role: string,
  actorId: string,
  requestedAttendeeIds: string[],
  targetDepartments: string[],
  organizationWide: boolean,
): Promise<{ ids: string[]; error?: string }> => {
  const ids = new Set<string>(requestedAttendeeIds.filter(Boolean));

  const isElevated = role === "ceo" || role === "tech";

  if ((targetDepartments.length > 0 || organizationWide) && !isElevated) {
    return {
      ids: [],
      error:
        "Only the CEO or an administrator can schedule department-wide or organization-wide meetings",
    };
  }

  if (organizationWide) {
    const everyone = await User.find({ isActive: true, _id: { $ne: actorId } })
      .select("_id")
      .lean();
    everyone.forEach((u) => ids.add(String(u._id)));
  } else if (targetDepartments.length > 0) {
    const members = await User.find({
      isActive: true,
      department: { $in: targetDepartments },
      _id: { $ne: actorId },
    })
      .select("_id")
      .lean();
    members.forEach((u) => ids.add(String(u._id)));
  }

  if (role === "supervisor" && ids.size > 0) {
    const mappings = await SupervisorMapping.find({
      supervisorId: actorId,
      status: "active",
    }).select("subordinateId");
    const teamIds = new Set(mappings.map((m) => String(m.subordinateId)));
    const disallowed = [...ids].filter((id) => !teamIds.has(id));
    if (disallowed.length > 0) {
      return {
        ids: [],
        error:
          "As a supervisor you can only invite members of your own team to meetings",
      };
    }
  }

  ids.delete(actorId); // organizer is implicit, not a listed attendee
  return { ids: [...ids] };
};

// ─────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────
export const createMeeting = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const actorId = req.user!.userId;
    const role = req.user!.role;

    const {
      title,
      description,
      agenda,
      startTime,
      endTime,
      location,
      meetingLink,
      isVirtual = false,
      recordingEnabled = false,
      attendeeIds = [],
      targetDepartments = [],
      organizationWide = false,
      recurrence,
      reminderMinutesBefore,
      clientId,
      externalAttendees = [],
      force = false,
    } = req.body as {
      title: string;
      description?: string;
      agenda?: string;
      startTime: string;
      endTime: string;
      location?: string;
      meetingLink?: string;
      isVirtual?: boolean;
      recordingEnabled?: boolean;
      attendeeIds?: string[];
      targetDepartments?: string[];
      organizationWide?: boolean;
      recurrence?: RecurrenceRuleInput;
      reminderMinutesBefore?: number;
      clientId?: string;
      externalAttendees?: { email: string; name?: string }[];
      force?: boolean;
    };

    const cleanExternalAttendees = externalAttendees
      .filter((e) => e && typeof e.email === "string" && e.email.includes("@"))
      .map((e) => ({
        email: e.email.trim().toLowerCase(),
        name: e.name?.trim(),
      }));

    if (!title || !startTime || !endTime) {
      res.status(400).json({
        success: false,
        message: "title, startTime and endTime are required",
      });
      return;
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      res.status(400).json({
        success: false,
        message: "endTime must be after startTime",
      });
      return;
    }

    const { ids: resolvedAttendeeIds, error } = await resolveAttendeeIds(
      role,
      actorId,
      attendeeIds,
      targetDepartments,
      organizationWide,
    );
    if (error) {
      res.status(403).json({ success: false, message: error });
      return;
    }

    // ── Conflict check ────────────────────────────────────────────
    // Always check the organizer too — they shouldn't double-book
    // themselves either.
    const participantIds = [actorId, ...resolvedAttendeeIds];
    const conflicts = await checkConflicts(participantIds, start, end);

    if (conflicts.length > 0 && !force) {
      const suggestions = await suggestAvailableSlots(
        participantIds,
        Math.round((end.getTime() - start.getTime()) / 60_000),
        start,
      );
      res.status(409).json({
        success: false,
        message: "One or more participants have a scheduling conflict",
        data: { conflicts, suggestions },
      });
      return;
    }

    // ── Recurrence expansion ────────────────────────────────────
    const rule = recurrence ?? { frequency: "none" as const };
    const occurrences = expandRecurrence(start, end, rule);
    const isSeries = rule.frequency && rule.frequency !== "none";
    const seriesId = isSeries ? newSeriesId() : undefined;

    const attendeesSubdoc = resolvedAttendeeIds.map((userId) => ({
      userId: new mongoose.Types.ObjectId(userId),
      status: "pending" as RsvpStatus,
      invitedAt: new Date(),
    }));

    const docs = occurrences
      .slice(0, MAX_RECURRING_OCCURRENCES)
      .map((occ, index) => ({
        title,
        description,
        agenda,
        organizer: new mongoose.Types.ObjectId(actorId),
        attendees: attendeesSubdoc,
        externalAttendees: cleanExternalAttendees,
        startTime: occ.startTime,
        endTime: occ.endTime,
        location,
        meetingLink,
        isVirtual: Boolean(isVirtual),
        recordingEnabled: Boolean(isVirtual && recordingEnabled),
        status: "scheduled" as const,
        recurrence: {
          frequency: rule.frequency ?? "none",
          interval: rule.interval ?? 1,
          daysOfWeek: rule.daysOfWeek ?? [],
          endDate: rule.endDate ? new Date(rule.endDate) : undefined,
          count: rule.count,
        },
        seriesId,
        isRecurringInstance: Boolean(isSeries),
        occurrenceIndex: isSeries ? index : undefined,
        targetDepartments,
        organizationWide,
        reminderMinutesBefore: reminderMinutesBefore ?? 15,
        reminderSent: false,
        clientId: clientId ? new mongoose.Types.ObjectId(clientId) : undefined,
      }));

    const created = await MeetingModel.insertMany(docs);

    const organizerUser = await User.findById(actorId)
      .select("name email")
      .lean();
    const firstMeeting = created[0];

    // Notify each invited attendee once (about the first occurrence —
    // avoids spamming N notifications for an N-occurrence series).
    await Promise.all(
      resolvedAttendeeIds.map((userId) =>
        createNotification(
          userId,
          `${organizerUser?.name ?? "Someone"} invited you to "${title}"${
            isSeries ? " (recurring)" : ""
          } on ${start.toLocaleString()}`,
          "meeting_invite",
          {
            meetingId: String(firstMeeting._id),
            seriesId: seriesId ? String(seriesId) : undefined,
            title,
            startTime: start,
            endTime: end,
            organizerName: organizerUser?.name,
          },
        ),
      ),
    );

    // Email invitations — internal attendees (by their account email)
    // and any external, non-system-user attendees invited by address.
    // Never blocks the response: a slow/misconfigured SMTP server
    // shouldn't stop the meeting from being created.
    (async () => {
      const invitedUsers = await User.find({
        _id: { $in: resolvedAttendeeIds },
      })
        .select("name email")
        .lean();
      const recipients = [
        ...invitedUsers
          .filter((u) => u.email)
          .map((u) => ({
            toEmail: u.email as string,
            toName: u.name,
            isExternal: false,
          })),
        ...cleanExternalAttendees.map((e) => ({
          toEmail: e.email,
          toName: e.name ?? e.email,
          isExternal: true,
        })),
      ];
      await Promise.all(
        recipients.map((r) =>
          sendMeetingInviteEmail({
            toEmail: r.toEmail,
            toName: r.toName,
            meetingId: String(firstMeeting._id),
            title,
            organizerName: organizerUser?.name ?? "A colleague",
            startTime: start,
            endTime: end,
            location,
            meetingLink,
            isRecurring: Boolean(isSeries),
            isExternal: r.isExternal,
          }),
        ),
      );
    })().catch((err) =>
      console.error("Meeting invite email batch failed:", err),
    );

    // Automatic activity trail (spec: meetings should never require
    // manual logging — every lifecycle event writes itself here).
    await logMeetingActivity({
      meetingId: firstMeeting._id,
      seriesId,
      clientId: clientId || undefined,
      actorId,
      action: "meeting_created",
      message: `${organizerUser?.name ?? "Someone"} scheduled "${title}"${
        isSeries ? ` (recurring, ${created.length} occurrence(s))` : ""
      } for ${start.toLocaleString()}`,
      details: {
        attendeeCount: resolvedAttendeeIds.length,
        externalAttendeeCount: cleanExternalAttendees.length,
      },
    });
    if (resolvedAttendeeIds.length > 0 || cleanExternalAttendees.length > 0) {
      await logMeetingActivity({
        meetingId: firstMeeting._id,
        seriesId,
        clientId: clientId || undefined,
        actorId,
        action: "invitation_sent",
        message: `Invitations sent to ${resolvedAttendeeIds.length + cleanExternalAttendees.length} participant(s)`,
      });
    }

    const populated = await populateMeeting(
      MeetingModel.findById(firstMeeting._id),
    );

    res.status(201).json({
      success: true,
      message:
        created.length > 1
          ? `Meeting series created (${created.length} occurrences)`
          : "Meeting created",
      data: { meeting: populated, occurrenceCount: created.length },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// JOIN — mints a LiveKit access token for the built-in video call.
// The LiveKit room itself is provisioned lazily here (not at
// createMeeting time) so a 52-occurrence recurring series doesn't
// create 52 empty rooms up front — only the ones people actually
// join. Attendance and "meeting started" activity are then driven
// automatically off LiveKit's webhooks, not from this endpoint.
// ─────────────────────────────────────────────────────────────────
export const getJoinToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!isLivekitConfigured) {
      res.status(503).json({
        success: false,
        message: "Video calling is not configured on this server",
      });
      return;
    }

    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    if (!meeting.isVirtual) {
      res.status(400).json({
        success: false,
        message: "This meeting doesn't have a built-in video call",
      });
      return;
    }
    if (meeting.status !== "scheduled") {
      res.status(400).json({
        success: false,
        message: `Can't join a meeting that is ${meeting.status}`,
      });
      return;
    }

    const actorId = req.user!.userId;
    const role = req.user!.role;
    const isHost = idOf(meeting.organizer) === actorId;
    if (
      !isHost &&
      role !== "ceo" &&
      role !== "tech" &&
      !isParticipant(meeting as unknown as IMeeting, actorId)
    ) {
      res
        .status(403)
        .json({ success: false, message: "You are not part of this meeting" });
      return;
    }

    await ensureRoom({
      meetingId: meeting._id,
      title: meeting.title,
      recordingEnabled: meeting.recordingEnabled,
    });

    if (meeting.recordingEnabled && !meeting.recordingEgressId) {
      // Atomic claim: only the request that actually flips this filter
      // from "no egress yet" to "starting" gets to call LiveKit — a
      // second simultaneous joiner's update matches zero documents and
      // claimed comes back null, so recording only ever starts once.
      const claimed = await MeetingModel.findOneAndUpdate(
        { _id: meeting._id, recordingEgressId: { $exists: false } },
        { $set: { recordingStatus: "starting" } },
      );
      if (claimed) {
        try {
          const { egressId, s3Key } = await startRoomRecording({
            meetingId: meeting._id,
          });
          await MeetingModel.findByIdAndUpdate(meeting._id, {
            recordingEgressId: egressId,
            recordingS3Key: s3Key,
            recordingStatus: "recording",
          });
        } catch (err) {
          console.error("Failed to start meeting recording:", err);
          await MeetingModel.findByIdAndUpdate(meeting._id, {
            recordingStatus: "failed",
          });
        }
      }
    }

    const actorUser = await User.findById(actorId).select("name").lean();
    const { token, wsUrl, roomName } = await createParticipantToken({
      meetingId: meeting._id,
      identity: actorId,
      name: actorUser?.name ?? "Participant",
      isHost,
    });

    res.json({
      success: true,
      message: "Join token issued",
      data: { token, wsUrl, roomName, isHost },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// PRESENTER TRANSFER — host-only. Grants screen-share rights to one
// participant at a time (everyone's join token restricts it by
// default — see livekitService.createParticipantToken) and revokes
// it from whoever had it before. Pass the host's own identity to
// hand presenting back to the host.
// ─────────────────────────────────────────────────────────────────
export const transferPresenter = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!isLivekitConfigured) {
      res.status(503).json({
        success: false,
        message: "Video calling is not configured on this server",
      });
      return;
    }
    const { identity } = req.body as { identity?: string };
    if (!identity) {
      res.status(400).json({ success: false, message: "identity is required" });
      return;
    }

    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const actorId = req.user!.userId;
    const role = req.user!.role;
    const isHost = idOf(meeting.organizer) === actorId;
    if (!isHost && role !== "ceo" && role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the organizer can transfer the presenter role",
      });
      return;
    }
    // A non-organizer ceo/tech acting here still needs *a* host
    // identity to exempt from revocation — the organizer's is the
    // right one, since that's whose token was minted with permanent
    // screen-share rights.
    await setPresenter({
      meetingId: meeting._id,
      presenterIdentity: identity,
      hostIdentity: idOf(meeting.organizer),
    });

    res.json({ success: true, message: "Presenter updated", data: {} });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// BREAKOUT ROOMS — host-only. Auto-splits everyone currently in the
// call (except the host) evenly across N breakout rooms and pushes
// each participant a move signal over LiveKit's data channel; see
// components/meetings/LiveCallRoom.tsx on the frontend for the
// listener that actually performs the reconnect.
// ─────────────────────────────────────────────────────────────────
export const startBreakoutRooms = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!isLivekitConfigured) {
      res.status(503).json({
        success: false,
        message: "Video calling is not configured on this server",
      });
      return;
    }
    const { count } = req.body as { count?: number };
    if (!count || count < 2 || count > 20) {
      res.status(400).json({
        success: false,
        message: "count must be between 2 and 20",
      });
      return;
    }

    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const actorId = req.user!.userId;
    const role = req.user!.role;
    const isHost = idOf(meeting.organizer) === actorId;
    if (!isHost && role !== "ceo" && role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the organizer can start breakout rooms",
      });
      return;
    }

    const result = await createBreakoutRooms({
      meetingId: meeting._id,
      hostIdentity: idOf(meeting.organizer),
      count,
    });

    res.json({
      success: true,
      message: "Breakout rooms created",
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

export const endBreakoutRooms = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!isLivekitConfigured) {
      res.status(503).json({
        success: false,
        message: "Video calling is not configured on this server",
      });
      return;
    }
    const { count } = req.body as { count?: number };
    if (!count || count < 2 || count > 20) {
      res.status(400).json({
        success: false,
        message: "count must be between 2 and 20",
      });
      return;
    }

    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const actorId = req.user!.userId;
    const role = req.user!.role;
    const isHost = idOf(meeting.organizer) === actorId;
    if (!isHost && role !== "ceo" && role !== "tech") {
      res.status(403).json({
        success: false,
        message: "Only the organizer can end breakout rooms",
      });
      return;
    }

    await closeBreakoutRooms({ meetingId: meeting._id, count });

    res.json({ success: true, message: "Breakout rooms closed", data: {} });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// CHECK AVAILABILITY (used live by the create/edit form, no meeting
// is created — just returns conflicts + suggested alternative slots)
// ─────────────────────────────────────────────────────────────────
export const checkAvailability = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      attendeeIds = [],
      startTime,
      endTime,
      excludeMeetingId,
    } = req.body as {
      attendeeIds: string[];
      startTime: string;
      endTime: string;
      excludeMeetingId?: string;
    };

    if (!startTime || !endTime) {
      res.status(400).json({
        success: false,
        message: "startTime and endTime are required",
      });
      return;
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    const participantIds = [...new Set([req.user!.userId, ...attendeeIds])];

    const conflicts = await checkConflicts(
      participantIds,
      start,
      end,
      excludeMeetingId,
    );

    const suggestions =
      conflicts.length > 0
        ? await suggestAvailableSlots(
            participantIds,
            Math.round((end.getTime() - start.getTime()) / 60_000),
            start,
          )
        : [];

    res.json({
      success: true,
      message:
        conflicts.length > 0
          ? "Conflicts found"
          : "All participants are available",
      data: { conflicts, suggestions, hasConflicts: conflicts.length > 0 },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// READ — calendar range view (mine as organizer + invited)
// ─────────────────────────────────────────────────────────────────
export const getMeetings = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { from, to, status, mine, clientId } = req.query as Record<
      string,
      string
    >;

    const filter: Record<string, unknown> = {};

    if (clientId) {
      // Scoped lookup for a client's auto-synced meetings (CRM
      // integration). Anyone who can see the client record should be
      // able to see its meetings — sales/CEO/tech get the full list;
      // everyone else only sees client meetings they're actually on.
      const role = req.user!.role;
      const isClientFacingRole =
        role === "ceo" || role === "tech" || role === "sales_person";
      filter["clientId"] = clientId;
      if (!isClientFacingRole) {
        filter["$or"] = [{ organizer: userId }, { "attendees.userId": userId }];
      }
    } else if (mine === "true") {
      // Explicit "just show me mine" override — available to everyone
      // regardless of role, since even a CEO sometimes wants their own
      // agenda instead of the whole org's.
      filter["organizer"] = userId;
    } else {
      // Default calendar visibility, matching the same rule used by
      // getMeeting (single) and analyticsController's meetingFilter:
      // ceo/tech see the organisation's full calendar, a supervisor
      // additionally sees their team's meetings, everyone else sees
      // only what they organize or are invited to.
      const role = req.user!.role;
      if (role === "ceo" || role === "tech") {
        // No filter — full org visibility.
      } else if (role === "supervisor") {
        const mappings = await SupervisorMapping.find({
          supervisorId: userId,
          status: "active",
        }).select("subordinateId");
        const ids = [
          ...mappings.map((m) => m.subordinateId),
          new mongoose.Types.ObjectId(userId),
        ];
        filter["$or"] = [
          { organizer: { $in: ids } },
          { "attendees.userId": { $in: ids } },
        ];
      } else {
        filter["$or"] = [{ organizer: userId }, { "attendees.userId": userId }];
      }
    }

    // A meeting is "in range" if it starts before `to` and ends after
    // `from` — overlap semantics, not strict containment, so a
    // multi-day or long meeting that merely spans into the visible
    // window still shows up.
    if (to) filter["startTime"] = { $lt: new Date(to) };
    if (from) filter["endTime"] = { $gt: new Date(from) };

    if (status) filter["status"] = status;

    const meetings = await populateMeeting(
      MeetingModel.find(filter).sort({ startTime: 1 }),
    );

    res.json({
      success: true,
      message: "Meetings retrieved",
      data: { meetings },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// READ — single meeting
// ─────────────────────────────────────────────────────────────────
export const getMeeting = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const meeting = await populateMeeting(MeetingModel.findById(req.params.id));
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const role = req.user!.role;
    if (
      role !== "ceo" &&
      role !== "tech" &&
      !isParticipant(meeting as unknown as IMeeting, req.user!.userId)
    ) {
      res
        .status(403)
        .json({ success: false, message: "You are not part of this meeting" });
      return;
    }
    res.json({
      success: true,
      message: "Meeting retrieved",
      data: { meeting },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// UPDATE — organizer only. Re-checks conflicts if time/attendees change.
// ─────────────────────────────────────────────────────────────────
export const updateMeeting = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const role = req.user!.role;
    if (
      !canManageMeeting(meeting, req.user!.userId) &&
      role !== "ceo" &&
      role !== "tech"
    ) {
      res.status(403).json({
        success: false,
        message: "Only the organizer can edit this meeting",
      });
      return;
    }

    const {
      title,
      description,
      agenda,
      startTime,
      endTime,
      location,
      meetingLink,
      isVirtual,
      recordingEnabled,
      attendeeIds,
      reminderMinutesBefore,
      force = false,
    } = req.body as {
      title?: string;
      description?: string;
      agenda?: string;
      startTime?: string;
      endTime?: string;
      location?: string;
      meetingLink?: string;
      isVirtual?: boolean;
      recordingEnabled?: boolean;
      attendeeIds?: string[];
      reminderMinutesBefore?: number;
      force?: boolean;
    };

    const newStart = startTime ? new Date(startTime) : meeting.startTime;
    const newEnd = endTime ? new Date(endTime) : meeting.endTime;
    if (newEnd <= newStart) {
      res
        .status(400)
        .json({ success: false, message: "endTime must be after startTime" });
      return;
    }

    const timeChanged =
      newStart.getTime() !== meeting.startTime.getTime() ||
      newEnd.getTime() !== meeting.endTime.getTime();
    const currentAttendeeIds = meeting.attendees.map((a) => idOf(a.userId));
    const nextAttendeeIds = attendeeIds ?? currentAttendeeIds;
    const attendeesChanged =
      JSON.stringify([...nextAttendeeIds].sort()) !==
      JSON.stringify([...currentAttendeeIds].sort());

    if (timeChanged || attendeesChanged) {
      const participantIds = [idOf(meeting.organizer), ...nextAttendeeIds];
      const conflicts = await checkConflicts(
        participantIds,
        newStart,
        newEnd,
        String(meeting._id),
      );
      if (conflicts.length > 0 && !force) {
        const suggestions = await suggestAvailableSlots(
          participantIds,
          Math.round((newEnd.getTime() - newStart.getTime()) / 60_000),
          newStart,
        );
        res.status(409).json({
          success: false,
          message: "One or more participants have a scheduling conflict",
          data: { conflicts, suggestions },
        });
        return;
      }
    }

    const newlyAdded = nextAttendeeIds.filter(
      (id) => !currentAttendeeIds.includes(id),
    );

    if (title !== undefined) meeting.title = title;
    if (description !== undefined) meeting.description = description;
    if (agenda !== undefined) meeting.agenda = agenda;
    if (location !== undefined) meeting.location = location;
    if (meetingLink !== undefined) meeting.meetingLink = meetingLink;
    if (isVirtual !== undefined) meeting.isVirtual = isVirtual;
    if (recordingEnabled !== undefined)
      meeting.recordingEnabled = meeting.isVirtual && recordingEnabled;
    if (reminderMinutesBefore !== undefined)
      meeting.reminderMinutesBefore = reminderMinutesBefore;
    meeting.startTime = newStart;
    meeting.endTime = newEnd;

    if (attendeeIds) {
      meeting.attendees = nextAttendeeIds.map((userId) => {
        const existing = meeting.attendees.find(
          (a) => idOf(a.userId) === userId,
        );
        return (
          existing ?? {
            userId: new mongoose.Types.ObjectId(userId),
            status: "pending" as RsvpStatus,
            invitedAt: new Date(),
          }
        );
      });
    }

    // Any material change resets RSVPs to pending for existing
    // attendees who had already responded, since the meeting they
    // agreed to may no longer be the meeting on offer — except newly
    // added attendees, who are already 'pending' by default.
    if (timeChanged) {
      meeting.attendees.forEach((a) => {
        if (!newlyAdded.includes(idOf(a.userId))) {
          a.status = "pending";
          a.respondedAt = undefined;
        }
      });
      meeting.reminderSent = false;
    }

    await meeting.save();

    const organizerUser = await User.findById(meeting.organizer)
      .select("name email")
      .lean();
    const notifyIds = meeting.attendees.map((a) => idOf(a.userId));
    await Promise.all(
      notifyIds.map((userId) =>
        createNotification(
          userId,
          `${organizerUser?.name ?? "The organizer"} updated the meeting "${meeting.title}"`,
          "meeting_updated",
          {
            meetingId: String(meeting._id),
            title: meeting.title,
            startTime: meeting.startTime,
          },
        ),
      ),
    );

    // Email the update to everyone still on the meeting — internal
    // attendees plus any external (email-only) invitees. Fire-and-forget.
    (async () => {
      const invitedUsers = await User.find({ _id: { $in: notifyIds } })
        .select("name email")
        .lean();
      const recipients = [
        ...invitedUsers
          .filter((u) => u.email)
          .map((u) => ({ toEmail: u.email as string, toName: u.name })),
        ...meeting.externalAttendees.map((e) => ({
          toEmail: e.email,
          toName: e.name ?? e.email,
        })),
      ];
      await Promise.all(
        recipients.map((r) =>
          sendMeetingUpdatedEmail({
            toEmail: r.toEmail,
            toName: r.toName,
            meetingId: String(meeting._id),
            title: meeting.title,
            organizerName: organizerUser?.name ?? "A colleague",
            startTime: meeting.startTime,
            endTime: meeting.endTime,
            location: meeting.location,
            meetingLink: meeting.meetingLink,
          }),
        ),
      );
    })().catch((err) =>
      console.error("Meeting update email batch failed:", err),
    );

    await logMeetingActivity({
      meetingId: meeting._id,
      seriesId: meeting.seriesId,
      clientId: meeting.clientId,
      actorId: req.user!.userId,
      action: timeChanged ? "meeting_rescheduled" : "meeting_updated",
      message: timeChanged
        ? `${organizerUser?.name ?? "The organizer"} rescheduled "${meeting.title}" to ${meeting.startTime.toLocaleString()}`
        : `${organizerUser?.name ?? "The organizer"} updated "${meeting.title}"`,
    });

    const populated = await populateMeeting(MeetingModel.findById(meeting._id));
    res.json({
      success: true,
      message: "Meeting updated",
      data: { meeting: populated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// CANCEL — organizer only
// ─────────────────────────────────────────────────────────────────
export const cancelMeeting = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const role = req.user!.role;
    if (
      !canManageMeeting(meeting, req.user!.userId) &&
      role !== "ceo" &&
      role !== "tech"
    ) {
      res.status(403).json({
        success: false,
        message: "Only the organizer can cancel this meeting",
      });
      return;
    }

    const { reason, cancelSeries = false } = req.body as {
      reason?: string;
      cancelSeries?: boolean;
    };

    const targets =
      cancelSeries && meeting.seriesId
        ? await MeetingModel.find({
            seriesId: meeting.seriesId,
            status: "scheduled",
            startTime: { $gte: new Date() },
          })
        : [meeting];

    await Promise.all(
      targets.map((m) => {
        m.status = "cancelled";
        m.cancellationReason = reason;
        return m.save();
      }),
    );

    if (isLivekitConfigured) {
      // Best-effort — a room only exists if someone had already
      // joined it, and a stray room auto-closes via emptyTimeout
      // anyway, so failures here are logged and ignored.
      Promise.all(
        targets.filter((m) => m.isVirtual).map((m) => deleteRoom(m._id)),
      ).catch((err) =>
        console.error("LiveKit room cleanup on cancel failed:", err),
      );
      Promise.all(
        targets
          .filter(
            (m) => m.recordingStatus === "recording" && m.recordingEgressId,
          )
          .map((m) => stopRoomRecording(m.recordingEgressId!)),
      ).catch((err) =>
        console.error("LiveKit recording cleanup on cancel failed:", err),
      );
    }

    const organizerUser = await User.findById(meeting.organizer)
      .select("name email")
      .lean();
    const notifyIds = meeting.attendees.map((a) => idOf(a.userId));
    await Promise.all(
      notifyIds.map((userId) =>
        createNotification(
          userId,
          `${organizerUser?.name ?? "The organizer"} cancelled the meeting "${meeting.title}"${
            cancelSeries ? " (and its remaining occurrences)" : ""
          }`,
          "meeting_cancelled",
          { meetingId: String(meeting._id), title: meeting.title, reason },
        ),
      ),
    );

    // Cancellation emails — internal + external attendees. Fire-and-forget.
    (async () => {
      const invitedUsers = await User.find({ _id: { $in: notifyIds } })
        .select("name email")
        .lean();
      const recipients = [
        ...invitedUsers
          .filter((u) => u.email)
          .map((u) => ({ toEmail: u.email as string, toName: u.name })),
        ...meeting.externalAttendees.map((e) => ({
          toEmail: e.email,
          toName: e.name ?? e.email,
        })),
      ];
      await Promise.all(
        recipients.map((r) =>
          sendMeetingCancelledEmail({
            toEmail: r.toEmail,
            toName: r.toName,
            meetingId: String(meeting._id),
            title: meeting.title,
            organizerName: organizerUser?.name ?? "A colleague",
            startTime: meeting.startTime,
            endTime: meeting.endTime,
            reason,
          }),
        ),
      );
    })().catch((err) =>
      console.error("Meeting cancellation email batch failed:", err),
    );

    await Promise.all(
      targets.map((m) =>
        logMeetingActivity({
          meetingId: m._id,
          seriesId: m.seriesId,
          clientId: m.clientId,
          actorId: req.user!.userId,
          action: "meeting_cancelled",
          message: `${organizerUser?.name ?? "The organizer"} cancelled "${m.title}"${reason ? ` — ${reason}` : ""}`,
          details: { reason },
        }),
      ),
    );

    res.json({
      success: true,
      message: cancelSeries
        ? `Cancelled ${targets.length} occurrence(s)`
        : "Meeting cancelled",
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// RSVP — invited attendee responds
// ─────────────────────────────────────────────────────────────────
export const respondToMeeting = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { status } = req.body as { status: RsvpStatus };
    if (!["accepted", "declined", "tentative"].includes(status)) {
      res.status(400).json({
        success: false,
        message: "status must be one of: accepted, declined, tentative",
      });
      return;
    }

    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }

    const attendee = meeting.attendees.find(
      (a) => idOf(a.userId) === req.user!.userId,
    );
    if (!attendee) {
      res.status(403).json({
        success: false,
        message: "You were not invited to this meeting",
      });
      return;
    }

    attendee.status = status;
    attendee.respondedAt = new Date();
    await meeting.save();

    const responder = await User.findById(req.user!.userId)
      .select("name")
      .lean();
    await createNotification(
      idOf(meeting.organizer),
      `${responder?.name ?? "A participant"} ${status} the invite for "${meeting.title}"`,
      "meeting_response",
      {
        meetingId: String(meeting._id),
        status,
        respondentName: responder?.name,
      },
    );

    const populated = await populateMeeting(MeetingModel.findById(meeting._id));

    const activityAction =
      status === "accepted"
        ? "participant_accepted"
        : status === "declined"
          ? "participant_declined"
          : "participant_tentative";
    await logMeetingActivity({
      meetingId: meeting._id,
      seriesId: meeting.seriesId,
      clientId: meeting.clientId,
      actorId: req.user!.userId,
      action: activityAction,
      message: `${responder?.name ?? "A participant"} ${status} the invite for "${meeting.title}"`,
    });

    res.json({
      success: true,
      message: "Response recorded",
      data: { meeting: populated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// CRON — reminder sweep (see routes/cron.ts / middleware/cronAuth.ts
// for the external-scheduler auth pattern this follows)
// ─────────────────────────────────────────────────────────────────
export const runMeetingReminderSweep = async (): Promise<{ sent: number }> => {
  const now = new Date();
  const upcoming = await MeetingModel.find({
    status: "scheduled",
    reminderSent: false,
    startTime: { $gt: now },
  })
    .select("title startTime organizer attendees reminderMinutesBefore")
    .lean();

  const due = upcoming.filter((m) => {
    const msUntilStart = m.startTime.getTime() - now.getTime();
    return msUntilStart <= m.reminderMinutesBefore * 60_000;
  });

  let sent = 0;
  for (const meeting of due) {
    const recipientIds = [
      idOf(meeting.organizer),
      ...meeting.attendees
        .filter((a) => a.status !== "declined")
        .map((a) => idOf(a.userId)),
    ];
    await Promise.all(
      [...new Set(recipientIds)].map((userId) =>
        createNotification(
          userId,
          `Reminder: "${meeting.title}" starts at ${meeting.startTime.toLocaleTimeString(
            [],
            {
              hour: "2-digit",
              minute: "2-digit",
            },
          )}`,
          "meeting_reminder",
          {
            meetingId: String(meeting._id),
            title: meeting.title,
            startTime: meeting.startTime,
          },
        ),
      ),
    );
    await MeetingModel.updateOne({ _id: meeting._id }, { reminderSent: true });
    sent += 1;
  }

  return { sent };
};

// ─────────────────────────────────────────────────────────────────
// CRON — auto-complete sweep. A meeting that has ended is marked
// "completed" without anyone having to close it out by hand — this
// is what makes "Meeting Completed" show up automatically in
// activity/reporting instead of meetings just sitting in "scheduled"
// forever. Called alongside the reminder sweep (see cronController).
// ─────────────────────────────────────────────────────────────────
export const runMeetingAutoCompleteSweep = async (): Promise<{
  completed: number;
}> => {
  const now = new Date();
  const ended = await MeetingModel.find({
    status: "scheduled",
    endTime: { $lte: now },
  })
    .select("title organizer seriesId clientId")
    .lean();

  if (ended.length === 0) return { completed: 0 };

  await MeetingModel.updateMany(
    { _id: { $in: ended.map((m) => m._id) } },
    { status: "completed" },
  );

  await Promise.all(
    ended.map((m) =>
      logMeetingActivity({
        meetingId: m._id,
        seriesId: m.seriesId,
        clientId: m.clientId,
        actorId: m.organizer,
        action: "meeting_completed",
        message: `"${m.title}" completed`,
      }),
    ),
  );

  return { completed: ended.length };
};

// ─────────────────────────────────────────────────────────────────
// READ — a single meeting's automatic activity history (who did
// what, and when — the "no manual logging" audit trail from creation
// through every RSVP, edit, and cancellation).
// ─────────────────────────────────────────────────────────────────
export const getMeetingActivityHistory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const role = req.user!.role;
    if (
      role !== "ceo" &&
      role !== "tech" &&
      !isParticipant(meeting as unknown as IMeeting, req.user!.userId)
    ) {
      res
        .status(403)
        .json({ success: false, message: "You are not part of this meeting" });
      return;
    }
    const activity = await getMeetingActivity(String(meeting._id));
    res.json({
      success: true,
      message: "Activity retrieved",
      data: { activity },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// ATTENDANCE — reads the join/leave rows LiveKit's webhooks wrote
// automatically (see services/livekitService.handleLivekitWebhookEvent)
// and rolls them up into one entry per participant: total time in
// the call, every join/leave session, and whether they're in the
// call right now. Nobody ever marks this by hand.
// ─────────────────────────────────────────────────────────────────
export const getMeetingAttendance = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const role = req.user!.role;
    if (
      role !== "ceo" &&
      role !== "tech" &&
      !isParticipant(meeting as unknown as IMeeting, req.user!.userId)
    ) {
      res
        .status(403)
        .json({ success: false, message: "You are not part of this meeting" });
      return;
    }

    const rows = await MeetingAttendanceModel.find({ meetingId: meeting._id })
      .sort({ joinedAt: 1 })
      .lean();

    const now = Date.now();
    const byIdentity = new Map<
      string,
      {
        identity: string;
        userId?: string;
        name: string;
        totalSeconds: number;
        currentlyInCall: boolean;
        sessions: {
          joinedAt: Date;
          leftAt?: Date;
          durationSeconds: number;
        }[];
      }
    >();

    for (const row of rows) {
      const key = row.identity;
      const liveSeconds = row.leftAt
        ? (row.durationSeconds ?? 0)
        : Math.max(0, Math.round((now - row.joinedAt.getTime()) / 1000));

      const entry = byIdentity.get(key) ?? {
        identity: row.identity,
        userId: row.userId ? String(row.userId) : undefined,
        name: row.name,
        totalSeconds: 0,
        currentlyInCall: false,
        sessions: [],
      };
      entry.name = row.name; // most recent session's display name wins
      entry.totalSeconds += liveSeconds;
      entry.currentlyInCall = entry.currentlyInCall || !row.leftAt;
      entry.sessions.push({
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
        durationSeconds: liveSeconds,
      });
      byIdentity.set(key, entry);
    }

    const attendance = [...byIdentity.values()].sort(
      (a, b) => b.totalSeconds - a.totalSeconds,
    );

    res.json({
      success: true,
      message: "Attendance retrieved",
      data: { attendance },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────
// RECORDING — a short-lived presigned download URL for the S3 object
// Egress uploaded (see services/livekitService.startRoomRecording and
// the egress_ended webhook handler that flips recordingStatus to
// "available"). Nothing is proxied through this server — the browser
// downloads straight from S3.
// ─────────────────────────────────────────────────────────────────
export const getMeetingRecordingUrl = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const meeting = await MeetingModel.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: "Meeting not found" });
      return;
    }
    const role = req.user!.role;
    if (
      role !== "ceo" &&
      role !== "tech" &&
      !isParticipant(meeting as unknown as IMeeting, req.user!.userId)
    ) {
      res
        .status(403)
        .json({ success: false, message: "You are not part of this meeting" });
      return;
    }

    if (
      meeting.recordingStatus === "starting" ||
      meeting.recordingStatus === "recording"
    ) {
      res.status(409).json({
        success: false,
        message: "This call is still being recorded — check back once it ends",
      });
      return;
    }
    if (meeting.recordingStatus === "failed") {
      res
        .status(422)
        .json({ success: false, message: "Recording failed for this meeting" });
      return;
    }
    if (!meeting.recordingS3Key || meeting.recordingStatus !== "available") {
      res
        .status(404)
        .json({
          success: false,
          message: "No recording is available for this meeting",
        });
      return;
    }

    const url = await getSignedFileUrl(meeting.recordingS3Key, {
      filename: `${meeting.title.replace(/[^\w\- ]+/g, "").trim() || "recording"}.mp4`,
      forceAttachment: true,
      expiresInSeconds: 900,
    });

    res.json({
      success: true,
      message: "Recording URL issued",
      data: {
        url,
        durationSeconds: meeting.recordingDurationSeconds,
        sizeBytes: meeting.recordingSizeBytes,
      },
    });
  } catch (err) {
    next(err);
  }
};
