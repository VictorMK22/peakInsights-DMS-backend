import "./testEnv";

// Capture outgoing email instead of sending it, so we can read the real
// Accept / Decline links out of the invitation HTML.
const sent: any[] = [];
jest.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (m: any) => {
        sent.push(m);
        return { data: { id: "1" }, error: null };
      },
    };
  },
}));
process.env.RESEND_API_KEY = "k";
process.env.MAIL_FROM_DOMAIN = "peak-insights.com";

import request from "supertest";
import mongoose from "mongoose";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { MeetingModel } from "../models/Meeting";
import { MeetingActivityModel } from "../models/MeetingActivity";
import Notification from "../models/Notification";
import { createRsvpToken, verifyRsvpToken } from "../utils/meetingRsvpToken";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
beforeEach(() => {
  sent.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  await MeetingModel.deleteMany({});
  await MeetingActivityModel.deleteMany({});
  await Notification.deleteMany({});
});

const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

/** Token + action links found in an email to `to`. */
const linksIn = (to: string, subjectPart = "invited") => {
  const mail = sent.find(
    (m) => m.to === to && String(m.subject).includes(subjectPart),
  );
  if (!mail) return null;
  const grab = (action: string) =>
    new RegExp(`meeting-rsvp\\?token=([^&"]+)&action=${action}`).exec(
      mail.html,
    )?.[1];
  return {
    html: mail.html as string,
    accept: grab("accept"),
    tentative: grab("tentative"),
    decline: grab("decline"),
  };
};

const setup = async (opts: { external?: boolean } = {}) => {
  const { user: organizer, token: orgToken } = await createUserWithToken("ceo");
  const { user: alice, token: aliceToken } = await createUserWithToken("accountant");
  const { user: bob, token: bobToken } = await createUserWithToken("tech");
  const res = await request(app)
    .post("/api/meetings")
    .set("Authorization", `Bearer ${orgToken}`)
    .send({
      title: "Budget review",
      startTime: hours(1).toISOString(),
      endTime: hours(2).toISOString(),
      attendeeIds: [String(alice._id), String(bob._id)],
      externalAttendees: opts.external
        ? [{ email: "Partner@External.com", name: "Pat Partner" }]
        : [],
    });
  expect(res.status).toBe(201);
  return {
    organizer, orgToken, alice, aliceToken, bob, bobToken,
    meetingId: res.body.data.meeting._id as string,
  };
};

const attendeeOf = async (meetingId: string, userId: string) =>
  (await MeetingModel.findById(meetingId))!.attendees.find(
    (a) => String(a.userId) === userId,
  )!;

describe("RSVP token", () => {
  const meetingId = String(new mongoose.Types.ObjectId());
  const userId = String(new mongoose.Types.ObjectId());

  it("round-trips for a user and for an external invitee (email lowercased)", () => {
    expect(
      verifyRsvpToken(createRsvpToken(meetingId, { kind: "user", userId })),
    ).toEqual({ meetingId, actor: { kind: "user", userId } });
    expect(
      verifyRsvpToken(createRsvpToken(meetingId, { kind: "external", email: " A@B.com " })),
    ).toEqual({ meetingId, actor: { kind: "external", email: "a@b.com" } });
  });

  it("rejects tampered, truncated, foreign-signed and non-string tokens", () => {
    const t = createRsvpToken(meetingId, { kind: "user", userId });
    const [body, sig] = t.split(".");
    const other = createRsvpToken(meetingId, {
      kind: "user",
      userId: String(new mongoose.Types.ObjectId()),
    });
    expect(verifyRsvpToken(`${other.split(".")[0]}.${sig}`)).toBeNull(); // swap payload
    expect(verifyRsvpToken(`${body}.${sig.slice(0, -2)}AA`)).toBeNull(); // bad sig
    expect(verifyRsvpToken(body)).toBeNull();
    expect(verifyRsvpToken("")).toBeNull();
    expect(verifyRsvpToken(undefined)).toBeNull();
    expect(verifyRsvpToken("a.b.c")).toBeNull();
  });
});

describe("invitation emails", () => {
  it("carry working Accept / Decline links for internal and external invitees", async () => {
    const { alice, meetingId } = await setup({ external: true });

    const a = linksIn(alice.email)!;
    expect(a.accept && a.tentative && a.decline).toBeTruthy();
    expect(verifyRsvpToken(decodeURIComponent(a.tentative!))?.meetingId).toBe(meetingId);
    expect(verifyRsvpToken(decodeURIComponent(a.accept!))).toEqual({
      meetingId,
      actor: { kind: "user", userId: String(alice._id) },
    });
    expect(a.html).toContain("give the organizer a short reason");

    const ext = linksIn("partner@external.com")!;
    expect(verifyRsvpToken(decodeURIComponent(ext.accept!))?.actor).toEqual({
      kind: "external",
      email: "partner@external.com",
    });
  });
});

describe("public RSVP endpoints (email links)", () => {
  it("GET is read-only — opening the link never records a response", async () => {
    const { alice, meetingId } = await setup();
    const tok = linksIn(alice.email)!.accept!;

    const res = await request(app).get(`/api/meeting-rsvp/${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      canRespond: true,
      closedReason: null,
      meeting: { title: "Budget review" },
      you: { status: "pending" },
    });
    expect(JSON.stringify(res.body)).not.toContain(String(alice._id)); // no ids leak
    expect((await attendeeOf(meetingId, String(alice._id))).status).toBe("pending");
  });

  it("POST accept records the answer, notifies the organizer and logs activity", async () => {
    const { organizer, alice, meetingId } = await setup();
    const tok = linksIn(alice.email)!.accept!;

    const res = await request(app)
      .post(`/api/meeting-rsvp/${tok}`)
      .send({ status: "accepted" });
    expect(res.status).toBe(200);
    expect(res.body.data.you.status).toBe("accepted");

    const a = await attendeeOf(meetingId, String(alice._id));
    expect(a.status).toBe("accepted");
    expect(a.respondedAt).toBeInstanceOf(Date);

    const n = await Notification.findOne({ userId: organizer._id, type: "meeting_response" });
    expect(n?.message).toContain("accepted");
    const acts = await MeetingActivityModel.find({ meetingId });
    expect(acts.map((x) => x.action)).toContain("participant_accepted");
  });

  it("declining WITHOUT a reason is rejected and changes nothing", async () => {
    const { alice, meetingId } = await setup();
    const tok = linksIn(alice.email)!.decline!;

    for (const body of [{ status: "declined" }, { status: "declined", reason: "   " }, { status: "declined", reason: 42 }]) {
      const res = await request(app).post(`/api/meeting-rsvp/${tok}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("REASON_REQUIRED");
    }
    expect((await attendeeOf(meetingId, String(alice._id))).status).toBe("pending");
  });

  it("declining with a reason stores it, tells the organizer, but keeps it out of the activity feed", async () => {
    const { organizer, alice, meetingId } = await setup();
    const tok = linksIn(alice.email)!.decline!;

    const res = await request(app)
      .post(`/api/meeting-rsvp/${tok}`)
      .send({ status: "declined", reason: "  Clashes with audit prep \u0007 " });
    expect(res.status).toBe(200);
    expect(res.body.data.you).toMatchObject({ status: "declined", declineReason: "Clashes with audit prep" });

    const a = await attendeeOf(meetingId, String(alice._id));
    expect(a.status).toBe("declined");
    expect(a.declineReason).toBe("Clashes with audit prep");

    const n = await Notification.findOne({ userId: organizer._id, type: "meeting_response" });
    expect(n?.message).toContain("declined");
    expect(n?.message).toContain("Reason: Clashes with audit prep");
    expect(n?.meta?.reason).toBe("Clashes with audit prep");

    const acts = await MeetingActivityModel.find({ meetingId });
    const declined = acts.find((x) => x.action === "participant_declined")!;
    expect(declined).toBeTruthy();
    expect(JSON.stringify(acts)).not.toContain("audit prep");
  });

  it("rejects over-long reasons and unknown statuses", async () => {
    const { alice } = await setup();
    const tok = linksIn(alice.email)!.decline!;
    const long = await request(app).post(`/api/meeting-rsvp/${tok}`).send({ status: "declined", reason: "x".repeat(501) });
    expect(long.status).toBe(400);
    for (const status of ["pending", "maybe", undefined]) {
      const bad = await request(app).post(`/api/meeting-rsvp/${tok}`).send({ status });
      expect(bad.status).toBe(400);
    }
  });

  it("Tentative works from the email: no reason needed, organizer told, old decline reason cleared", async () => {
    const { organizer, alice, meetingId } = await setup();
    const { tentative, decline } = linksIn(alice.email)!;
    await request(app).post(`/api/meeting-rsvp/${decline}`).send({ status: "declined", reason: "Maybe clash" });

    const res = await request(app).post(`/api/meeting-rsvp/${tentative}`).send({ status: "tentative" });
    expect(res.status).toBe(200);
    expect(res.body.data.you.status).toBe("tentative");

    const a = (await MeetingModel.findById(meetingId).lean())!.attendees.find((x) => String(x.userId) === String(alice._id))!;
    expect(a.status).toBe("tentative");
    expect(a).not.toHaveProperty("declineReason");

    const notes = await Notification.find({ userId: organizer._id, type: "meeting_response" }).sort({ createdAt: -1 });
    expect(notes[0].message).toContain("responded tentatively");
    const acts = await MeetingActivityModel.find({ meetingId });
    expect(acts.map((x) => x.action)).toContain("participant_tentative");
  });

  it("Tentative works for external invitees too", async () => {
    const { meetingId } = await setup({ external: true });
    const { tentative } = linksIn("partner@external.com")!;
    const res = await request(app).post(`/api/meeting-rsvp/${tentative}`).send({ status: "tentative" });
    expect(res.status).toBe(200);
    expect((await MeetingModel.findById(meetingId))!.externalAttendees[0].status).toBe("tentative");
  });

  it("lets someone change their mind; accepting clears the old reason", async () => {
    const { alice, meetingId } = await setup();
    const { accept, decline } = linksIn(alice.email)!;
    await request(app).post(`/api/meeting-rsvp/${decline}`).send({ status: "declined", reason: "Away" });
    await request(app).post(`/api/meeting-rsvp/${accept}`).send({ status: "accepted" });
    const a = (await MeetingModel.findById(meetingId).lean())!.attendees.find((x) => String(x.userId) === String(alice._id))!;
    expect(a.status).toBe("accepted");
    expect(a).not.toHaveProperty("declineReason");
  });

  it("works for external (email-only) invitees", async () => {
    const { meetingId, organizer } = await setup({ external: true });
    const { decline } = linksIn("partner@external.com")!;
    const res = await request(app)
      .post(`/api/meeting-rsvp/${decline}`)
      .send({ status: "declined", reason: "Travelling" });
    expect(res.status).toBe(200);

    const m = (await MeetingModel.findById(meetingId))!;
    expect(m.externalAttendees[0]).toMatchObject({ status: "declined", declineReason: "Travelling" });
    const n = await Notification.findOne({ userId: organizer._id, type: "meeting_response" });
    expect(n?.message).toContain("Pat Partner (partner@external.com) declined");
    const act = await MeetingActivityModel.findOne({ meetingId, action: "participant_declined" });
    expect(String(act!.actorId)).toBe(String(organizer._id)); // attributed to organizer
  });

  it("rejects forged links (400) and people who were removed from the meeting (404)", async () => {
    const { alice, meetingId, orgToken } = await setup();
    const tok = linksIn(alice.email)!.accept!;
    const forged = await request(app).post(`/api/meeting-rsvp/${tok.slice(0, -3)}abc`).send({ status: "accepted" });
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe("INVALID_LINK");

    // a validly-signed token for someone who isn't on the list
    const stranger = createRsvpToken(meetingId, { kind: "user", userId: String(new mongoose.Types.ObjectId()) });
    const res = await request(app).post(`/api/meeting-rsvp/${stranger}`).send({ status: "accepted" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_INVITED");

    // removed after being invited
    await request(app).put(`/api/meetings/${meetingId}`).set("Authorization", `Bearer ${orgToken}`).send({ attendeeIds: [] });
    const gone = await request(app).get(`/api/meeting-rsvp/${tok}`);
    expect(gone.status).toBe(404);
  });

  it("won't take an answer once the meeting is cancelled — GET explains, POST is 410", async () => {
    const { alice, meetingId, orgToken } = await setup();
    const tok = linksIn(alice.email)!.accept!;
    await request(app).patch(`/api/meetings/${meetingId}/cancel`).set("Authorization", `Bearer ${orgToken}`).send({ reason: "Budget frozen" });

    const get = await request(app).get(`/api/meeting-rsvp/${tok}`);
    expect(get.body.data).toMatchObject({ canRespond: false, closedReason: "cancelled" });
    const post = await request(app).post(`/api/meeting-rsvp/${tok}`).send({ status: "accepted" });
    expect(post.status).toBe(410);
    expect(post.body.code).toBe("MEETING_CANCELLED");
    expect((await attendeeOf(meetingId, String(alice._id))).status).toBe("pending");
  });

  it("won't take an answer after the meeting has ended", async () => {
    const { alice, meetingId } = await setup();
    const tok = linksIn(alice.email)!.accept!;
    await MeetingModel.updateOne({ _id: meetingId }, { startTime: hours(-3), endTime: hours(-2) });
    const post = await request(app).post(`/api/meeting-rsvp/${tok}`).send({ status: "accepted" });
    expect(post.status).toBe(410);
    expect(post.body.code).toBe("MEETING_ENDED");
  });
});

describe("in-app PATCH /api/meetings/:id/respond", () => {
  it("now also requires a reason to decline, and accepts one", async () => {
    const { alice, aliceToken, meetingId } = await setup();
    const url = `/api/meetings/${meetingId}/respond`;
    const bad = await request(app).patch(url).set("Authorization", `Bearer ${aliceToken}`).send({ status: "declined" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("REASON_REQUIRED");

    const ok = await request(app).patch(url).set("Authorization", `Bearer ${aliceToken}`).send({ status: "declined", reason: "Sick leave" });
    expect(ok.status).toBe(200);
    expect((await attendeeOf(meetingId, String(alice._id))).declineReason).toBe("Sick leave");

    const tentative = await request(app).patch(url).set("Authorization", `Bearer ${aliceToken}`).send({ status: "tentative" });
    expect(tentative.status).toBe(200);
  });
});

describe("decline reasons are private to the organizer", () => {
  it("other attendees never see them (single, list and RSVP responses); organizer and the decliner do", async () => {
    const { alice, aliceToken, bobToken, orgToken, meetingId } = await setup({ external: true });
    await request(app).patch(`/api/meetings/${meetingId}/respond`).set("Authorization", `Bearer ${aliceToken}`).send({ status: "declined", reason: "SECRET-REASON" });
    await request(app).post(`/api/meeting-rsvp/${linksIn("partner@external.com")!.decline}`).send({ status: "declined", reason: "EXT-SECRET" });

    const asBob = await request(app).get(`/api/meetings/${meetingId}`).set("Authorization", `Bearer ${bobToken}`);
    expect(JSON.stringify(asBob.body)).not.toMatch(/SECRET/);
    const bobList = await request(app).get("/api/meetings").set("Authorization", `Bearer ${bobToken}`);
    expect(JSON.stringify(bobList.body)).not.toMatch(/SECRET/);
    const bobResp = await request(app).patch(`/api/meetings/${meetingId}/respond`).set("Authorization", `Bearer ${bobToken}`).send({ status: "accepted" });
    expect(JSON.stringify(bobResp.body)).not.toMatch(/SECRET/);
    // status itself is still visible to them
    expect(asBob.body.data.meeting.attendees.map((a: any) => a.status)).toContain("declined");

    const asOrg = await request(app).get(`/api/meetings/${meetingId}`).set("Authorization", `Bearer ${orgToken}`);
    expect(JSON.stringify(asOrg.body)).toContain("SECRET-REASON");
    expect(JSON.stringify(asOrg.body)).toContain("EXT-SECRET");

    const asAlice = await request(app).get(`/api/meetings/${meetingId}`).set("Authorization", `Bearer ${aliceToken}`);
    expect(JSON.stringify(asAlice.body)).toContain("SECRET-REASON");
    expect(JSON.stringify(asAlice.body)).not.toContain("EXT-SECRET");
    void alice;
  });
});

describe("rescheduling and late invitees", () => {
  it("a new time clears every answer (incl. reasons, externals) and the update email asks again", async () => {
    const { alice, meetingId, orgToken, organizer } = await setup({ external: true });
    await request(app).post(`/api/meeting-rsvp/${linksIn(alice.email)!.decline}`).send({ status: "declined", reason: "Busy" });
    await request(app).post(`/api/meeting-rsvp/${linksIn("partner@external.com")!.accept}`).send({ status: "accepted" });
    sent.length = 0;

    const res = await request(app).put(`/api/meetings/${meetingId}`).set("Authorization", `Bearer ${orgToken}`).send({ startTime: hours(5).toISOString(), endTime: hours(6).toISOString() });
    expect(res.status).toBe(200);

    const m = (await MeetingModel.findById(meetingId).lean())!;
    expect(m.attendees.every((a) => a.status === "pending" && !("declineReason" in a))).toBe(true);
    expect(m.externalAttendees[0].status).toBe("pending");

    const upd = linksIn(alice.email, "Updated")!;
    expect(upd.accept && upd.tentative && upd.decline).toBeTruthy();
    expect(upd.html).toContain("Can you still make it?");
    const ext = linksIn("partner@external.com", "Updated")!;
    expect(ext.accept).toBeTruthy();
    expect(ext.html).toContain("update your own calendar"); // was wrongly app-link before
    void organizer;
  });

  it("a detail-only edit sends no buttons (nobody's answer changed)", async () => {
    const { alice, meetingId, orgToken } = await setup();
    sent.length = 0;
    await request(app).put(`/api/meetings/${meetingId}`).set("Authorization", `Bearer ${orgToken}`).send({ location: "Room 4" });
    const upd = linksIn(alice.email, "Updated")!;
    expect(upd.accept).toBeUndefined();
  });

  it("someone added during an edit gets a real invitation with buttons", async () => {
    const { alice, bob, meetingId, orgToken } = await setup();
    const { user: carol } = await createUserWithToken("sales_person");
    sent.length = 0;
    await request(app).put(`/api/meetings/${meetingId}`).set("Authorization", `Bearer ${orgToken}`).send({ attendeeIds: [String(alice._id), String(bob._id), String(carol._id)] });

    const invite = linksIn(carol.email, "invited")!;
    expect(invite.accept && invite.tentative && invite.decline).toBeTruthy();
    expect(linksIn(alice.email, "invited")).toBeNull(); // existing attendees aren't re-invited
  });
});