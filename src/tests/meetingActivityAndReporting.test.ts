import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { MeetingModel } from "../models/Meeting";
import { MeetingActivityModel } from "../models/MeetingActivity";
import { ClientModel } from "../models/Client";
import { runMeetingAutoCompleteSweep } from "../controllers/meetingController";

beforeAll(async () => {
  await startTestDb();
}, 120_000); // generous: first run may still need to finish caching the mongod binary

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await MeetingModel.deleteMany({});
  await MeetingActivityModel.deleteMany({});
  await ClientModel.deleteMany({});
});

const hoursFromNow = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

describe("Meeting lifecycle — full automatic activity trail", () => {
  it("writes one activity entry per lifecycle event, in order, with no manual logging", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const { user: attendee, token: attendeeToken } =
      await createUserWithToken("user");

    const createRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Full lifecycle",
        startTime: hoursFromNow(1).toISOString(),
        endTime: hoursFromNow(2).toISOString(),
        attendeeIds: [String(attendee._id)],
      });
    const meetingId = createRes.body.data.meeting._id;

    await request(app)
      .patch(`/api/meetings/${meetingId}/respond`)
      .set("Authorization", `Bearer ${attendeeToken}`)
      .send({ status: "accepted" });

    await request(app)
      .put(`/api/meetings/${meetingId}`)
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        startTime: hoursFromNow(3).toISOString(),
        endTime: hoursFromNow(4).toISOString(),
      });

    await request(app)
      .patch(`/api/meetings/${meetingId}/cancel`)
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({ reason: "Plans changed" });

    const historyRes = await request(app)
      .get(`/api/meetings/${meetingId}/activity`)
      .set("Authorization", `Bearer ${ceoToken}`);

    expect(historyRes.status).toBe(200);
    const actions = historyRes.body.data.activity.map(
      (a: { action: string }) => a.action,
    );
    // Order matters — it should read like a real timeline.
    expect(actions).toEqual([
      "meeting_created",
      "invitation_sent",
      "participant_accepted",
      "meeting_rescheduled",
      "meeting_cancelled",
    ]);
  });

  it("auto-completes past meetings without anyone closing them out by hand", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const pastMeeting = await MeetingModel.create({
      title: "Yesterday's standup",
      organizer: ceo._id,
      attendees: [],
      startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endTime: new Date(Date.now() - 60 * 60 * 1000),
      status: "scheduled",
      recurrence: { frequency: "none", interval: 1, daysOfWeek: [] },
      isRecurringInstance: false,
      targetDepartments: [],
      organizationWide: false,
      reminderMinutesBefore: 15,
      reminderSent: false,
    });
    const stillUpcoming = await MeetingModel.create({
      title: "Tomorrow's planning",
      organizer: ceo._id,
      attendees: [],
      startTime: hoursFromNow(23),
      endTime: hoursFromNow(24),
      status: "scheduled",
      recurrence: { frequency: "none", interval: 1, daysOfWeek: [] },
      isRecurringInstance: false,
      targetDepartments: [],
      organizationWide: false,
      reminderMinutesBefore: 15,
      reminderSent: false,
    });

    const { completed } = await runMeetingAutoCompleteSweep();
    expect(completed).toBe(1);

    const past = await MeetingModel.findById(pastMeeting._id);
    expect(past?.status).toBe("completed");
    const future = await MeetingModel.findById(stillUpcoming._id);
    expect(future?.status).toBe("scheduled");

    const activity = await MeetingActivityModel.find({
      meetingId: pastMeeting._id,
    });
    expect(activity.map((a) => a.action)).toContain("meeting_completed");
  });
});

describe("CRM integration — client-scoped meeting data", () => {
  it("exposes both scheduled meetings and their activity trail per-client, isolated from other clients", async () => {
    const { user: ceo, token: ceoToken } = await createUserWithToken("ceo");
    const clientA = await ClientModel.create({
      name: "Client A",
      createdBy: ceo._id,
      assignedTo: [ceo._id],
    });
    const clientB = await ClientModel.create({
      name: "Client B",
      createdBy: ceo._id,
      assignedTo: [ceo._id],
    });

    await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "A's meeting",
        startTime: hoursFromNow(1).toISOString(),
        endTime: hoursFromNow(2).toISOString(),
        clientId: String(clientA._id),
      });
    await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "B's meeting",
        startTime: hoursFromNow(1).toISOString(),
        endTime: hoursFromNow(2).toISOString(),
        clientId: String(clientB._id),
      });

    const aScheduled = await request(app)
      .get(`/api/clients/${clientA._id}/meetings/scheduled`)
      .set("Authorization", `Bearer ${ceoToken}`);
    expect(aScheduled.body.data.meetings).toHaveLength(1);
    expect(aScheduled.body.data.meetings[0].title).toBe("A's meeting");

    const aActivity = await request(app)
      .get(`/api/clients/${clientA._id}/meetings/activity`)
      .set("Authorization", `Bearer ${ceoToken}`);
    expect(
      aActivity.body.data.activity.every(
        (entry: { message: string }) => !entry.message.includes("B's meeting"),
      ),
    ).toBe(true);
    expect(aActivity.body.data.activity.length).toBeGreaterThan(0);
  });

  it("denies client-scoped meeting data to users without access to the client", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const { token: outsiderToken } = await createUserWithToken("user");
    const client = await ClientModel.create({
      name: "Private Client",
      createdBy: ceo._id,
      assignedTo: [ceo._id], // outsider is not assigned
    });

    const res = await request(app)
      .get(`/api/clients/${client._id}/meetings/scheduled`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/analytics/dashboard — meeting stats & activity feed", () => {
  it("reports upcoming/this-week/completed/cancelled meeting counts and a recent activity feed", async () => {
    const { user: ceo, token: ceoToken } = await createUserWithToken("ceo");

    // Upcoming, within the next 7 days.
    await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "This week's sync",
        startTime: hoursFromNow(2).toISOString(),
        endTime: hoursFromNow(3).toISOString(),
      });

    // A meeting that already ended, then cancelled.
    const pastMeeting = await MeetingModel.create({
      title: "Old meeting",
      organizer: ceo._id,
      attendees: [],
      startTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
      endTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
      status: "cancelled",
      recurrence: { frequency: "none", interval: 1, daysOfWeek: [] },
      isRecurringInstance: false,
      targetDepartments: [],
      organizationWide: false,
      reminderMinutesBefore: 15,
      reminderSent: false,
    });
    void pastMeeting;

    const res = await request(app)
      .get("/api/analytics/dashboard")
      .set("Authorization", `Bearer ${ceoToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.stats.upcomingMeetings).toBe(1);
    expect(res.body.data.stats.meetingsThisWeek).toBe(1);
    expect(res.body.data.stats.cancelledMeetings).toBe(1);
    expect(Array.isArray(res.body.data.recentMeetingActivity)).toBe(true);
    expect(res.body.data.recentMeetingActivity.length).toBeGreaterThan(0);
  });

  it("scopes a non-elevated user's meeting stats to only their own meetings", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const { token: uninvolvedToken } = await createUserWithToken("user");

    await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "CEO-only meeting",
        startTime: hoursFromNow(2).toISOString(),
        endTime: hoursFromNow(3).toISOString(),
      });

    const res = await request(app)
      .get("/api/analytics/dashboard")
      .set("Authorization", `Bearer ${uninvolvedToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.stats.upcomingMeetings).toBe(0);
    expect(res.body.data.stats.meetingsThisWeek).toBe(0);
  });
});
