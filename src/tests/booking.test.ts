import "./testEnv";

// Capture outgoing email instead of sending it.
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

// Zoho Calendar: no network. `mockZoho` lets each test choose whether the
// owner has a connected calendar and whether creating an event succeeds.
const mockZoho: {
  session: any;
  createZohoEvent: jest.Mock;
  updateZohoEvent: jest.Mock;
} = {
  session: null,
  createZohoEvent: jest.fn(),
  updateZohoEvent: jest.fn(),
};
jest.mock("../services/zohoCalendarService", () => {
  const actual = jest.requireActual("../services/zohoCalendarService");
  return {
    ...actual,
    isZohoCalendarConfigured: () => true,
    getZohoCalendarSession: async () => mockZoho.session,
    getZohoBusyWindows: async () => [],
    createZohoEvent: (...a: any[]) => mockZoho.createZohoEvent(...a),
    updateZohoEvent: (...a: any[]) => mockZoho.updateZohoEvent(...a),
    // These suites aren't about the meeting password: no password, no network.
    fetchZohoMeetingPassword: async () => ({ status: "ok" as const }),
  };
});

import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { BookingLinkModel } from "../models/BookingLink";
import { MeetingModel } from "../models/Meeting";
import { MeetingActivityModel } from "../models/MeetingActivity";
import { CalendarBlockModel } from "../models/CalendarBlock";
import { ClientModel } from "../models/Client";
import Notification from "../models/Notification";
import { BookingLockModel } from "../services/bookingLock";

beforeAll(async () => {
  await startTestDb();
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  sent.length = 0;
  mockZoho.session = null;
  mockZoho.createZohoEvent.mockReset();
  mockZoho.updateZohoEvent.mockReset();
  mockZoho.updateZohoEvent.mockImplementation(async (i: any) => ({
    status: "updated",
    uid: i.uid,
    etag: "etag-2",
  }));
});

afterEach(async () => {
  await Promise.all([
    BookingLinkModel.deleteMany({}),
    MeetingModel.deleteMany({}),
    MeetingActivityModel.deleteMany({}),
    CalendarBlockModel.deleteMany({}),
    ClientModel.deleteMany({}),
    Notification.deleteMany({}),
    BookingLockModel.deleteMany({}),
  ]);
});

// ── helpers ──────────────────────────────────────────────────────
const HOUR = 3_600_000;
let ipCounter = 0;
/** Each request comes from its own "IP" so the public rate limiters (which
 *  are per-IP) don't trip over the volume of requests this file makes. */
const freshIp = () => `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/** Open every day, all day, hourly slots: a slot always exists tomorrow,
 *  whatever day the tests run on. */
const OPEN_ALL_DAY = {
  workDays: [0, 1, 2, 3, 4, 5, 6],
  workStartHour: 0,
  workEndHour: 24,
  durationMinutes: 60,
  slotStepMinutes: 60,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
};

/** A start time on the hourly grid, ~a day from now. */
const slotAt = (hoursFromTomorrow = 0): Date => {
  const t = Math.ceil((Date.now() + 24 * HOUR) / HOUR) * HOUR + hoursFromTomorrow * HOUR;
  return new Date(t);
};

const setup = async (overrides: Record<string, unknown> = {}) => {
  const { user: ceo, token } = await createUserWithToken("ceo", { name: "Ada CEO" });
  const res = await request(app)
    .post("/api/booking-links")
    .set("Authorization", `Bearer ${token}`)
    .send({ title: "Intro call", ...OPEN_ALL_DAY, ...overrides });
  expect(res.status).toBe(201);
  return { ceo, token, link: res.body.data as { _id: string; slug: string; url: string } };
};

const book = (slug: string, body: Record<string, unknown>, ip = freshIp()) =>
  request(app).post(`/api/public/booking/${slug}/book`).set("X-Forwarded-For", ip).send(body);

const getSlots = (slug: string) =>
  request(app).get(`/api/public/booking/${slug}/slots`).set("X-Forwarded-For", freshIp());

const allStarts = (body: any): string[] =>
  body.data.days.flatMap((d: any) => d.slots.map((s: any) => s.start));

const client = (over: Record<string, unknown> = {}) => ({
  name: "Jane Client",
  email: "jane@client.com",
  topic: "Annual audit",
  ...over,
});

// ═════════════════════════════════════════════════════════════════
describe("managing booking links (owner)", () => {
  it("creates a link with a shareable URL and sensible defaults", async () => {
    const { ceo, token } = await setup();
    const res = await request(app).get("/api/booking-links").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const l = res.body.data[0];
    expect(l.url).toBe(`http://localhost:5173/book/${l.slug}`);
    expect(l.slug).toMatch(/^[a-z0-9]{10}$/);
    expect(l.autoZohoMeeting).toBe(true);
    expect(l.isActive).toBe(true);
    const row = await BookingLinkModel.findById(l._id);
    expect(String(row!.ownerId)).toBe(String(ceo._id));
  });

  it("requires login", async () => {
    expect((await request(app).get("/api/booking-links")).status).toBe(401);
    expect((await request(app).post("/api/booking-links").send({ title: "x" })).status).toBe(401);
  });

  it("rejects invalid settings with a clear message", async () => {
    const { token } = await createUserWithToken("ceo");
    const post = (b: object) =>
      request(app).post("/api/booking-links").set("Authorization", `Bearer ${token}`).send(b);

    expect((await post({})).status).toBe(400); // no title
    expect((await post({ title: "x", workStartHour: 17, workEndHour: 9 })).body.message).toMatch(/after the start/i);
    expect((await post({ title: "x", durationMinutes: 5 })).status).toBe(400);
    expect((await post({ title: "x", durationMinutes: 480 })).status).toBe(400);
    expect((await post({ title: "x", workDays: [] })).status).toBe(400);
    expect((await post({ title: "x", workDays: [7] })).status).toBe(400);
    expect((await post({ title: "x", slotStepMinutes: 7 })).status).toBe(400);
    expect((await post({ title: "x", meetingLink: "javascript:alert(1)" })).status).toBe(400);
    expect((await post({ title: "x", slug: "Bad Slug!" })).status).toBe(400);
    expect((await post({ title: "x", slug: "admin" })).status).toBe(400);
    // 60-min meeting can't fit a 30-min working day
    expect(
      (await post({ title: "x", durationMinutes: 60, workStartHour: 9, workEndHour: 9 })).status,
    ).toBe(400);
  });

  it("supports a custom link name and refuses duplicates", async () => {
    const { token } = await createUserWithToken("ceo");
    const post = (b: object) =>
      request(app).post("/api/booking-links").set("Authorization", `Bearer ${token}`).send(b);
    const first = await post({ title: "A", slug: "ada-intro" });
    expect(first.status).toBe(201);
    expect(first.body.data.slug).toBe("ada-intro");
    const dup = await post({ title: "B", slug: "ada-intro" });
    expect(dup.status).toBe(409);
  });

  it("only the owner can change or delete a link", async () => {
    const { link } = await setup();
    const { token: other } = await createUserWithToken("ceo");
    const put = await request(app)
      .put(`/api/booking-links/${link._id}`)
      .set("Authorization", `Bearer ${other}`)
      .send({ title: "hijacked" });
    expect(put.status).toBe(404);
    const del = await request(app)
      .delete(`/api/booking-links/${link._id}`)
      .set("Authorization", `Bearer ${other}`);
    expect(del.status).toBe(404);
    expect((await BookingLinkModel.findById(link._id))!.title).toBe("Intro call");
  });

  it("updates, validating against the existing values", async () => {
    const { token, link } = await setup();
    const ok = await request(app)
      .put(`/api/booking-links/${link._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Deep dive", durationMinutes: 120 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.title).toBe("Deep dive");
    // end hour alone can't go before the stored start hour (0)
    const bad = await request(app)
      .put(`/api/booking-links/${link._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ workEndHour: 1 });
    expect(bad.status).toBe(400); // 120-min meeting no longer fits
  });
});

// ═════════════════════════════════════════════════════════════════
describe("public booking page", () => {
  it("shows what clients need and nothing about the owner's account", async () => {
    const { link } = await setup({ description: "Let's talk", location: "Online" });
    const res = await request(app).get(`/api/public/booking/${link.slug}`).set("X-Forwarded-For", freshIp());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      title: "Intro call",
      hostName: "Ada CEO",
      durationMinutes: 60,
      timezone: "Africa/Nairobi",
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/@test\.com/);
    expect(raw).not.toMatch(/ownerId/);
  });

  it("404s for unknown, inactive and deleted links", async () => {
    const { token, link } = await setup();
    const get = (slug: string) =>
      request(app).get(`/api/public/booking/${slug}`).set("X-Forwarded-For", freshIp());
    expect((await get("nope-not-real")).status).toBe(404);

    await request(app)
      .put(`/api/booking-links/${link._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: false });
    expect((await get(link.slug)).status).toBe(404);
    expect((await getSlots(link.slug)).status).toBe(404);
    expect((await book(link.slug, { ...client(), startTime: slotAt().toISOString() })).status).toBe(404);

    await request(app).put(`/api/booking-links/${link._id}`).set("Authorization", `Bearer ${token}`).send({ isActive: true });
    expect((await get(link.slug)).status).toBe(200);
    await request(app).delete(`/api/booking-links/${link._id}`).set("Authorization", `Bearer ${token}`);
    expect((await get(link.slug)).status).toBe(404);
  });

  it("offers open slots but hides busy time — and never reveals why it's busy", async () => {
    const { ceo, link } = await setup();
    const t = slotAt(0);

    await MeetingModel.create({
      title: "SECRET board meeting",
      organizer: ceo._id,
      startTime: t,
      endTime: new Date(t.getTime() + HOUR),
      status: "scheduled",
    });
    await CalendarBlockModel.create({
      userId: ceo._id,
      title: "SECRET dentist",
      type: "personal",
      startTime: new Date(t.getTime() + 3 * HOUR),
      endTime: new Date(t.getTime() + 4 * HOUR),
    });

    const res = await getSlots(link.slug);
    expect(res.status).toBe(200);
    const starts = allStarts(res.body);
    expect(starts).not.toContain(t.toISOString()); // the meeting hour
    expect(starts).not.toContain(new Date(t.getTime() + 3 * HOUR).toISOString()); // the blocked hour
    expect(starts).toContain(new Date(t.getTime() - HOUR).toISOString()); // just before
    expect(starts).toContain(new Date(t.getTime() + HOUR).toISOString()); // just after the meeting
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET/);
  });

  it("applies the buffer around existing meetings", async () => {
    const { ceo, link } = await setup({ bufferMinutes: 30 });
    const t = slotAt(2);
    await MeetingModel.create({
      title: "x",
      organizer: ceo._id,
      startTime: t,
      endTime: new Date(t.getTime() + HOUR),
      status: "scheduled",
    });
    const starts = allStarts((await getSlots(link.slug)).body);
    // 1h slots touching the meeting now violate the 30-min buffer
    expect(starts).not.toContain(new Date(t.getTime() - HOUR).toISOString());
    expect(starts).not.toContain(new Date(t.getTime() + HOUR).toISOString());
    expect(starts).toContain(new Date(t.getTime() - 2 * HOUR).toISOString());
    expect(starts).toContain(new Date(t.getTime() + 2 * HOUR).toISOString());
  });

  it("ignores cancelled and postponed meetings (those times are free again)", async () => {
    const { ceo, link } = await setup();
    const t = slotAt(1);
    for (const status of ["cancelled", "postponed"]) {
      await MeetingModel.create({
        title: status,
        organizer: ceo._id,
        startTime: t,
        endTime: new Date(t.getTime() + HOUR),
        status,
      });
    }
    expect(allStarts((await getSlots(link.slug)).body)).toContain(t.toISOString());
  });
});

// ═════════════════════════════════════════════════════════════════
describe("booking a slot", () => {
  it("creates the meeting, invites the client, notifies the owner and logs it", async () => {
    mockZoho.session = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };
    mockZoho.createZohoEvent.mockResolvedValue({ uid: "ev1", etag: "e1", meetingKey: "MK-42" });
    const { ceo, link } = await setup({ location: "" });
    const t = slotAt(0);

    const res = await book(link.slug, { ...client(), startTime: t.toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ hostName: "Ada CEO" });
    expect(res.body.data.meetingLink).toMatch(/MK-42/);

    const meetings = await MeetingModel.find({});
    expect(meetings).toHaveLength(1);
    const m = meetings[0];
    expect(String(m.organizer)).toBe(String(ceo._id));
    expect(m.startTime.toISOString()).toBe(t.toISOString());
    expect(m.endTime.getTime() - m.startTime.getTime()).toBe(HOUR);
    expect(m.externalAttendees.map((e) => e.email)).toEqual(["jane@client.com"]);
    expect(m.externalAttendees[0].name).toBe("Jane Client");
    expect(m.agenda).toBe("Annual audit");
    expect(String(m.bookingLinkId)).toBe(link._id);
    expect(m.conferenceProvider).toBe("zoho_meeting");
    expect(m.calendarEventUid).toBe("ev1");
    expect(m.location).toBe("Online");
    // The event made with the Zoho Meeting is reused, not duplicated.
    expect(mockZoho.createZohoEvent).toHaveBeenCalledTimes(1);
    expect(mockZoho.updateZohoEvent).toHaveBeenCalledTimes(1);

    // Client's invitation, with working Accept / Decline links.
    const mail = sent.find((s) => ([] as string[]).concat(s.to).includes("jane@client.com"));
    expect(mail).toBeDefined();
    expect(mail.html).toMatch(/meeting-rsvp/);
    expect(mail.html).toMatch(/MK-42/);

    // Owner is told, with a deep link to the meeting.
    const notes = await Notification.find({ userId: ceo._id, type: "meeting_booked" });
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/Jane Client/);
    expect((notes[0] as any).meta.meetingId).toBe(String(m._id));

    // Automatic activity trail.
    const acts = await MeetingActivityModel.find({ meetingId: m._id });
    expect(acts.map((a) => a.action)).toContain("meeting_created");

    // The slot is gone for the next visitor.
    expect(allStarts((await getSlots(link.slug)).body)).not.toContain(t.toISOString());
  });

  it("uses the link's fixed meeting link and skips Zoho Meeting creation", async () => {
    mockZoho.session = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };
    mockZoho.createZohoEvent.mockResolvedValue({ uid: "ev1", etag: "e1", meetingKey: "SHOULD-NOT-BE-USED" });
    const { link } = await setup({ meetingLink: "https://meet.example.com/ada" });
    const res = await book(link.slug, { ...client(), startTime: slotAt().toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.data.meetingLink).toBe("https://meet.example.com/ada");
    // No Zoho *Meeting* is created — only the plain calendar event that every
    // meeting gets on the owner's Zoho Calendar.
    expect(mockZoho.createZohoEvent).toHaveBeenCalledTimes(1);
    expect(mockZoho.createZohoEvent.mock.calls[0][0].withZohoMeeting).toBeFalsy();
    expect((await MeetingModel.findOne({}))!.conferenceProvider).toBe("custom");
  });

  it("still books when Zoho fails, and tells the owner the link is missing", async () => {
    mockZoho.session = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };
    mockZoho.createZohoEvent.mockRejectedValue(new Error("Zoho down"));
    const { ceo, link } = await setup();
    const res = await book(link.slug, { ...client(), startTime: slotAt().toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.data.meetingLink).toBeUndefined();
    const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booked" });
    expect(note!.message).toMatch(/No meeting link/i);
  });

  it("books fine with no Zoho Calendar connected at all", async () => {
    const { link } = await setup({ location: "Office, Westlands" });
    const res = await book(link.slug, { ...client(), startTime: slotAt().toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.data.location).toBe("Office, Westlands");
  });

  it("links the meeting to an existing CRM client with the same email", async () => {
    const { ceo, link } = await setup();
    const crm = await ClientModel.create({
      name: "Jane's Company",
      email: "jane@client.com",
      createdBy: ceo._id,
      assignedTo: [ceo._id],
    });
    await book(link.slug, { ...client(), startTime: slotAt().toISOString() });
    expect(String((await MeetingModel.findOne({}))!.clientId)).toBe(String(crm._id));
  });

  it("refuses a time that is taken, off the grid, or outside the window", async () => {
    const { ceo, link } = await setup();
    const t = slotAt(0);
    await MeetingModel.create({
      title: "x",
      organizer: ceo._id,
      startTime: t,
      endTime: new Date(t.getTime() + HOUR),
      status: "scheduled",
    });
    const taken = await book(link.slug, { ...client(), startTime: t.toISOString() });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("SLOT_TAKEN");

    const offGrid = await book(link.slug, { ...client(), startTime: new Date(slotAt(3).getTime() + 30 * 60_000).toISOString() });
    expect(offGrid.status).toBe(409);

    const farFuture = await book(link.slug, { ...client(), startTime: new Date(Date.now() + 40 * 24 * HOUR).toISOString() });
    expect(farFuture.status).toBe(409);

    expect(await MeetingModel.countDocuments({})).toBe(1); // only the pre-existing one
  });

  it("gives the slot to exactly one person when several book at the same instant", async () => {
    const { link } = await setup();
    const t = slotAt(5).toISOString();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        book(link.slug, { name: `Person ${i}`, email: `p${i}@client.com`, startTime: t }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    // One winner, everyone else told the slot is taken — never two winners,
    // never zero.
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(await MeetingModel.countDocuments({ startTime: new Date(t) })).toBe(1);
    // Only the winner got an invitation.
    expect(sent.filter((m) => /You're invited/.test(m.subject ?? ""))).toHaveLength(1);
  });

  it("also protects against overlapping bookings across different links of one owner", async () => {
    const { ceo, token } = await setup();
    // A second link for the same owner with a longer meeting length.
    const long = await request(app)
      .post("/api/booking-links")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Deep dive", ...OPEN_ALL_DAY, durationMinutes: 120 });
    const links = await BookingLinkModel.find({ ownerId: ceo._id });
    const short = links.find((l) => l.durationMinutes === 60)!;
    const t = slotAt(6);
    const results = await Promise.all([
      book(short.slug, { name: "A", email: "a@client.com", startTime: new Date(t.getTime() + HOUR).toISOString() }),
      book(long.body.data.slug, { name: "B", email: "b@client.com", startTime: t.toISOString() }),
    ]);
    // 60-min at t+1h sits inside the 120-min at t: exactly one can win.
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await MeetingModel.countDocuments({ organizer: ceo._id })).toBe(1);
  });

  it("validates what the client submits", async () => {
    const { link } = await setup();
    const startTime = slotAt().toISOString();
    const cases: [string, Record<string, unknown>][] = [
      ["no name", { ...client({ name: "" }), startTime }],
      ["bad email", { ...client({ email: "not-an-email" }), startTime }],
      ["no time", { ...client() }],
      ["garbage time", { ...client(), startTime: "tomorrow-ish" }],
      ["past time", { ...client(), startTime: new Date(Date.now() - HOUR).toISOString() }],
      ["huge topic", { ...client({ topic: "x".repeat(1001) }), startTime }],
    ];
    for (const [label, body] of cases) {
      const r = await book(link.slug, body);
      expect([label, r.status]).toEqual([label, 400]);
    }
    expect(await MeetingModel.countDocuments({})).toBe(0);
  });

  it("silently ignores bots that fill the hidden honeypot field", async () => {
    const { link } = await setup();
    const r = await book(link.slug, { ...client(), website: "http://spam.example", startTime: slotAt().toISOString() });
    expect(r.status).toBe(201); // looks like success…
    expect(await MeetingModel.countDocuments({})).toBe(0); // …but nothing happened
    expect(sent).toHaveLength(0);
  });

  it("caps upcoming bookings per email address on one link", async () => {
    const { link } = await setup();
    for (let i = 0; i < 3; i++) {
      const ok = await book(link.slug, { ...client(), startTime: slotAt(i).toISOString() });
      expect(ok.status).toBe(201);
    }
    const blocked = await book(link.slug, { ...client(), startTime: slotAt(3).toISOString() });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("TOO_MANY_BOOKINGS");
    // A different person is unaffected.
    const other = await book(link.slug, { name: "Bob", email: "bob@client.com", startTime: slotAt(3).toISOString() });
    expect(other.status).toBe(201);
  });

  it("rate-limits booking attempts from a single address", async () => {
    const { link } = await setup();
    const ip = "203.0.113.50";
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await book(link.slug, { name: "", email: "x", startTime: "bad" }, ip)).status);
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});