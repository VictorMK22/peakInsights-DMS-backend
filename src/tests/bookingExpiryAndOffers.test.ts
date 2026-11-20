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
process.env.CRON_SECRET = "test-cron-secret";

// Zoho Calendar: no network.
const mockZoho: { session: any; createZohoEvent: jest.Mock; updateZohoEvent: jest.Mock } = {
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
import { BookingRequestModel } from "../models/BookingRequest";
import { MeetingModel } from "../models/Meeting";
import { MeetingActivityModel } from "../models/MeetingActivity";
import Notification from "../models/Notification";
import { BookingLockModel } from "../services/bookingLock";
import { sweepBookingRequests } from "../services/bookingService";
import { createOfferToken, verifyOfferToken } from "../utils/bookingOfferToken";

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
  mockZoho.updateZohoEvent.mockImplementation(async (i: any) => ({ status: "updated", uid: i.uid, etag: "e2" }));
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
const freshIp = () => `10.3.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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

/** An hour-grid start time, ~a day from now plus `h` hours. */
const slotAt = (h = 0): Date =>
  new Date(Math.ceil((Date.now() + 24 * HOUR) / HOUR) * HOUR + h * HOUR);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const setup = async (overrides: Record<string, unknown> = {}) => {
  const { user: ceo, token } = await createUserWithToken("ceo", { name: "Ada CEO" });
  const res = await request(app)
    .post("/api/booking-links")
    .set(auth(token))
    .send({ title: "Intro call", ...OPEN_ALL_DAY, requireApproval: true, ...overrides });
  expect(res.status).toBe(201);
  return { ceo, token, link: res.body.data as { _id: string; slug: string } };
};

const book = (slug: string, body: Record<string, unknown>) =>
  request(app).post(`/api/public/booking/${slug}/book`).set("X-Forwarded-For", freshIp()).send(body);

const slotsOf = async (slug: string): Promise<string[]> => {
  const r = await request(app).get(`/api/public/booking/${slug}/slots`).set("X-Forwarded-For", freshIp());
  return r.body.data.days.flatMap((d: any) => d.slots.map((s: any) => s.start));
};

const jane = (over: Record<string, unknown> = {}) => ({
  name: "Jane Client",
  email: "jane@client.com",
  topic: "Annual audit",
  ...over,
});

const mailsTo = (addr: string) => sent.filter((m) => ([] as string[]).concat(m.to).includes(addr));

const approve = (token: string, id: string) =>
  request(app).post(`/api/booking-links/requests/${id}/approve`).set(auth(token)).send({});
const decline = (token: string, id: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/booking-links/requests/${id}/decline`).set(auth(token)).send(body);
const listRequests = (token: string) => request(app).get("/api/booking-links/requests").set(auth(token));

/** A request created directly, by default one that has already lapsed (but whose slot is in the future). */
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
    expiresAt: new Date(Date.now() - 60_000),
    ...over,
  });
};

// ═════════════════════════════════════════════════════════════════
describe("how long a request may wait (the reply window)", () => {
  it("defaults to 48 hours and can be set per link", async () => {
    const { token, link } = await setup();
    const list = await request(app).get("/api/booking-links").set(auth(token));
    expect(list.body.data[0].approvalWindowHours).toBe(48);

    const put = (b: object) => request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send(b);
    expect((await put({ approvalWindowHours: 12 })).body.data.approvalWindowHours).toBe(12);
    expect((await put({ approvalWindowHours: 0 })).status).toBe(200); // until the requested time
    expect((await put({ approvalWindowHours: -1 })).status).toBe(400);
    expect((await put({ approvalWindowHours: 169 })).status).toBe(400);
    expect((await put({ approvalWindowHours: "soon" })).status).toBe(400);
    expect((await put({ approvalWindowHours: 1.5 })).status).toBe(400);
  });

  it("stamps each new request with when it lapses, and when to nudge the host", async () => {
    const { link } = await setup({ approvalWindowHours: 48 });
    const far = slotAt(72); // ~4 days out: the window, not the meeting, decides
    const r = await book(link.slug, { ...jane(), startTime: far.toISOString() });
    expect(r.body.data.status).toBe("pending");
    const row = (await BookingRequestModel.findById(r.body.data.requestId))!;
    const created = row.createdAt.getTime();
    expect(Math.abs(row.expiresAt!.getTime() - (created + 48 * HOUR))).toBeLessThan(60_000);
    expect(Math.abs(row.reminderAt!.getTime() - (created + 24 * HOUR))).toBeLessThan(60_000); // halfway
    expect(row.reminderSent).toBe(false);
    expect(new Date(r.body.data.expiresAt).getTime()).toBe(row.expiresAt!.getTime());
  });

  it("never outlives the requested time itself", async () => {
    const { link } = await setup({ approvalWindowHours: 72 });
    const soon = slotAt(0); // ~1 day away, well inside the 72h window
    const r = await book(link.slug, { ...jane(), startTime: soon.toISOString() });
    const row = (await BookingRequestModel.findById(r.body.data.requestId))!;
    expect(row.expiresAt!.getTime()).toBe(soon.getTime());
  });

  it("'until the requested time' (0) lapses exactly at the meeting start", async () => {
    const { link } = await setup({ approvalWindowHours: 0 });
    const t = slotAt(80);
    const r = await book(link.slug, { ...jane(), startTime: t.toISOString() });
    expect((await BookingRequestModel.findById(r.body.data.requestId))!.expiresAt!.getTime()).toBe(t.getTime());
  });
});

// ═════════════════════════════════════════════════════════════════
describe("a request nobody answers", () => {
  it("stops holding its slot the moment it lapses — even before any scheduled sweep", async () => {
    const { ceo, link } = await setup();
    const lapsed = await makeRequest(ceo._id, link._id, 3); // expiresAt a minute ago
    const t = lapsed.startTime.toISOString();
    expect(await slotsOf(link.slug)).toContain(t);
    const next = await book(link.slug, { name: "Next", email: "next@client.com", startTime: t });
    expect(next.status).toBe(201);
  });

  it("still holds the slot while it is alive", async () => {
    const { ceo, link } = await setup();
    const alive = await makeRequest(ceo._id, link._id, 3, { expiresAt: new Date(Date.now() + 5 * HOUR) });
    expect(await slotsOf(link.slug)).not.toContain(alive.startTime.toISOString());
  });

  it("is closed by the sweep: client told once, host notified, slot free", async () => {
    const { ceo, link } = await setup();
    const lapsed = await makeRequest(ceo._id, link._id, 3, { name: "Late Lena", email: "lena@client.com" });

    expect(await sweepBookingRequests()).toEqual({ expired: 1, reminded: 0 });

    const row = (await BookingRequestModel.findById(lapsed._id))!;
    expect(row.status).toBe("expired");
    expect(row.decidedAt).toBeDefined();

    const mail = mailsTo("lena@client.com");
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toMatch(/expired/i);
    expect(mail[0].html).toMatch(/Nothing has been booked/);
    expect(mail[0].html).toMatch(new RegExp(`/book/${link.slug}`)); // a way to ask again

    const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booking_request" });
    expect(note!.message).toMatch(/Late Lena/);
    expect(note!.message).toMatch(/expired/);

    // Running it again does nothing and sends nothing more.
    sent.length = 0;
    expect(await sweepBookingRequests()).toEqual({ expired: 0, reminded: 0 });
    expect(sent).toHaveLength(0);
  });

  it("is only ever closed once, however many sweeps overlap", async () => {
    const { ceo, link } = await setup();
    await makeRequest(ceo._id, link._id, 3, { email: "once@client.com" });
    const runs = await Promise.all([sweepBookingRequests(), sweepBookingRequests(), sweepBookingRequests()]);
    expect(runs.reduce((n, r) => n + r.expired, 0)).toBe(1);
    expect(mailsTo("once@client.com")).toHaveLength(1);
  });

  it("can't be approved once lapsed, whether or not the sweep has run yet", async () => {
    const { ceo, token, link } = await setup();
    const lapsed = await makeRequest(ceo._id, link._id, 3);
    const before = await approve(token, String(lapsed._id));
    expect(before.status).toBe(409);
    expect(before.body.code).toBe("EXPIRED");
    expect(await MeetingModel.countDocuments({})).toBe(0);

    await sweepBookingRequests();
    const after = await approve(token, String(lapsed._id));
    expect(after.status).toBe(409);
    expect(after.body.code).toBe("ALREADY_DECIDED");
    expect(after.body.message).toMatch(/expired/);
  });

  it("is caught up when the host opens their queue, even if the scheduler never runs", async () => {
    const { ceo, token, link } = await setup();
    await makeRequest(ceo._id, link._id, 3, { email: "q@client.com" });
    await makeRequest(ceo._id, link._id, 5, { email: "live@client.com", expiresAt: new Date(Date.now() + 5 * HOUR) });
    const res = await listRequests(token);
    expect(res.body.data.map((r: any) => r.email)).toEqual(["live@client.com"]); // the lapsed one is gone
    expect(mailsTo("q@client.com")).toHaveLength(1);
    expect(mailsTo("live@client.com")).toHaveLength(0);
  });

  it("only sweeps the host's own requests when opening their queue", async () => {
    const { ceo, link } = await setup();
    await makeRequest(ceo._id, link._id, 3, { email: "mine@client.com" });
    const { token: stranger } = await createUserWithToken("ceo");
    await listRequests(stranger);
    expect((await BookingRequestModel.findOne({ email: "mine@client.com" }))!.status).toBe("pending");
  });
});

// ═════════════════════════════════════════════════════════════════
describe("reminding the host", () => {
  it("nudges once, when a still-live request passes its halfway point", async () => {
    const { ceo, link } = await setup();
    const r = await makeRequest(ceo._id, link._id, 4, {
      name: "Waiting Wanda",
      expiresAt: new Date(Date.now() + 6 * HOUR),
      reminderAt: new Date(Date.now() - 60_000),
    });

    expect(await sweepBookingRequests()).toEqual({ expired: 0, reminded: 1 });
    expect((await BookingRequestModel.findById(r._id))!.reminderSent).toBe(true);
    expect((await BookingRequestModel.findById(r._id))!.status).toBe("pending"); // still waiting

    const hostMail = mailsTo(ceo.email as string).find((m) => /still waiting/i.test(m.subject));
    expect(hostMail).toBeDefined();
    expect(hostMail!.html).toMatch(/Waiting Wanda/);
    expect(hostMail!.html).toMatch(/Lapses at/);
    expect(await Notification.countDocuments({ userId: ceo._id, message: /still waiting/ })).toBe(1);
    // The client is not pestered.
    expect(mailsTo("direct@client.com")).toHaveLength(0);

    // Not again.
    sent.length = 0;
    expect(await sweepBookingRequests()).toEqual({ expired: 0, reminded: 0 });
    expect(sent).toHaveLength(0);
  });

  it("doesn't nudge before the halfway point, or about a request that already lapsed", async () => {
    const { ceo, link } = await setup();
    await makeRequest(ceo._id, link._id, 4, {
      email: "early@client.com",
      expiresAt: new Date(Date.now() + 6 * HOUR),
      reminderAt: new Date(Date.now() + 3 * HOUR),
    });
    await makeRequest(ceo._id, link._id, 6, {
      email: "gone@client.com",
      expiresAt: new Date(Date.now() - 60_000),
      reminderAt: new Date(Date.now() - 3 * HOUR),
    });
    expect(await sweepBookingRequests()).toEqual({ expired: 1, reminded: 0 });
    expect(mailsTo(ceo.email as string)).toHaveLength(0);
  });

  it("doesn't nudge about a request that has been answered", async () => {
    const { ceo, token, link } = await setup();
    const r = await makeRequest(ceo._id, link._id, 4, {
      expiresAt: new Date(Date.now() + 6 * HOUR),
      reminderAt: new Date(Date.now() - 60_000),
    });
    await decline(token, String(r._id));
    expect(await sweepBookingRequests()).toEqual({ expired: 0, reminded: 0 });
  });
});

// ═════════════════════════════════════════════════════════════════
describe("the scheduled job endpoint", () => {
  it("rejects callers without the cron secret", async () => {
    expect((await request(app).post("/api/cron/booking-requests")).status).toBe(401);
    expect(
      (await request(app).post("/api/cron/booking-requests").set("Authorization", "Bearer nope")).status,
    ).toBe(401);
  });

  it("runs the sweep and reports what it did", async () => {
    const { ceo, link } = await setup();
    await makeRequest(ceo._id, link._id, 3, { email: "cron@client.com" });
    await makeRequest(ceo._id, link._id, 5, {
      email: "remind@client.com",
      expiresAt: new Date(Date.now() + 6 * HOUR),
      reminderAt: new Date(Date.now() - 60_000),
    });
    const res = await request(app)
      .post("/api/cron/booking-requests")
      .set("Authorization", "Bearer test-cron-secret");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Booking requests: sent 1 reminder(s), expired 1 request(s)");
    expect(mailsTo("cron@client.com")).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("declining with other times to offer", () => {
  /** Makes a pending request through the public API. */
  const pendingRequest = async (link: { slug: string }, h = 0) => {
    const r = await book(link.slug, { ...jane(), startTime: slotAt(h).toISOString() });
    expect(r.body.data.status).toBe("pending");
    return r.body.data.requestId as string;
  };
  const tokenFromEmail = (html: string) => decodeURIComponent(/[?&;]o=([^"&\s]+)/.exec(html)![1]);
  const timesFromEmail = (html: string) =>
    [...html.matchAll(/\?t=([^&"]+)/g)].map((m) => decodeURIComponent(m[1]));

  it("emails the client the offered times, each a one-click link, and frees the original slot", async () => {
    const { token, link } = await setup();
    const id = await pendingRequest(link, 0);
    const alt1 = slotAt(5);
    const alt2 = slotAt(7);
    sent.length = 0;

    const res = await decline(token, id, {
      reason: "Booked out that afternoon",
      alternatives: [alt2.toISOString(), alt1.toISOString()],
    });
    expect(res.status).toBe(200);

    const row = (await BookingRequestModel.findById(id))!;
    expect(row.status).toBe("declined");
    expect(row.alternatives.map((d) => d.getTime())).toEqual([alt1.getTime(), alt2.getTime()]); // sorted
    expect(row.offerExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR);

    const mail = mailsTo("jane@client.com");
    expect(mail).toHaveLength(1);
    expect(mail[0].html).toMatch(/suggested these times instead/);
    expect(mail[0].html).toMatch(/Booked out that afternoon/);
    expect(mail[0].html).toMatch(/East Africa Time/);
    expect(mail[0].html).toMatch(/not reserved/);
    expect(timesFromEmail(mail[0].html)).toEqual([alt1.toISOString(), alt2.toISOString()]);
    expect(mail[0].html).toMatch(new RegExp(`/book/${link.slug}\\?t=`));
    // The link carries a genuine signed token for this request.
    expect(verifyOfferToken(tokenFromEmail(mail[0].html))).toBe(id);

    expect(await slotsOf(link.slug)).toContain(slotAt(0).toISOString()); // original slot freed
  });

  it("works without alternatives exactly as before", async () => {
    const { token, link } = await setup();
    const id = await pendingRequest(link);
    sent.length = 0;
    expect((await decline(token, id, { reason: "Not available" })).status).toBe(200);
    const mail = mailsTo("jane@client.com")[0];
    expect(mail.html).toMatch(/Pick another time/);
    expect(mail.html).not.toMatch(/suggested these times/);
    expect((await BookingRequestModel.findById(id))!.alternatives).toHaveLength(0);
  });

  it("refuses bad offers and leaves the request waiting (nothing sent)", async () => {
    const { ceo, token, link } = await setup();
    const id = await pendingRequest(link);
    sent.length = 0;
    const stillPending = async () => (await BookingRequestModel.findById(id))!.status === "pending";

    // Too many
    const four = [1, 2, 3, 4].map((n) => slotAt(10 + n).toISOString());
    const tooMany = await decline(token, id, { alternatives: four });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe("TOO_MANY_ALTERNATIVES");

    // In the past
    expect((await decline(token, id, { alternatives: [new Date(Date.now() - HOUR).toISOString()] })).status).toBe(400);
    // Not dates / not a list
    expect((await decline(token, id, { alternatives: ["next tuesday"] })).status).toBe(400);
    expect((await decline(token, id, { alternatives: "soon" })).status).toBe(400);

    // A time that's taken by a meeting
    const busyAt = slotAt(12);
    await MeetingModel.create({
      title: "Board", organizer: ceo._id, startTime: busyAt,
      endTime: new Date(busyAt.getTime() + HOUR), status: "scheduled",
    });
    const taken = await decline(token, id, { alternatives: [slotAt(11).toISOString(), busyAt.toISOString()] });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("SLOT_TAKEN");

    // A time held by someone else's waiting request
    const otherReq = await pendingRequest(link, 20);
    expect(otherReq).toBeDefined();
    sent.length = 0; // that request sent its own emails; what matters is the refused offers send none
    const held = await decline(token, id, { alternatives: [slotAt(20).toISOString()] });
    expect(held.status).toBe(409);

    // A time outside the booking window
    expect((await decline(token, id, { alternatives: [new Date(Date.now() + 30 * 24 * HOUR).toISOString()] })).status).toBe(409);

    expect(await stillPending()).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("can't offer times when the link is paused or deleted, but can still decline plainly", async () => {
    const { token, link } = await setup();
    const id = await pendingRequest(link);
    await request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send({ isActive: false });
    const r = await decline(token, id, { alternatives: [slotAt(9).toISOString()] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_LINK");
    expect((await BookingRequestModel.findById(id))!.status).toBe("pending");
    expect((await decline(token, id, { reason: "Sorry" })).status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("the client takes an offered time", () => {
  /** A request declined with two offered times; returns what the client's email contains. */
  const offered = async (linkOverrides: Record<string, unknown> = {}) => {
    const ctx = await setup(linkOverrides);
    const made = await book(ctx.link.slug, { ...jane(), startTime: slotAt(0).toISOString() });
    const id = made.body.data.requestId as string;
    const alts = [slotAt(5), slotAt(7)];
    sent.length = 0;
    const d = await request(app)
      .post(`/api/booking-links/requests/${id}/decline`)
      .set(auth(ctx.token))
      .send({ alternatives: alts.map((a) => a.toISOString()) });
    expect(d.status).toBe(200);
    const token = createOfferToken(id);
    sent.length = 0;
    return { ...ctx, id, alts, token };
  };
  const offerInfo = (slug: string, token: string) =>
    request(app).get(`/api/public/booking/${slug}/offer`).query({ token }).set("X-Forwarded-For", freshIp());

  it("tells the booking page whether the offer is good, with details to pre-fill", async () => {
    const { link, alts, token } = await offered();
    const r = await offerInfo(link.slug, token);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ valid: true, name: "Jane Client", email: "jane@client.com", topic: "Annual audit" });
    expect(r.body.data.times).toEqual(alts.map((a) => a.toISOString()));
  });

  it("shows nothing for a made-up, tampered, expired or wrong-link token", async () => {
    const { ceo, link, id, token } = await offered();
    const nothing = { valid: false };
    expect((await offerInfo(link.slug, "garbage")).body.data).toEqual(nothing);
    expect((await offerInfo(link.slug, `${id}.AAAA`)).body.data).toEqual(nothing);
    expect((await offerInfo(link.slug, "")).body.data).toEqual(nothing);

    // A different booking link can't use it
    const other = await request(app)
      .post("/api/booking-links").set(auth((await createUserWithToken("ceo")).token))
      .send({ title: "Other", ...OPEN_ALL_DAY });
    expect((await offerInfo(other.body.data.slug, token)).body.data).toEqual(nothing);

    // Past its deadline
    await BookingRequestModel.updateOne({ _id: id }, { offerExpiresAt: new Date(Date.now() - 1000) });
    expect((await offerInfo(link.slug, token)).body.data).toEqual(nothing);
    expect(ceo).toBeDefined();
  });

  it("confirms an offered time immediately — even on a link that needs approval", async () => {
    mockZoho.session = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };
    mockZoho.createZohoEvent.mockResolvedValue({ uid: "ev1", etag: "e1", meetingKey: "MK-OFFER" });
    const { ceo, link, id, alts, token } = await offered();

    const r = await book(link.slug, { ...jane(), startTime: alts[0].toISOString(), offer: token });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("confirmed"); // no second approval
    expect(r.body.data.meetingLink).toMatch(/MK-OFFER/);

    const meetings = await MeetingModel.find({});
    expect(meetings).toHaveLength(1);
    expect(meetings[0].startTime.getTime()).toBe(alts[0].getTime());
    expect(meetings[0].externalAttendees.map((e) => e.email)).toEqual(["jane@client.com"]);
    expect(String(meetings[0].bookingLinkId)).toBe(link._id);

    const row = (await BookingRequestModel.findById(id))!;
    expect(row.offerAcceptedAt).toBeDefined();
    expect(String(row.meetingId)).toBe(String(meetings[0]._id));
    expect(await BookingRequestModel.countDocuments({ status: "pending" })).toBe(0); // no new request

    expect(mailsTo("jane@client.com").some((m) => /You're invited/.test(m.subject))).toBe(true);
    expect(await Notification.countDocuments({ userId: ceo._id, type: "meeting_booked" })).toBe(1);
    const acts = await MeetingActivityModel.find({ meetingId: meetings[0]._id });
    expect(acts[0].message).toMatch(/took the time/);
  });

  it("is single use: a second time from the same offer goes through approval like anyone else", async () => {
    const { link, alts, token } = await offered();
    const first = await book(link.slug, { ...jane(), startTime: alts[0].toISOString(), offer: token });
    expect(first.body.data.status).toBe("confirmed");
    const second = await book(link.slug, { ...jane(), startTime: alts[1].toISOString(), offer: token });
    expect(second.status).toBe(201);
    expect(second.body.data.status).toBe("pending"); // the offer was already used
    expect(await MeetingModel.countDocuments({})).toBe(1);
  });

  it("ignores the offer — and asks for approval — if the email, time or token doesn't match", async () => {
    const { link, alts, token, id } = await offered();
    // (Each ignored attempt becomes an ordinary waiting request that would hold
    // its slot, so clear them between attempts to keep the offered times free.)
    const clearWaiting = () => BookingRequestModel.deleteMany({ status: "pending" });
    // Different email
    const otherEmail = await book(link.slug, { name: "Mallory", email: "mallory@evil.test", startTime: alts[0].toISOString(), offer: token });
    expect(otherEmail.body.data.status).toBe("pending");
    await clearWaiting();
    // A time that wasn't offered
    const wrongTime = await book(link.slug, { ...jane(), startTime: slotAt(30).toISOString(), offer: token });
    expect(wrongTime.body.data.status).toBe("pending");
    await clearWaiting();
    // A tampered token
    const forged = await book(link.slug, { ...jane(), startTime: alts[1].toISOString(), offer: `${id}.forged` });
    expect(forged.body.data.status).toBe("pending");
    await clearWaiting();
    // None of that used up the real offer
    expect((await BookingRequestModel.findById(id))!.offerAcceptedAt).toBeUndefined();
    expect(await MeetingModel.countDocuments({})).toBe(0);
    const genuine = await book(link.slug, { ...jane(), startTime: alts[0].toISOString(), offer: token });
    expect(genuine.body.data.status).toBe("confirmed");
  });

  it("if an offered time has been taken meanwhile, says so — and the other offered time still works", async () => {
    const { ceo, link, alts, token } = await offered();
    await MeetingModel.create({
      title: "Board", organizer: ceo._id, startTime: alts[0],
      endTime: new Date(alts[0].getTime() + HOUR), status: "scheduled",
    });
    const gone = await book(link.slug, { ...jane(), startTime: alts[0].toISOString(), offer: token });
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe("SLOT_TAKEN");

    const other = await book(link.slug, { ...jane(), startTime: alts[1].toISOString(), offer: token });
    expect(other.status).toBe(201);
    expect(other.body.data.status).toBe("confirmed");
  });

  it("doesn't reserve the offered times: if someone else's request already holds one, the client is told it's taken", async () => {
    const { link, alts, token } = await offered();
    const rival = await book(link.slug, { name: "Rival", email: "rival@client.com", startTime: alts[0].toISOString() });
    expect(rival.body.data.status).toBe("pending"); // holds that time while waiting
    const r = await book(link.slug, { ...jane(), startTime: alts[0].toISOString(), offer: token });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("SLOT_TAKEN");
    // The other offered time is unaffected, and the offer wasn't used up.
    const ok = await book(link.slug, { ...jane(), startTime: alts[1].toISOString(), offer: token });
    expect(ok.body.data.status).toBe("confirmed");
  });

  it("still works when the notice period would now rule the time out", async () => {
    // Link needs 24h notice, but the client only answers 2 hours before the offered time.
    const { ceo, link } = await setup({ minNoticeHours: 24 });
    const soon = new Date(Math.ceil((Date.now() + 2 * HOUR) / HOUR) * HOUR);
    const declined = await BookingRequestModel.create({
      linkId: link._id, ownerId: ceo._id, linkTitle: "Intro call",
      startTime: slotAt(0), endTime: slotAt(1), name: "Jane Client", email: "jane@client.com",
      status: "declined", alternatives: [soon], offerExpiresAt: new Date(Date.now() + 24 * HOUR),
    });
    // An ordinary booking that soon is refused…
    expect((await book(link.slug, { name: "Bob", email: "bob@client.com", startTime: soon.toISOString() })).status).toBe(409);
    // …but the host's offer is honoured.
    const r = await book(link.slug, { ...jane(), startTime: soon.toISOString(), offer: createOfferToken(String(declined._id)) });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("confirmed");
  });

  it("can't be double-spent by clicking several times at once", async () => {
    const { link, alts, token } = await offered();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => book(link.slug, { ...jane(), startTime: alts[0].toISOString(), offer: token })),
    );
    // Whatever each click was told, only ONE meeting exists.
    expect(await MeetingModel.countDocuments({})).toBe(1);
    expect(results.filter((r) => r.body.data?.status === "confirmed")).toHaveLength(1);
    expect(mailsTo("jane@client.com").filter((m) => /You're invited/.test(m.subject))).toHaveLength(1);
  });
});