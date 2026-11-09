import "./testEnv";
import request from "supertest";

// Don't send real email / SMS during tests.
jest.mock("../services/emailService", () => ({
  ...jest.requireActual("../services/emailService"),
  sendNewMessageEmail: jest.fn().mockResolvedValue(true),
  sendDirectUserEmail: jest.fn().mockResolvedValue({ messageId: "x" }),
}));

import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { User } from "../models/User";
import { MessageModel } from "../models/Message";
import { MeetingModel } from "../models/Meeting";
import Notification from "../models/Notification";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HOUR = 3_600_000;

describe("messages to selected people / everyone", () => {
  it("sends one copy per selected person and lists it once in Sent", async () => {
    const ceo = await createUserWithToken("ceo");
    const a = await createUserWithToken("supervisor");
    const b = await createUserWithToken("supervisor");

    const res = await request(app)
      .post("/api/messages")
      .set(auth(ceo.token))
      .send({
        audience: "selected",
        recipientIds: [String(a.user._id), String(b.user._id)],
        subject: "Planning",
        body: "Please review",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(2);
    expect(await MessageModel.countDocuments({ subject: "Planning" })).toBe(2);

    const sent = await request(app).get("/api/messages/sent").set(auth(ceo.token));
    const planning = (sent.body.data.messages ?? sent.body.data).filter(
      (m: any) => m.subject === "Planning",
    );
    expect(planning).toHaveLength(1);
    expect(planning[0].broadcastRecipientCount).toBe(2);

    // Each recipient sees their own copy.
    const inboxA = await request(app).get("/api/messages/inbox").set(auth(a.token));
    expect(JSON.stringify(inboxA.body)).toContain("Planning");
  });

  it("rejects a selection of fewer than two people", async () => {
    const ceo = await createUserWithToken("ceo");
    const a = await createUserWithToken("supervisor");
    const res = await request(app)
      .post("/api/messages")
      .set(auth(ceo.token))
      .send({ audience: "selected", recipientIds: [String(a.user._id)], body: "x" });
    expect(res.status).toBe(400);
  });

  it("sends to everyone except the sender", async () => {
    const ceo = await createUserWithToken("ceo");
    await createUserWithToken("supervisor");
    const total = await User.countDocuments({ isActive: true, _id: { $ne: ceo.user._id } });
    const res = await request(app)
      .post("/api/messages")
      .set(auth(ceo.token))
      .send({ audience: "everyone", subject: "All hands", body: "Hello" });
    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(total);
    expect(
      await MessageModel.countDocuments({ subject: "All hands", receiverId: ceo.user._id }),
    ).toBe(0);
  });
});

describe("emails to selected people", () => {
  it("requires at least two recipients", async () => {
    const ceo = await createUserWithToken("ceo");
    const a = await createUserWithToken("supervisor");
    const res = await request(app)
      .post("/api/emails/group")
      .set(auth(ceo.token))
      .send({ recipientIds: [String(a.user._id)], subject: "s", body: "b" });
    expect(res.status).toBe(400);
  });
});

describe("presence", () => {
  it("heartbeat marks me online, others see me, logout removes me", async () => {
    const me = await createUserWithToken("supervisor", { name: "Presence Me" });
    const other = await createUserWithToken("accountant", { name: "Presence Other" });

    const hb = await request(app).post("/api/presence/heartbeat").set(auth(me.token));
    expect(hb.status).toBe(200);
    expect(hb.body.data.users.map((u: any) => u.name)).toContain("Presence Me");

    const seen = await request(app).get("/api/presence/online").set(auth(other.token));
    expect(seen.body.data.users.map((u: any) => u.name)).toContain("Presence Me");
    expect(seen.body.data.users.map((u: any) => u.name)).not.toContain("Presence Other");

    await request(app).post("/api/auth/logout").set(auth(me.token));
    const after = await request(app).get("/api/presence/online").set(auth(other.token));
    expect(after.body.data.users.map((u: any) => u.name)).not.toContain("Presence Me");
  });

  it("does not count someone last seen long ago", async () => {
    const stale = await createUserWithToken("sales_person", { name: "Stale Sam" });
    await User.updateOne({ _id: stale.user._id }, { lastSeenAt: new Date(Date.now() - HOUR) });
    const viewer = await createUserWithToken("ceo");
    const res = await request(app).get("/api/presence/online").set(auth(viewer.token));
    expect(res.body.data.users.map((u: any) => u.name)).not.toContain("Stale Sam");
  });
});

describe("notifications and upcoming events", () => {
  it("shows soon/in-progress events until they end, and only to participants", async () => {
    const organizer = await createUserWithToken("supervisor");
    const invitee = await createUserWithToken("accountant");
    const outsider = await createUserWithToken("sales_person");
    const now = Date.now();

    const mk = (title: string, startOffset: number, endOffset: number) =>
      MeetingModel.create({
        title,
        organizer: organizer.user._id,
        attendees: [{ userId: invitee.user._id, status: "pending" }],
        startTime: new Date(now + startOffset),
        endTime: new Date(now + endOffset),
        status: "scheduled",
      });
    await mk("Soon", 2 * HOUR, 3 * HOUR);
    await mk("Live", -HOUR / 2, HOUR / 2);
    await mk("Finished", -3 * HOUR, -2 * HOUR);
    await mk("Next month", 40 * 24 * HOUR, 40 * 24 * HOUR + HOUR);

    const res = await request(app)
      .get("/api/notifications/upcoming-events")
      .set(auth(invitee.token));
    const titles = res.body.data.events.map((e: any) => e.title);
    expect(titles).toEqual(["Live", "Soon"]);
    expect(res.body.data.events[0].inProgress).toBe(true);

    const none = await request(app)
      .get("/api/notifications/upcoming-events")
      .set(auth(outsider.token));
    expect(none.body.data.events).toHaveLength(0);
  });

  it("creates one event reminder per meeting stage and can mark all read", async () => {
    const u = await createUserWithToken("supervisor");
    await MeetingModel.create({
      title: "Starts soon",
      organizer: u.user._id,
      attendees: [],
      startTime: new Date(Date.now() + 30 * 60_000),
      endTime: new Date(Date.now() + 90 * 60_000),
      status: "scheduled",
    });

    const first = await request(app).get("/api/notifications").set(auth(u.token));
    expect(first.status).toBe(200);
    const reminders = await Notification.find({ userId: u.user._id, type: "event_reminder" });
    expect(reminders).toHaveLength(1);
    expect(first.body.data.unreadCount).toBeGreaterThanOrEqual(1);

    // Fetching again must not duplicate the reminder.
    await request(app).get("/api/notifications").set(auth(u.token));
    expect(await Notification.countDocuments({ userId: u.user._id, type: "event_reminder" })).toBe(1);

    await request(app).post("/api/notifications/read-all").set(auth(u.token));
    const after = await request(app).get("/api/notifications").set(auth(u.token));
    expect(after.body.data.unreadCount).toBe(0);
  });
});