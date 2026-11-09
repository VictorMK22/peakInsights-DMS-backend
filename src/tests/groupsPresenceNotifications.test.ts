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
import { ClientModel } from "../models/Client";
import { DocumentModel } from "../models/Document";

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

describe("open communication between any users", () => {
  it("lets a regular user message and email someone outside their reporting line", async () => {
    const a = await createUserWithToken("sales_person");
    const b = await createUserWithToken("accountant");

    const msg = await request(app)
      .post("/api/messages")
      .set(auth(a.token))
      .send({ receiverId: String(b.user._id), subject: "Hi", body: "Cross-department" });
    expect(msg.status).toBe(201);

    const contacts = await request(app).get("/api/messages/contacts").set(auth(a.token));
    expect(contacts.body.data.contacts.map((c: any) => String(c._id))).toContain(String(b.user._id));

    const emailContacts = await request(app).get("/api/emails/contacts").set(auth(a.token));
    expect(emailContacts.body.data.contacts.map((c: any) => String(c._id))).toContain(String(b.user._id));
  });

  it("lets a supervisor invite someone who is not on their team", async () => {
    const sup = await createUserWithToken("supervisor");
    const other = await createUserWithToken("accountant");
    const res = await request(app)
      .post("/api/meetings")
      .set(auth(sup.token))
      .send({
        title: "Cross-team",
        startTime: new Date(Date.now() + 2 * HOUR).toISOString(),
        endTime: new Date(Date.now() + 3 * HOUR).toISOString(),
        attendeeIds: [String(other.user._id)],
      });
    expect(res.status).toBe(201);
    const invitable = await request(app).get("/api/users/invitable").set(auth(sup.token));
    expect(invitable.status).toBe(200);
  });
});

describe("won clients: CEO allocates an accountant", () => {
  const mkLead = async (salesId: any, stage = "in_discussion") =>
    ClientModel.create({
      name: "Acme Ltd",
      isSalesLead: true,
      salesStage: stage,
      assignedTo: [salesId],
      createdBy: salesId,
    } as any);

  it("flags a won lead, notifies the CEO, and lets only the CEO allocate", async () => {
    const ceo = await createUserWithToken("ceo");
    const sales = await createUserWithToken("sales_person");
    const acct = await createUserWithToken("accountant");
    const lead = await mkLead(sales.user._id);

    const won = await request(app)
      .patch(`/api/clients/${lead._id}/stage`)
      .set(auth(sales.token))
      .send({ stage: "won" });
    expect(won.status).toBe(200);
    expect(await Notification.countDocuments({ userId: ceo.user._id, type: "client_won" })).toBe(1);

    const queue = await request(app).get("/api/clients/awaiting-allocation").set(auth(ceo.token));
    expect(queue.body.data.clients.map((c: any) => String(c._id))).toContain(String(lead._id));

    const denied = await request(app)
      .post(`/api/clients/${lead._id}/allocate-accountant`)
      .set(auth(sales.token))
      .send({ accountantId: String(acct.user._id) });
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .post(`/api/clients/${lead._id}/allocate-accountant`)
      .set(auth(ceo.token))
      .send({ accountantId: String(acct.user._id) });
    expect(ok.status).toBe(200);

    const saved = await ClientModel.findById(lead._id).lean();
    const assigned = (saved!.assignedTo ?? []).map(String);
    expect(assigned).toEqual(expect.arrayContaining([String(sales.user._id), String(acct.user._id)]));

    const after = await request(app).get("/api/clients/awaiting-allocation").set(auth(ceo.token));
    expect(after.body.data.clients.map((c: any) => String(c._id))).not.toContain(String(lead._id));
    expect(await Notification.countDocuments({ userId: acct.user._id, type: "client_allocated" })).toBe(1);
  });

  it("rejects allocating a client that has not been won, or a non-accountant", async () => {
    const ceo = await createUserWithToken("ceo");
    const sales = await createUserWithToken("sales_person");
    const acct = await createUserWithToken("accountant");
    const lead = await mkLead(sales.user._id, "proposal_sent");

    const early = await request(app)
      .post(`/api/clients/${lead._id}/allocate-accountant`)
      .set(auth(ceo.token))
      .send({ accountantId: String(acct.user._id) });
    expect(early.status).toBe(400);

    await ClientModel.updateOne({ _id: lead._id }, { salesStage: "won" });
    const wrongRole = await request(app)
      .post(`/api/clients/${lead._id}/allocate-accountant`)
      .set(auth(ceo.token))
      .send({ accountantId: String(sales.user._id) });
    expect(wrongRole.status).toBe(400);
  });
});

describe("documents filed against a client", () => {
  it("sales person uploads for their client; the allocated accountant can see it; strangers cannot", async () => {
    const sales = await createUserWithToken("sales_person");
    const acct = await createUserWithToken("accountant");
    const stranger = await createUserWithToken("sales_person");
    const client = await ClientModel.create({
      name: "Docs Client",
      isSalesLead: true,
      salesStage: "won",
      assignedTo: [sales.user._id, acct.user._id],
      createdBy: sales.user._id,
    } as any);

    const up = await request(app)
      .post("/api/documents")
      .set(auth(sales.token))
      .field("clientId", String(client._id))
      .field("documentType", "working")
      .attach("files", Buffer.from("engagement letter"), "engagement.txt");
    expect(up.status).toBeLessThan(300);
    const doc = await DocumentModel.findOne({ clientId: client._id }).lean();
    expect(doc).toBeTruthy();

    const asAcct = await request(app)
      .get(`/api/clients/${client._id}/documents`)
      .set(auth(acct.token));
    expect(asAcct.status).toBe(200);
    expect(asAcct.body.data.documents).toHaveLength(1);

    const denied = await request(app)
      .get(`/api/clients/${client._id}/documents`)
      .set(auth(stranger.token));
    expect(denied.status).toBe(403);

    const refused = await request(app)
      .post("/api/documents")
      .set(auth(stranger.token))
      .field("clientId", String(client._id))
      .attach("files", Buffer.from("x"), "x.txt");
    expect(refused.status).toBe(403);
  });
});

describe("restrictions removed for everyone", () => {
  it("lets any role send a message to everyone", async () => {
    const acct = await createUserWithToken("accountant");
    await createUserWithToken("supervisor");
    const aud = await request(app).get("/api/messages/broadcast/audience").set(auth(acct.token));
    expect(aud.body.data.allowed).toBe(true);
    const res = await request(app)
      .post("/api/messages")
      .set(auth(acct.token))
      .send({ audience: "everyone", subject: "FYI", body: "Hello all" });
    expect(res.status).toBe(201);
  });

  it("lets a non-CEO invite the whole organisation to a meeting", async () => {
    const sales = await createUserWithToken("sales_person");
    await createUserWithToken("accountant");
    const res = await request(app)
      .post("/api/meetings")
      .set(auth(sales.token))
      .send({
        title: "All hands",
        startTime: new Date(Date.now() + 5 * HOUR).toISOString(),
        endTime: new Date(Date.now() + 6 * HOUR).toISOString(),
        organizationWide: true,
      });
    expect(res.status).toBe(201);
  });

  it("restricts task creation to the CEO and team supervisors", async () => {
    const ceo = await createUserWithToken("ceo");
    const sup = await createUserWithToken("supervisor");
    const acct = await createUserWithToken("accountant");
    const sales = await createUserWithToken("sales_person");
    const tech = await createUserWithToken("tech");
    const target = await createUserWithToken("sales_person");
    const body = { assignedTo: String(target.user._id), title: "Prepare report" };

    for (const who of [acct, sales, tech]) {
      const res = await request(app).post("/api/tasks").set(auth(who.token)).send(body);
      expect(res.status).toBe(403);
    }

    // A supervisor can only assign to their own team — target isn't on it.
    const offTeam = await request(app).post("/api/tasks").set(auth(sup.token)).send(body);
    expect(offTeam.status).toBe(403);

    // The CEO can assign to anyone.
    const ok = await request(app).post("/api/tasks").set(auth(ceo.token)).send(body);
    expect(ok.status).toBe(201);
  });
});