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

// Zoho Calendar: no network. `fetchPassword` is what Zoho "returns" for the
// meeting's password in each test.
const mockZoho: {
  session: any;
  createZohoEvent: jest.Mock;
  updateZohoEvent: jest.Mock;
  fetchPassword: jest.Mock;
} = {
  session: null,
  createZohoEvent: jest.fn(),
  updateZohoEvent: jest.fn(),
  fetchPassword: jest.fn(),
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
    fetchZohoMeetingPassword: (...a: any[]) => mockZoho.fetchPassword(...a),
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

const SESSION = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };

beforeEach(() => {
  sent.length = 0;
  mockZoho.session = SESSION;
  mockZoho.createZohoEvent.mockReset();
  mockZoho.createZohoEvent.mockResolvedValue({ uid: "ev1", etag: "e1", meetingKey: "1049772213" });
  mockZoho.updateZohoEvent.mockReset();
  mockZoho.updateZohoEvent.mockImplementation(async (i: any) => ({ status: "updated", uid: i.uid, etag: "e2" }));
  mockZoho.fetchPassword.mockReset();
  mockZoho.fetchPassword.mockResolvedValue({ status: "ok", password: "Abc123" });
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
const freshIp = () => `10.4.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const setup = async (overrides: Record<string, unknown> = {}) => {
  const { user: ceo, token } = await createUserWithToken("ceo", { name: "Ada CEO" });
  const res = await request(app)
    .post("/api/booking-links")
    .set(auth(token))
    .send({ title: "Intro call", ...OPEN_ALL_DAY, ...overrides });
  expect(res.status).toBe(201);
  return { ceo, token, link: res.body.data as { _id: string; slug: string } };
};

const book = (slug: string, body: Record<string, unknown>) =>
  request(app).post(`/api/public/booking/${slug}/book`).set("X-Forwarded-For", freshIp()).send(body);

const jane = (over: Record<string, unknown> = {}) => ({
  name: "Jane Client",
  email: "jane@client.com",
  topic: "Annual audit",
  ...over,
});

const inviteTo = (addr: string) =>
  sent.find(
    (m) => ([] as string[]).concat(m.to).includes(addr) && /You're invited/.test(m.subject ?? ""),
  );

// ═════════════════════════════════════════════════════════════════
describe("a Zoho Meeting password reaches the client", () => {
  it("is fetched for the new meeting, stored, returned to the booking page and put in the invitation", async () => {
    const { link } = await setup();
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });

    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("confirmed");
    expect(r.body.data.meetingLink).toMatch(/join\?key=1049772213/);
    expect(r.body.data.meetingPassword).toBe("Abc123");

    // Asked Zoho for the right meeting, as the host.
    expect(mockZoho.fetchPassword).toHaveBeenCalledTimes(1);
    expect(mockZoho.fetchPassword).toHaveBeenCalledWith(SESSION, "1049772213");

    // Saved with the meeting, so it's there in the Hub too.
    const m = (await MeetingModel.find({}))[0];
    expect(m.meetingPassword).toBe("Abc123");
    expect(m.conferenceProvider).toBe("zoho_meeting");

    // And in the email the client actually opens the link from.
    const mail = inviteTo("jane@client.com")!;
    expect(mail.html).toMatch(/join\?key=1049772213/);
    expect(mail.html).toMatch(/Meeting password/);
    expect(mail.html).toMatch(/Abc123/);
  });

  it("is shown only alongside a meeting link", async () => {
    const { link } = await setup();
    mockZoho.createZohoEvent.mockResolvedValue({ uid: "ev1", etag: "e1" }); // Zoho made no meeting
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.data.meetingLink).toBeUndefined();
    expect(r.body.data.meetingPassword).toBeUndefined();
    expect(mockZoho.fetchPassword).not.toHaveBeenCalled();
    expect(inviteTo("jane@client.com")!.html).not.toMatch(/Meeting password/);
  });

  it("uses a password already present in Zoho's event response without a second lookup", async () => {
    const { link } = await setup();
    mockZoho.createZohoEvent.mockResolvedValue({
      uid: "ev1", etag: "e1", meetingKey: "1049772213", meetingPassword: "Inline9",
    });
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.body.data.meetingPassword).toBe("Inline9");
    expect(mockZoho.fetchPassword).not.toHaveBeenCalled();
    expect(inviteTo("jane@client.com")!.html).toMatch(/Inline9/);
  });

  it("shows no password row when the meeting genuinely has none", async () => {
    const { ceo, link } = await setup();
    mockZoho.fetchPassword.mockResolvedValue({ status: "ok" }); // password turned off in Zoho
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.data.meetingPassword).toBeUndefined();
    expect(inviteTo("jane@client.com")!.html).not.toMatch(/Meeting password/);
    // …and that's not a problem worth bothering the host about.
    const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booked" });
    expect(note!.message).not.toMatch(/password/i);
  });

  it("doesn't look for a password when the link uses a fixed meeting link", async () => {
    const { link } = await setup({ meetingLink: "https://meet.example.com/ada" });
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.body.data.meetingLink).toBe("https://meet.example.com/ada");
    expect(mockZoho.fetchPassword).not.toHaveBeenCalled();
    expect(inviteTo("jane@client.com")!.html).not.toMatch(/Meeting password/);
  });

  it("escapes the password in the email", async () => {
    const { link } = await setup();
    mockZoho.fetchPassword.mockResolvedValue({ status: "ok", password: `<b onclick="x">pw</b>` });
    await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    const html = inviteTo("jane@client.com")!.html;
    expect(html).not.toMatch(/<b onclick/);
    expect(html).toMatch(/&lt;b onclick=/);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("when the password can't be fetched", () => {
  it("still books, and tells the host to reconnect Zoho Calendar", async () => {
    const { ceo, link } = await setup();
    mockZoho.fetchPassword.mockResolvedValue({ status: "unavailable", reason: "needs_reconnect" });
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });

    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("confirmed");
    expect(r.body.data.meetingLink).toMatch(/join\?key=/); // the link still works
    expect(r.body.data.meetingPassword).toBeUndefined();
    expect(await MeetingModel.countDocuments({})).toBe(1);
    expect(inviteTo("jane@client.com")).toBeDefined();
    expect(inviteTo("jane@client.com")!.html).not.toMatch(/Meeting password/);

    const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booked" });
    expect(note!.message).toMatch(/password couldn't be retrieved/);
    expect(note!.message).toMatch(/Reconnect Zoho Calendar/);
    expect(note!.message).toMatch(/turn off the meeting password/i);
  });

  it.each(["masked", "error"] as const)(
    "tells the host to turn the password off or send it themselves (%s)",
    async (reason) => {
      const { ceo, link } = await setup();
      mockZoho.fetchPassword.mockResolvedValue({ status: "unavailable", reason });
      const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
      expect(r.status).toBe(201);
      const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booked" });
      expect(note!.message).toMatch(/password couldn't be retrieved/);
      expect(note!.message).toMatch(/Turn off the meeting password in Zoho Meeting/);
      expect(note!.message).not.toMatch(/Reconnect/);
    },
  );

  it("never fails the booking even if the lookup itself blows up", async () => {
    const { link } = await setup();
    mockZoho.fetchPassword.mockRejectedValue(new Error("boom"));
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("confirmed");
    expect(await MeetingModel.countDocuments({})).toBe(1);
    expect(inviteTo("jane@client.com")).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════
describe("the other ways a meeting gets confirmed", () => {
  it("carries the password through host approval", async () => {
    const { token, link } = await setup({ requireApproval: true });
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(made.body.data.status).toBe("pending");
    expect(mockZoho.fetchPassword).not.toHaveBeenCalled(); // nothing exists in Zoho yet

    const ok = await request(app)
      .post(`/api/booking-links/requests/${made.body.data.requestId}/approve`)
      .set(auth(token))
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.meetingPassword).toBe("Abc123");
    expect(inviteTo("jane@client.com")!.html).toMatch(/Abc123/);
    expect((await MeetingModel.find({}))[0].meetingPassword).toBe("Abc123");
  });

  it("still tells the host about a missing password after they approve (they get no other ping then)", async () => {
    const { ceo, token, link } = await setup({ requireApproval: true });
    mockZoho.fetchPassword.mockResolvedValue({ status: "unavailable", reason: "needs_reconnect" });
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    await Notification.deleteMany({}); // clear the "new request" ping
    await request(app)
      .post(`/api/booking-links/requests/${made.body.data.requestId}/approve`)
      .set(auth(token))
      .send({});
    const notes = await Notification.find({ userId: ceo._id, type: "meeting_booked" });
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/is confirmed/);
    expect(notes[0].message).toMatch(/password couldn't be retrieved/);
  });

  it("carries the password when the client takes a time the host offered", async () => {
    const { token, link } = await setup({ requireApproval: true });
    const made = await book(link.slug, { ...jane(), startTime: slotAt(0).toISOString() });
    const alt = slotAt(6);
    await request(app)
      .post(`/api/booking-links/requests/${made.body.data.requestId}/decline`)
      .set(auth(token))
      .send({ alternatives: [alt.toISOString()] });
    sent.length = 0;
    const { createOfferToken } = await import("../utils/bookingOfferToken");
    const r = await book(link.slug, {
      ...jane(), startTime: alt.toISOString(), offer: createOfferToken(made.body.data.requestId),
    });
    expect(r.body.data.status).toBe("confirmed");
    expect(r.body.data.meetingPassword).toBe("Abc123");
    expect(inviteTo("jane@client.com")!.html).toMatch(/Abc123/);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("later emails about the meeting keep the password", () => {
  it("includes it when the host changes the meeting and the client is re-notified", async () => {
    const { token, link } = await setup();
    await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    const m = (await MeetingModel.find({}))[0];
    sent.length = 0;

    const res = await request(app)
      .put(`/api/meetings/${m._id}`)
      .set(auth(token))
      .send({ location: "Online - rescheduled", title: "Intro call - updated" });
    expect(res.status).toBe(200);

    const update = sent.find(
      (x) => ([] as string[]).concat(x.to).includes("jane@client.com") && /updated/i.test(x.subject ?? ""),
    );
    expect(update).toBeDefined();
    expect(update!.html).toMatch(/join\?key=1049772213/);
    expect(update!.html).toMatch(/Meeting password/);
    expect(update!.html).toMatch(/Abc123/);
  });
});