import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { MeetingModel, IMeeting, RsvpStatus } from "../models/Meeting";
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
import { getSignedFileUrl } from "../services/s3Storage";
import {
  getValidGoogleAccessToken,
  createMeetEvent,
  updateMeetEventTime,
  deleteMeetEvent,
} from "../services/googleCalendarService";

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
      conferenceProvider,
      googleEventId,
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
      conferenceProvider?: "custom" | "google_meet";
      googleEventId?: string;
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
        // A Google Meet link is only trustworthy as "google_meet" on
        // the very first (non-recurring-expansion) occurrence — the
        // same googleEventId/link would otherwise be duplicated
        // across every generated occurrence, which isn't meaningful
        // since each occurrence is its own Calendar event in reality.
        // Recurring series should be created without a Meet link, or
        // organizers can attach one per-occurrence via edit.
        conferenceProvider:
          index === 0 && meetingLink ? conferenceProvider : undefined,
        googleEventId: index === 0 ? googleEventId : undefined,
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
// GOOGLE MEET — generates a real, clickable meet.google.com link via
// the organizer's own connected Google account (see
// services/googleCalendarService.ts), for use as this meeting's
// meetingLink. Called from the create/edit form *before* the meeting
// itself is saved, so the returned link + googleEventId are just
// handed back to the client to include in the createMeeting /
// updateMeeting payload — this endpoint does not touch MeetingModel.
// ─────────────────────────────────────────────────────────────────
export const generateGoogleMeetLink = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const actorId = req.user!.userId;
    const {
      title,
      startTime,
      endTime,
      attendeeIds = [],
    } = req.body as {
      title?: string;
      startTime?: string;
      endTime?: string;
      attendeeIds?: string[];
    };

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

    const accessToken = await getValidGoogleAccessToken(actorId);
    if (!accessToken) {
      res.status(409).json({
        success: false,
        message:
          "Connect your Google account first to generate a Google Meet link",
        data: { needsGoogleConnect: true },
      });
      return;
    }

    const attendeeUsers = attendeeIds.length
      ? await User.find({ _id: { $in: attendeeIds } })
          .select("email")
          .lean()
      : [];

    const { eventId, hangoutLink } = await createMeetEvent({
      accessToken,
      title,
      startTime: start,
      endTime: end,
      attendeeEmails: attendeeUsers
        .map((u) => u.email)
        .filter((e): e is string => Boolean(e)),
    });

    res.json({
      success: true,
      message: "Google Meet link created",
      data: { meetingLink: hangoutLink, googleEventId: eventId },
    });
  } catch (err: any) {
    console.error(
      "Google Meet link generation failed:",
      err?.response?.data || err?.message || err,
    );
    res.status(502).json({
      success: false,
      message:
        "Couldn't create a Google Meet link right now — check your Google connection and try again",
    });
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
      conferenceProvider,
      googleEventId,
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
      conferenceProvider?: "custom" | "google_meet";
      googleEventId?: string;
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
    if (conferenceProvider !== undefined)
      meeting.conferenceProvider = conferenceProvider;
    if (googleEventId !== undefined) meeting.googleEventId = googleEventId;
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

    // Best-effort — keep the underlying Google Calendar event (and
    // therefore the Meet link's event details) in sync when the time
    // or title changes. Never blocks the response or fails the update
    // if Google is unreachable/the organizer's token has lapsed.
    if (
      meeting.conferenceProvider === "google_meet" &&
      meeting.googleEventId &&
      (timeChanged || title !== undefined)
    ) {
      getValidGoogleAccessToken(idOf(meeting.organizer))
        .then((accessToken) => {
          if (!accessToken) return;
          return updateMeetEventTime({
            accessToken,
            eventId: meeting.googleEventId!,
            title,
            startTime: timeChanged ? newStart : undefined,
            endTime: timeChanged ? newEnd : undefined,
          });
        })
        .catch((err) =>
          console.error("Google Calendar event sync on update failed:", err),
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

    // Best-effort — delete the Google Calendar event(s) backing any
    // cancelled meeting's Meet link, so it disappears from the
    // organizer's calendar instead of sitting there as a stale event.
    const googleTargets = targets.filter(
      (m) => m.conferenceProvider === "google_meet" && m.googleEventId,
    );
    if (googleTargets.length > 0) {
      getValidGoogleAccessToken(idOf(meeting.organizer))
        .then((accessToken) => {
          if (!accessToken) return;
          return Promise.all(
            googleTargets.map((m) =>
              deleteMeetEvent(accessToken, m.googleEventId!),
            ),
          );
        })
        .catch((err) =>
          console.error("Google Calendar event cleanup on cancel failed:", err),
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
