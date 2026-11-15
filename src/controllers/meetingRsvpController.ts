import { Request, Response, NextFunction } from "express";
import { MeetingModel, IMeeting } from "../models/Meeting";
import { User } from "../models/User";
import {
  verifyRsvpToken,
  RsvpTokenPayload,
} from "../utils/meetingRsvpToken";
import {
  parseRsvpInput,
  recordRsvp,
  findInvitee,
  getClosedReason,
  RsvpFailure,
  ClosedReason,
} from "../services/meetingRsvpService";

/**
 * PUBLIC (no login) endpoints behind the Accept / Decline links in meeting
 * invitation emails. Authority comes from the signed token in the URL — see
 * utils/meetingRsvpToken.ts — not from a session, which is what lets
 * external (email-only) invitees answer too.
 *
 *   GET  /api/meeting-rsvp/:token   Read-only: what the page needs to render
 *   POST /api/meeting-rsvp/:token   Record the answer { status, reason? }
 *
 * The GET never changes anything, on purpose. Corporate mail scanners and
 * link-preview bots fetch every URL in an email; if opening the link
 * recorded a response, they'd answer on people's behalf. Only the explicit
 * POST, sent when the person presses a button, counts.
 *
 * Errors use 400/403/404/409/410 — never 401 — so the shared web client's
 * "401 means your session expired, go to /login" handling never fires on
 * someone who was never logged in.
 */

const sendFailure = (
  res: Response,
  f: Pick<RsvpFailure, "httpStatus" | "code" | "message">,
): void => {
  res
    .status(f.httpStatus)
    .json({ success: false, code: f.code, message: f.message });
};

const invalidLink: RsvpFailure = {
  ok: false,
  httpStatus: 400,
  code: "INVALID_LINK",
  message:
    "This response link isn't valid. Please use the link in your most recent invitation email.",
};

interface RsvpView {
  meeting: {
    title: string;
    startTime: Date;
    endTime: Date;
    location?: string;
    meetingLink?: string;
    organizerName: string;
    isRecurring: boolean;
  };
  you: {
    name: string;
    status: IMeeting["attendees"][number]["status"];
    respondedAt?: Date;
    declineReason?: string; // their own, shown back to them
  };
  canRespond: boolean;
  closedReason: ClosedReason | null;
}

/**
 * Everything the response page needs, and nothing more: no other
 * attendees, no ids, no other people's answers. The token holder has
 * already been emailed the title / time / place / link, so this reveals
 * nothing new to them.
 */
const loadView = async (
  payload: RsvpTokenPayload,
): Promise<{ ok: true; view: RsvpView } | RsvpFailure> => {
  const meeting = await MeetingModel.findById(payload.meetingId).populate(
    "organizer",
    "name",
  );
  if (!meeting) {
    return {
      ok: false,
      httpStatus: 404,
      code: "NOT_FOUND",
      message: "This meeting no longer exists.",
    };
  }
  const invitee = findInvitee(meeting, payload.actor);
  if (!invitee) {
    return {
      ok: false,
      httpStatus: 404,
      code: "NOT_INVITED",
      message: "You're no longer on the invite list for this meeting.",
    };
  }

  let name: string;
  if (invitee.kind === "user") {
    const u = await User.findById(invitee.attendee.userId)
      .select("name")
      .lean();
    name = u?.name ?? "there";
  } else {
    name = invitee.attendee.name || invitee.attendee.email;
  }

  const closedReason = getClosedReason(meeting);
  const open = closedReason === null;
  const organizer = meeting.organizer as unknown as { name?: string };

  return {
    ok: true,
    view: {
      meeting: {
        title: meeting.title,
        startTime: meeting.startTime,
        endTime: meeting.endTime,
        ...(open && meeting.location ? { location: meeting.location } : {}),
        ...(open && meeting.meetingLink
          ? { meetingLink: meeting.meetingLink }
          : {}),
        organizerName: organizer?.name ?? "The organizer",
        isRecurring:
          meeting.isRecurringInstance ||
          (meeting.recurrence?.frequency ?? "none") !== "none",
      },
      you: {
        name,
        status: invitee.attendee.status ?? "pending",
        respondedAt: invitee.attendee.respondedAt,
        declineReason: invitee.attendee.declineReason,
      },
      canRespond: open,
      closedReason,
    },
  };
};

export const getRsvpInvitation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const payload = verifyRsvpToken(req.params.token);
    if (!payload) return sendFailure(res, invalidLink);

    const result = await loadView(payload);
    if (!result.ok) return sendFailure(res, result);

    res.json({ success: true, data: result.view });
  } catch (err) {
    next(err);
  }
};

export const submitRsvpResponse = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const payload = verifyRsvpToken(req.params.token);
    if (!payload) return sendFailure(res, invalidLink);

    // Same three answers as in the app: accept, tentative, decline.
    const input = parseRsvpInput(req.body, [
      "accepted",
      "tentative",
      "declined",
    ]);
    if (!input.ok) return sendFailure(res, input);

    const recorded = await recordRsvp(
      payload.meetingId,
      payload.actor,
      input.status,
      input.reason,
    );
    if (!recorded.ok) return sendFailure(res, recorded);

    const result = await loadView(payload);
    if (!result.ok) return sendFailure(res, result);

    res.json({
      success: true,
      message:
        input.status === "accepted"
          ? "You've accepted this meeting"
          : input.status === "tentative"
            ? "You've responded tentatively to this meeting"
            : "You've declined this meeting",
      data: result.view,
    });
  } catch (err) {
    next(err);
  }
};