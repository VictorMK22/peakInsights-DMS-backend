import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { MeetingModel } from "../models/Meeting";
import { MeetingActivityModel } from "../models/MeetingActivity";
import { ClientModel } from "../models/Client";

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

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000);
const inTwoHours = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
const inThreeHours = () => new Date(Date.now() + 3 * 60 * 60 * 1000);

describe("POST /api/meetings — createMeeting", () => {
  it("creates a meeting, invites the attendee, and logs automatic activity", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const { user: attendee } = await createUserWithToken("user");

    const res = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Quarterly sync",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        attendeeIds: [String(attendee._id)],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.meeting.title).toBe("Quarterly sync");
    expect(res.body.data.meeting.attendees).toHaveLength(1);
    expect(res.body.data.meeting.attendees[0].status).toBe("pending");

    // No manual logging required — activity is automatic.
    const activity = await MeetingActivityModel.find({
      meetingId: res.body.data.meeting._id,
    });
    const actions = activity.map((a) => a.action);
    expect(actions).toContain("meeting_created");
    expect(actions).toContain("invitation_sent");
  });

  it("creates external (email-only) attendees alongside internal ones", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");

    const res = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Client kickoff",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        externalAttendees: [{ email: "partner@external.com", name: "Partner" }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.meeting.externalAttendees).toEqual([
      expect.objectContaining({ email: "partner@external.com" }),
    ]);
  });

  it("links a meeting to a client so it appears on the client's record automatically", async () => {
    const { user: ceo, token: ceoToken } = await createUserWithToken("ceo");
    const client = await ClientModel.create({
      name: "Acme Corp",
      createdBy: ceo._id,
      assignedTo: [ceo._id],
    });

    const createRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Acme check-in",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        clientId: String(client._id),
      });
    expect(createRes.status).toBe(201);

    // Should show up under the client's auto-synced meetings — no
    // separate manual log entry required.
    const scheduledRes = await request(app)
      .get(`/api/clients/${client._id}/meetings/scheduled`)
      .set("Authorization", `Bearer ${ceoToken}`);
    expect(scheduledRes.status).toBe(200);
    expect(scheduledRes.body.data.meetings).toHaveLength(1);
    expect(scheduledRes.body.data.meetings[0].title).toBe("Acme check-in");

    // And the client's automatic activity timeline should carry the
    // "meeting_created" entry too.
    const activityRes = await request(app)
      .get(`/api/clients/${client._id}/meetings/activity`)
      .set("Authorization", `Bearer ${ceoToken}`);
    expect(activityRes.status).toBe(200);
    expect(
      activityRes.body.data.activity.some(
        (a: { action: string }) => a.action === "meeting_created",
      ),
    ).toBe(true);
  });

  it("rejects (409) an overlapping meeting for an already-booked attendee, and force=true overrides it", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const { user: attendee } = await createUserWithToken("user");

    await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "First meeting",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        attendeeIds: [String(attendee._id)],
      });

    const conflictRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Overlapping meeting",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        attendeeIds: [String(attendee._id)],
      });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.data.conflicts.length).toBeGreaterThan(0);
    expect(conflictRes.body.data.suggestions).toBeDefined();

    const forcedRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Overlapping meeting",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        attendeeIds: [String(attendee._id)],
        force: true,
      });
    expect(forcedRes.status).toBe(201);
  });

  it("rejects a request missing required fields", async () => {
    const { token } = await createUserWithToken("ceo");
    const res = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "No times" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/meetings — visibility & client scoping", () => {
  it("only returns meetings the requester organizes or attends by default", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const { user: attendee, token: attendeeToken } =
      await createUserWithToken("user");
    const { token: outsiderToken } = await createUserWithToken("user");

    await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Team sync",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        attendeeIds: [String(attendee._id)],
      });

    const asAttendee = await request(app)
      .get("/api/meetings")
      .set("Authorization", `Bearer ${attendeeToken}`);
    expect(asAttendee.body.data.meetings).toHaveLength(1);

    const asOutsider = await request(app)
      .get("/api/meetings")
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(asOutsider.body.data.meetings).toHaveLength(0);
  });

  it("filters by clientId, visible to ceo/tech/sales_person beyond their own meetings", async () => {
    const { user: ceo, token: ceoToken } = await createUserWithToken("ceo");
    const { token: salesToken } = await createUserWithToken("sales_person");
    const { token: outsiderToken } = await createUserWithToken("user");
    const client = await ClientModel.create({
      name: "Globex",
      createdBy: ceo._id,
      assignedTo: [ceo._id],
    });

    await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Globex review",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        clientId: String(client._id),
      });

    const salesView = await request(app)
      .get(`/api/meetings?clientId=${client._id}`)
      .set("Authorization", `Bearer ${salesToken}`);
    expect(salesView.body.data.meetings).toHaveLength(1);

    // A regular user who isn't on the meeting and isn't client-facing
    // shouldn't see it just by knowing the clientId.
    const outsiderView = await request(app)
      .get(`/api/meetings?clientId=${client._id}`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(outsiderView.body.data.meetings).toHaveLength(0);
  });
});

describe("PATCH /api/meetings/:id/respond — RSVP", () => {
  it("records the attendee's response and logs it automatically", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const { user: attendee, token: attendeeToken } =
      await createUserWithToken("user");

    const createRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "RSVP test",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
        attendeeIds: [String(attendee._id)],
      });
    const meetingId = createRes.body.data.meeting._id;

    const respondRes = await request(app)
      .patch(`/api/meetings/${meetingId}/respond`)
      .set("Authorization", `Bearer ${attendeeToken}`)
      .send({ status: "accepted" });
    expect(respondRes.status).toBe(200);
    expect(
      respondRes.body.data.meeting.attendees.find(
        (a: { userId: { _id: string }; status: string }) =>
          a.userId._id === String(attendee._id),
      ).status,
    ).toBe("accepted");

    const activity = await MeetingActivityModel.find({ meetingId });
    expect(activity.map((a) => a.action)).toContain("participant_accepted");
  });
});

describe("PUT /api/meetings/:id — updateMeeting", () => {
  it("reschedules the meeting and logs a reschedule activity entry", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const createRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Move me",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
      });
    const meetingId = createRes.body.data.meeting._id;

    const updateRes = await request(app)
      .put(`/api/meetings/${meetingId}`)
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        startTime: inTwoHours().toISOString(),
        endTime: inThreeHours().toISOString(),
      });
    expect(updateRes.status).toBe(200);

    const activity = await MeetingActivityModel.find({ meetingId });
    expect(activity.map((a) => a.action)).toContain("meeting_rescheduled");
  });
});

describe("PATCH /api/meetings/:id/cancel — cancelMeeting", () => {
  it("cancels the meeting and logs it automatically", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const createRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Cancel me",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
      });
    const meetingId = createRes.body.data.meeting._id;

    const cancelRes = await request(app)
      .patch(`/api/meetings/${meetingId}/cancel`)
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({ reason: "No longer needed" });
    expect(cancelRes.status).toBe(200);

    const meeting = await MeetingModel.findById(meetingId);
    expect(meeting?.status).toBe("cancelled");

    const activity = await MeetingActivityModel.find({ meetingId });
    expect(activity.map((a) => a.action)).toContain("meeting_cancelled");
  });
});

describe("GET /api/meetings/:id/activity", () => {
  it("is visible to participants and forbidden to outsiders", async () => {
    const { token: ceoToken } = await createUserWithToken("ceo");
    const { token: outsiderToken } = await createUserWithToken("user");
    const createRes = await request(app)
      .post("/api/meetings")
      .set("Authorization", `Bearer ${ceoToken}`)
      .send({
        title: "Private meeting",
        startTime: inOneHour().toISOString(),
        endTime: inTwoHours().toISOString(),
      });
    const meetingId = createRes.body.data.meeting._id;

    const asOrganizer = await request(app)
      .get(`/api/meetings/${meetingId}/activity`)
      .set("Authorization", `Bearer ${ceoToken}`);
    expect(asOrganizer.status).toBe(200);
    expect(asOrganizer.body.data.activity.length).toBeGreaterThan(0);

    const asOutsider = await request(app)
      .get(`/api/meetings/${meetingId}/activity`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(asOutsider.status).toBe(403);
  });
});
