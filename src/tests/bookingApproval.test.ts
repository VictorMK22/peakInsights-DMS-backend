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

// Zoho Calendar: no network.
const mockZoho: {
  session: any;
  createZohoEvent: jest.Mock;
  updateZohoEvent: jest.Mock;
} = { session: null, createZohoEvent: jest.fn(), updateZohoEvent: jest.fn() };
jest.mock("../services/zohoCalendarService", () => {
  const actual = jest.requireActual("../services/zohoCalendarService");
  return {
    ...actual,
    isZohoCalendarConfigured: () => true,
    getZohoCalendarSession: async () => mockZoho.session,
    getZohoBusyWindows: async () => [],
    createZohoEvent: (...a: any[]) => mockZoho.createZohoEvent(...a),
    updateZohoEvent: (...a: any[]) => mockZoho.updateZohoEvent(...a),
  };
});

import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { BookingLinkModel } from "../models/BookingLink";
import { BookingRequestModel } from "../models/BookingRequest";
import { MeetingModel } from "../models/Meeting";
import { MeetingActivityModel } from "../models/MeetingActivity";
import Notification from "../models/Notification";
import { BookingLockModel } from "../services/bookingLock";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});

beforeEach(() => {
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
    BookingRequestModel.deleteMany({}),
    MeetingModel.deleteMany({}),
    MeetingActivityModel.deleteMany({}),
    Notification.deleteMany({}),
    BookingLockModel.deleteMany({}),
  ]);
});

// ── helpers ──────────────────────────────────────────────────────
const HOUR = 3_600_000;
let ipCounter = 0;
const freshIp = () => `10.2.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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

const slotAt = (h = 0): Date =>
  new Date(Math.ceil((Date.now() + 24 * HOUR) / HOUR) * HOUR + h * HOUR);

const setup = async (overrides: Record<string, unknown> = {}) => {
  const { user: ceo, token } = await createUserWithToken("ceo", { name: "Ada CEO" });
  const res = await request(app)
    .post("/api/booking-links")
    .set("Authorization", `Bearer ${token}`)
    .send({ title: "Intro call", ...OPEN_ALL_DAY, requireApproval: true, ...overrides });
  expect(res.status).toBe(201);
  return { ceo, token, link: res.body.data as { _id: string; slug: string } };
};

const book = (slug: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/public/booking/${slug}/book`)
    .set("X-Forwarded-For", freshIp())
    .send(body);

const slotsOf = async (slug: string): Promise<string[]> => {
  const r = await request(app)
    .get(`/api/public/booking/${slug}/slots`)
    .set("X-Forwarded-For", freshIp());
  return r.body.data.days.flatMap((d: any) => d.slots.map((s: any) => s.start));
};

const jane = (over: Record<string, unknown> = {}) => ({
  name: "Jane Client",
  email: "jane@client.com",
  topic: "Annual audit",
  ...over,
});

const mailsTo = (addr: string) =>
  sent.filter((m) => ([] as string[]).concat(m.to).includes(addr));

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const approve = (token: string, id: string) =>
  request(app).post(`/api/booking-links/requests/${id}/approve`).set(auth(token)).send({});
const decline = (token: string, id: string, reason?: string) =>
  request(app).post(`/api/booking-links/requests/${id}/decline`).set(auth(token)).send({ reason });
const listRequests = (token: string) =>
  request(app).get("/api/booking-links/requests").set(auth(token));

/** Makes a pending request directly, bypassing the public API. */
const makeRequest = (
  ownerId: unknown,
  linkId: unknown,
  startHours: number,
  over: Record<string, unknown> = {},
) => {
  const start = slotAt(startHours);
  return BookingRequestModel.create({
    linkId,
    ownerId,
    linkTitle: "Intro call",
    startTime: start,
    endTime: new Date(start.getTime() + HOUR),
    name: "Direct Person",
    email: "direct@client.com",
    ...over,
  });
};

// ═════════════════════════════════════════════════════════════════
describe("choosing approval vs instant confirmation", () => {
  it("defaults to instant confirmation and lets the owner switch either way", async () => {
    const { token, link } = await setup({ requireApproval: undefined });
    const list = await request(app).get("/api/booking-links").set(auth(token));
    expect(list.body.data[0].requireApproval).toBe(false);

    const on = await request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send({ requireApproval: true });
    expect(on.body.data.requireApproval).toBe(true);
    const off = await request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send({ requireApproval: false });
    expect(off.body.data.requireApproval).toBe(false);

    const bad = await request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send({ requireApproval: "yes" });
    expect(bad.status).toBe(400);
  });

  it("tells the booking page whether the host approves requests", async () => {
    const { link } = await setup();
    const r = await request(app).get(`/api/public/booking/${link.slug}`).set("X-Forwarded-For", freshIp());
    expect(r.body.data.requiresApproval).toBe(true);
  });

  it("an instant link still confirms immediately", async () => {
    const { link } = await setup({ requireApproval: false });
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("confirmed");
    expect(await MeetingModel.countDocuments({})).toBe(1);
    expect(await BookingRequestModel.countDocuments({})).toBe(0);
  });

  it("switching to instant leaves already-waiting requests waiting", async () => {
    const { ceo, token, link } = await setup();
    await book(link.slug, { ...jane(), startTime: slotAt(0).toISOString() });
    await request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send({ requireApproval: false });
    const next = await book(link.slug, { name: "Bob", email: "bob@client.com", startTime: slotAt(3).toISOString() });
    expect(next.body.data.status).toBe("confirmed");
    expect((await listRequests(token)).body.data).toHaveLength(1);
    expect(await BookingRequestModel.countDocuments({ ownerId: ceo._id, status: "pending" })).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("a request waiting for approval", () => {
  it("holds the slot but creates no meeting, no invitation and no calendar event", async () => {
    mockZoho.session = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };
    const { ceo, link } = await setup();
    const t = slotAt(0);

    const r = await book(link.slug, { ...jane(), startTime: t.toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("pending");
    expect(r.body.data.requestId).toBeDefined();
    expect(r.body.data.meetingLink).toBeUndefined();

    expect(await MeetingModel.countDocuments({})).toBe(0);
    expect(mockZoho.createZohoEvent).not.toHaveBeenCalled();
    expect(sent.some((m) => /You're invited/.test(m.subject))).toBe(false);

    // The client is told it's awaiting approval; the host is told too.
    const clientMail = mailsTo("jane@client.com");
    expect(clientMail).toHaveLength(1);
    expect(clientMail[0].subject).toMatch(/Request received/);
    expect(clientMail[0].html).toMatch(/Nothing is confirmed yet/);
    expect(mailsTo(ceo.email as string).some((m) => /Booking request/.test(m.subject))).toBe(true);
    const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booking_request" });
    expect(note!.message).toMatch(/Jane Client/);

    // The slot is held for everyone else.
    expect(await slotsOf(link.slug)).not.toContain(t.toISOString());
    const rival = await book(link.slug, { name: "Rival", email: "rival@client.com", startTime: t.toISOString() });
    expect(rival.status).toBe(409);
  });

  it("also blocks overlapping times on the owner's other links", async () => {
    const { token, link } = await setup();
    const t = slotAt(2);
    await book(link.slug, { ...jane(), startTime: t.toISOString() });
    const other = await request(app)
      .post("/api/booking-links")
      .set(auth(token))
      .send({ title: "Quick chat", ...OPEN_ALL_DAY, durationMinutes: 30, slotStepMinutes: 30 });
    const clash = await book(other.body.data.slug, {
      name: "B", email: "b@client.com", startTime: new Date(t.getTime() + 30 * 60_000).toISOString(),
    });
    expect(clash.status).toBe(409);
  });

  it("appears in the owner's queue, and nobody else's", async () => {
    const { token, link } = await setup();
    await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    const mine = await listRequests(token);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ name: "Jane Client", email: "jane@client.com", topic: "Annual audit", expired: false });

    const { token: other } = await createUserWithToken("ceo");
    expect((await listRequests(other)).body.data).toEqual([]);
    expect((await request(app).get("/api/booking-links/requests")).status).toBe(401);
  });

  it("counts towards the per-email limit and a per-link waiting limit", async () => {
    const { ceo, token, link } = await setup();
    for (let i = 0; i < 3; i++) {
      expect((await book(link.slug, { ...jane(), startTime: slotAt(i).toISOString() })).status).toBe(201);
    }
    const fourth = await book(link.slug, { ...jane(), startTime: slotAt(3).toISOString() });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe("TOO_MANY_BOOKINGS");
    expect(token).toBeDefined();

    // 20 waiting requests from distinct people fill the link…
    for (let i = 0; i < 17; i++) {
      await makeRequest(ceo._id, link._id, 10 + i, { email: `p${i}@client.com` });
    }
    const overflow = await book(link.slug, { name: "Late", email: "late@client.com", startTime: slotAt(40).toISOString() });
    expect(overflow.status).toBe(429);
    expect(overflow.body.code).toBe("TOO_MANY_PENDING");
  });
});

// ═════════════════════════════════════════════════════════════════
describe("approving a request", () => {
  it("turns it into a fully confirmed meeting with a video link and an invitation", async () => {
    mockZoho.session = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };
    mockZoho.createZohoEvent.mockResolvedValue({ uid: "ev9", etag: "e1", meetingKey: "MK-77" });
    const { ceo, token, link } = await setup();
    const t = slotAt(0);
    const made = await book(link.slug, { ...jane(), startTime: t.toISOString() });

    const res = await approve(token, made.body.data.requestId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("confirmed");
    expect(res.body.data.meetingLink).toMatch(/MK-77/);

    const m = (await MeetingModel.find({}))[0];
    expect(String(m.organizer)).toBe(String(ceo._id));
    expect(m.startTime.toISOString()).toBe(t.toISOString());
    expect(m.externalAttendees.map((e) => e.email)).toEqual(["jane@client.com"]);
    expect(m.agenda).toBe("Annual audit");
    expect(m.conferenceProvider).toBe("zoho_meeting");
    expect(m.calendarEventUid).toBe("ev9");
    expect(String(m.bookingLinkId)).toBe(link._id);

    const invite = mailsTo("jane@client.com").find((x) => /You're invited/.test(x.subject));
    expect(invite).toBeDefined();
    expect(invite!.html).toMatch(/meeting-rsvp/);

    const reqRow = await BookingRequestModel.findById(made.body.data.requestId);
    expect(reqRow!.status).toBe("approved");
    expect(String(reqRow!.meetingId)).toBe(String(m._id));

    // No "someone booked" ping for something the owner just approved.
    expect(await Notification.countDocuments({ userId: ceo._id, type: "meeting_booked" })).toBe(0);
    const acts = await MeetingActivityModel.find({ meetingId: m._id });
    expect(acts.map((a) => a.action)).toContain("meeting_created");

    // It leaves the queue, and the slot stays taken (now by the meeting).
    expect((await listRequests(token)).body.data).toEqual([]);
    expect(await slotsOf(link.slug)).not.toContain(t.toISOString());
  });

  it("is safe to click twice, or from two tabs at once", async () => {
    const { token, link } = await setup();
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    const id = made.body.data.requestId;

    const results = await Promise.all([approve(token, id), approve(token, id), approve(token, id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await MeetingModel.countDocuments({})).toBe(1);
    expect(mailsTo("jane@client.com").filter((m) => /You're invited/.test(m.subject))).toHaveLength(1);

    const again = await approve(token, id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_DECIDED");
  });

  it("only the link owner can approve", async () => {
    const { link } = await setup();
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    const { token: stranger } = await createUserWithToken("ceo");
    expect((await approve(stranger, made.body.data.requestId)).status).toBe(404);
    expect((await decline(stranger, made.body.data.requestId)).status).toBe(404);
    expect((await approve(stranger, "not-an-id")).status).toBe(404);
    expect(await MeetingModel.countDocuments({})).toBe(0);
  });

  it("refuses — and keeps the request — if the host has since booked something else there", async () => {
    const { ceo, token, link } = await setup();
    const t = slotAt(0);
    const made = await book(link.slug, { ...jane(), startTime: t.toISOString() });
    await MeetingModel.create({
      title: "Board", organizer: ceo._id, startTime: t,
      endTime: new Date(t.getTime() + HOUR), status: "scheduled",
    });
    const res = await approve(token, made.body.data.requestId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_CONFLICT");
    expect(await MeetingModel.countDocuments({})).toBe(1); // only the board meeting
    expect((await BookingRequestModel.findById(made.body.data.requestId))!.status).toBe("pending");
    expect(mailsTo("jane@client.com").some((m) => /You're invited/.test(m.subject))).toBe(false);
    // …and it can still be declined.
    expect((await decline(token, made.body.data.requestId, "Sorry, clash")).status).toBe(200);
  });

  it("still works after the booking link has been deleted", async () => {
    const { token, link } = await setup();
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    await request(app).delete(`/api/booking-links/${link._id}`).set(auth(token));
    const res = await approve(token, made.body.data.requestId);
    expect(res.status).toBe(200);
    expect(await MeetingModel.countDocuments({})).toBe(1);
  });

  it("can't approve a request whose time has already passed", async () => {
    const { ceo, token, link } = await setup();
    const past = await BookingRequestModel.create({
      linkId: link._id, ownerId: ceo._id, linkTitle: "Intro call",
      startTime: new Date(Date.now() - 3 * HOUR), endTime: new Date(Date.now() - 2 * HOUR),
      name: "Old Request", email: "old@client.com",
    });
    const listed = await listRequests(token);
    expect(listed.body.data[0]).toMatchObject({ name: "Old Request", expired: true });
    const res = await approve(token, String(past._id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EXPIRED");
    // It can still be closed out, which also lets the client know.
    expect((await decline(token, String(past._id))).status).toBe(200);
    expect(mailsTo("old@client.com")).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("declining a request", () => {
  it("frees the slot and tells the client, with the host's note", async () => {
    const { token, link } = await setup();
    const t = slotAt(0);
    const made = await book(link.slug, { ...jane(), startTime: t.toISOString() });
    sent.length = 0;

    const res = await decline(token, made.body.data.requestId, "I'm travelling that day");
    expect(res.status).toBe(200);

    const reqRow = await BookingRequestModel.findById(made.body.data.requestId);
    expect(reqRow!.status).toBe("declined");
    expect(reqRow!.declineReason).toBe("I'm travelling that day");
    expect(await MeetingModel.countDocuments({})).toBe(0);

    const mail = mailsTo("jane@client.com");
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toMatch(/Update on your booking request/);
    expect(mail[0].html).toMatch(/travelling that day/);
    expect(mail[0].html).toMatch(new RegExp(`/book/${link.slug}`)); // a way to pick another time

    expect(await slotsOf(link.slug)).toContain(t.toISOString());
    expect((await listRequests(token)).body.data).toEqual([]);
    // Someone else can now take it.
    const next = await book(link.slug, { name: "Next", email: "next@client.com", startTime: t.toISOString() });
    expect(next.status).toBe(201);
  });

  it("can't be approved afterwards, and works without a reason", async () => {
    const { token, link } = await setup();
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect((await decline(token, made.body.data.requestId)).status).toBe(200);
    expect((await decline(token, made.body.data.requestId)).status).toBe(409);
    const a = await approve(token, made.body.data.requestId);
    expect(a.status).toBe(409);
    expect(a.body.code).toBe("ALREADY_DECIDED");
  });

  it("escapes anything typed into the reason", async () => {
    const { token, link } = await setup();
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    await decline(token, made.body.data.requestId, `<img src=x onerror=alert(1)>`);
    const mail = mailsTo("jane@client.com").find((m) => /Update on your booking/.test(m.subject))!;
    expect(mail.html).not.toMatch(/<img src=x/);
    expect(mail.html).toMatch(/&lt;img src=x/);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("emails built from public form input are safe", () => {
  it("escapes HTML in a client's name so it can't inject links into the invitation", async () => {
    const { link } = await setup({ requireApproval: false });
    const evil = `<a href="https://evil.test/login">Verify your account</a>`;
    const r = await book(link.slug, { name: evil, email: "victim@client.com", startTime: slotAt().toISOString() });
    expect(r.status).toBe(201);
    const invite = mailsTo("victim@client.com").find((m) => /You're invited/.test(m.subject))!;
    expect(invite.html).not.toMatch(/<a href="https:\/\/evil\.test/);
    expect(invite.html).toMatch(/&lt;a href=/);
  });

  it("escapes HTML in the request-received and host emails too", async () => {
    const { ceo, link } = await setup();
    const evil = `<script>alert(1)</script>`;
    await book(link.slug, { name: evil, email: "x@client.com", topic: evil, startTime: slotAt().toISOString() });
    for (const m of [...mailsTo("x@client.com"), ...mailsTo(ceo.email as string)]) {
      expect(m.html).not.toMatch(/<script>alert/);
    }
    expect(mailsTo(ceo.email as string)[0].html).toMatch(/&lt;script&gt;/);
  });

  it("collapses newlines and control characters in the name", async () => {
    const { link } = await setup({ requireApproval: false });
    await book(link.slug, { name: "Jane\r\nBcc: attacker@evil.test", email: "jane@client.com", startTime: slotAt().toISOString() });
    const m = (await MeetingModel.find({}))[0];
    expect(m.externalAttendees[0].name).toBe("Jane Bcc: attacker@evil.test");
    expect(m.title).not.toMatch(/[\r\n]/);
  });

  it("only links a meeting URL that is plain http(s)", async () => {
    const { link } = await setup({ requireApproval: false });
    await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    await MeetingModel.updateOne({}, { meetingLink: "javascript:alert(1)" });
    // Re-send an invitation through the same template the booking uses.
    const { sendMeetingInviteEmail } = await import("../services/emailService");
    sent.length = 0;
    await sendMeetingInviteEmail({
      toEmail: "t@client.com", toName: "T", meetingId: "1", title: "Hi", organizerName: "O",
      startTime: new Date(), endTime: new Date(Date.now() + HOUR),
      meetingLink: "javascript:alert(1)",
    });
    expect(sent[0].html).not.toMatch(/javascript:/);
  });
});
