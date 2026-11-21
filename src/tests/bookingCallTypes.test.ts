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
    fetchZohoMeetingPassword: async () => ({ status: "ok" as const, password: "Pw123" }),
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
import { createOfferToken } from "../utils/bookingOfferToken";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});

beforeEach(() => {
  sent.length = 0;
  mockZoho.session = { accessToken: "t", calendarUid: "c", email: "ada@zoho.test" };
  mockZoho.createZohoEvent.mockReset();
  mockZoho.createZohoEvent.mockResolvedValue({ uid: "ev1", etag: "e1", meetingKey: "1049772213" });
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
const freshIp = () => `10.5.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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
const slotAt = (h = 0): Date => new Date(Math.ceil((Date.now() + 24 * HOUR) / HOUR) * HOUR + h * HOUR);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const setup = async (overrides: Record<string, unknown> = {}) => {
  const { user: ceo, token } = await createUserWithToken("ceo", { name: "Ada CEO" });
  const res = await request(app)
    .post("/api/booking-links")
    .set(auth(token))
    .send({ title: "Intro call", ...OPEN_ALL_DAY, ...overrides });
  expect(res.status).toBe(201);
  return { ceo, token, link: res.body.data as { _id: string; slug: string; callTypes: string[] } };
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
  sent.find((m) => ([] as string[]).concat(m.to).includes(addr) && /You're invited/.test(m.subject ?? ""));
const mailsTo = (addr: string) => sent.filter((m) => ([] as string[]).concat(m.to).includes(addr));

const VOICE_ROW = /Voice call \(audio only, no camera needed\)/;

// ═════════════════════════════════════════════════════════════════
describe("which call types a link offers", () => {
  it("offers video only by default, and the host can allow voice, or both", async () => {
    const { token, link } = await setup();
    expect(link.callTypes).toEqual(["video"]);
    const put = (b: object) => request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send(b);

    expect((await put({ callTypes: ["video", "voice"] })).body.data.callTypes).toEqual(["video", "voice"]);
    expect((await put({ callTypes: ["voice"] })).body.data.callTypes).toEqual(["voice"]);
    // Order and duplicates are tidied: video first, each once.
    expect((await put({ callTypes: ["voice", "video", "voice"] })).body.data.callTypes).toEqual(["video", "voice"]);
  });

  it("rejects an empty list, unknown types and wrong shapes", async () => {
    const { token, link } = await setup();
    const put = (b: object) => request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send(b);
    expect((await put({ callTypes: [] })).status).toBe(400);
    expect((await put({ callTypes: ["phone"] })).status).toBe(400);
    expect((await put({ callTypes: ["video", "carrier-pigeon"] })).status).toBe(400);
    expect((await put({ callTypes: "voice" })).status).toBe(400);
    expect((await BookingLinkModel.findById(link._id))!.callTypes).toEqual(["video"]); // unchanged
  });

  it("validates the optional separate voice-call link", async () => {
    const { token, link } = await setup();
    const put = (b: object) => request(app).put(`/api/booking-links/${link._id}`).set(auth(token)).send(b);
    expect((await put({ voiceMeetingLink: "javascript:alert(1)" })).status).toBe(400);
    expect((await put({ voiceMeetingLink: "not a url" })).status).toBe(400);
    expect((await put({ voiceMeetingLink: "https://audio.example.com/room" })).body.data.voiceMeetingLink).toBe(
      "https://audio.example.com/room",
    );
    expect((await put({ voiceMeetingLink: "" })).body.data.voiceMeetingLink).toBe("");
  });

  it("tells the booking page what is on offer", async () => {
    const { link } = await setup({ callTypes: ["video", "voice"] });
    const r = await request(app).get(`/api/public/booking/${link.slug}`).set("X-Forwarded-For", freshIp());
    expect(r.body.data.callTypes).toEqual(["video", "voice"]);
    expect(r.body.data.isOnline).toBe(true);
  });

  it("works for links created before call types existed (they stay video-only)", async () => {
    const { link } = await setup();
    await BookingLinkModel.collection.updateOne(
      { slug: link.slug },
      { $unset: { callTypes: "" } },
    );
    const info = await request(app).get(`/api/public/booking/${link.slug}`).set("X-Forwarded-For", freshIp());
    expect(info.body.data.callTypes).toEqual(["video"]);
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.data.callType).toBe("video");
  });
});

// ═════════════════════════════════════════════════════════════════
describe("the client picks video or voice", () => {
  it("books a voice call: labelled everywhere, still an online meeting with a link and password", async () => {
    const { ceo, link } = await setup({ callTypes: ["video", "voice"] });
    const t = slotAt();
    const r = await book(link.slug, { ...jane(), startTime: t.toISOString(), callType: "voice" });

    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("confirmed");
    expect(r.body.data.callType).toBe("voice");
    expect(r.body.data.title).toBe("Intro call – Jane Client (voice call)");
    expect(r.body.data.location).toBe("Online (voice call)");
    expect(r.body.data.meetingLink).toMatch(/join\?key=1049772213/);
    expect(r.body.data.meetingPassword).toBe("Pw123");

    const m = (await MeetingModel.find({}))[0];
    expect(m.callType).toBe("voice");
    expect(m.title).toMatch(/\(voice call\)$/);
    expect(m.conferenceProvider).toBe("zoho_meeting");

    // The CEO's Zoho Calendar entry says so too.
    expect(mockZoho.createZohoEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Intro call – Jane Client (voice call)", withZohoMeeting: true }),
    );

    // The client's invitation says it's audio only, and still carries link + password.
    const mail = inviteTo("jane@client.com")!;
    expect(mail.html).toMatch(VOICE_ROW);
    expect(mail.html).toMatch(/join\?key=1049772213/);
    expect(mail.html).toMatch(/Pw123/);

    const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booked" });
    expect(note!.message).toMatch(/\(voice call\)/);
    const acts = await MeetingActivityModel.find({ meetingId: m._id });
    expect(acts[0].message).toMatch(/\(voice call\)/);
  });

  it("books a video call exactly as before — no voice wording anywhere", async () => {
    const { link } = await setup({ callTypes: ["video", "voice"] });
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString(), callType: "video" });
    expect(r.body.data.callType).toBe("video");
    expect(r.body.data.title).toBe("Intro call – Jane Client");
    expect(r.body.data.location).toBe("Online");
    const m = (await MeetingModel.find({}))[0];
    expect(m.callType).toBe("video");
    expect(inviteTo("jane@client.com")!.html).not.toMatch(/Call type/);
  });

  it("defaults to the link's first allowed type when the client sends none", async () => {
    const both = await setup({ callTypes: ["video", "voice"] });
    expect((await book(both.link.slug, { ...jane(), startTime: slotAt().toISOString() })).body.data.callType).toBe("video");

    const voiceOnly = await setup({ callTypes: ["voice"] });
    const r = await book(voiceOnly.link.slug, { ...jane(), startTime: slotAt(3).toISOString() });
    expect(r.body.data.callType).toBe("voice");
    expect(inviteTo("jane@client.com")).toBeDefined();
  });

  it("refuses a type the host didn't allow, or a made-up one — and books nothing", async () => {
    const videoOnly = await setup({ callTypes: ["video"] });
    const voiceOnly = await setup({ callTypes: ["voice"] });
    const t = slotAt().toISOString();

    const a = await book(videoOnly.link.slug, { ...jane(), startTime: t, callType: "voice" });
    expect(a.status).toBe(400);
    expect(a.body.message).toMatch(/Voice calls aren't available/);

    const b = await book(voiceOnly.link.slug, { ...jane(), startTime: t, callType: "video" });
    expect(b.status).toBe(400);
    expect(b.body.message).toMatch(/Video calls aren't available/);

    const c = await book(videoOnly.link.slug, { ...jane(), startTime: t, callType: "phone" });
    expect(c.status).toBe(400);
    expect(c.body.message).toMatch(/choose video or voice/i);

    expect(await MeetingModel.countDocuments({})).toBe(0);
    expect(await BookingRequestModel.countDocuments({})).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════
describe("fixed meeting links per call type", () => {
  it("uses the voice link for voice calls and the video link for video calls", async () => {
    const { link } = await setup({
      callTypes: ["video", "voice"],
      meetingLink: "https://video.example.com/ada",
      voiceMeetingLink: "https://audio.example.com/ada",
    });
    const v = await book(link.slug, { ...jane(), startTime: slotAt(0).toISOString(), callType: "voice" });
    const w = await book(link.slug, { name: "Bob", email: "bob@client.com", startTime: slotAt(2).toISOString(), callType: "video" });
    expect(v.body.data.meetingLink).toBe("https://audio.example.com/ada");
    expect(w.body.data.meetingLink).toBe("https://video.example.com/ada");
    const meetings = await MeetingModel.find({}).sort({ startTime: 1 });
    expect(meetings.map((m) => m.conferenceProvider)).toEqual(["custom", "custom"]);
    // Fixed links: no Zoho Meeting is created for either.
    for (const call of mockZoho.createZohoEvent.mock.calls) {
      expect(call[0].withZohoMeeting).toBeFalsy();
    }
  });

  it("lets voice calls share the single fixed link when there is no separate voice link", async () => {
    const { link } = await setup({ callTypes: ["voice"], meetingLink: "https://video.example.com/ada" });
    const r = await book(link.slug, { ...jane(), startTime: slotAt().toISOString() });
    expect(r.body.data.callType).toBe("voice");
    expect(r.body.data.meetingLink).toBe("https://video.example.com/ada");
  });

  it("gives a voice-only fixed link to voice calls while video calls still get a fresh Zoho Meeting", async () => {
    const { link } = await setup({
      callTypes: ["video", "voice"],
      voiceMeetingLink: "https://audio.example.com/ada",
    });
    const voice = await book(link.slug, { ...jane(), startTime: slotAt(0).toISOString(), callType: "voice" });
    const video = await book(link.slug, { name: "Bob", email: "bob@client.com", startTime: slotAt(2).toISOString(), callType: "video" });
    expect(voice.body.data.meetingLink).toBe("https://audio.example.com/ada");
    expect(video.body.data.meetingLink).toMatch(/join\?key=1049772213/);
    expect(video.body.data.meetingPassword).toBe("Pw123");
    expect(voice.body.data.meetingPassword).toBeUndefined(); // a fixed link has no Zoho password to fetch
  });
});

// ═════════════════════════════════════════════════════════════════
describe("approval, offered times and later emails keep the type", () => {
  it("carries a voice request through the approval queue to a confirmed voice meeting", async () => {
    const { ceo, token, link } = await setup({ callTypes: ["video", "voice"], requireApproval: true });
    const made = await book(link.slug, { ...jane(), startTime: slotAt().toISOString(), callType: "voice" });
    expect(made.body.data.status).toBe("pending");
    expect(made.body.data.callType).toBe("voice");
    expect((await BookingRequestModel.findById(made.body.data.requestId))!.callType).toBe("voice");

    // The client's "request received" email and the host's email both say so.
    expect(mailsTo("jane@client.com")[0].html).toMatch(VOICE_ROW);
    expect(mailsTo(ceo.email as string).find((m) => /Booking request/.test(m.subject))!.html).toMatch(VOICE_ROW);
    const note = await Notification.findOne({ userId: ceo._id, type: "meeting_booking_request" });
    expect(note!.message).toMatch(/\(voice call\)/);

    // The host's queue shows the type.
    const queue = await request(app).get("/api/booking-links/requests").set(auth(token));
    expect(queue.body.data[0].callType).toBe("voice");

    sent.length = 0;
    const ok = await request(app)
      .post(`/api/booking-links/requests/${made.body.data.requestId}/approve`)
      .set(auth(token))
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.callType).toBe("voice");
    const m = (await MeetingModel.find({}))[0];
    expect(m.callType).toBe("voice");
    expect(m.title).toBe("Intro call – Jane Client (voice call)");
    expect(inviteTo("jane@client.com")!.html).toMatch(VOICE_ROW);
  });

  it("an offered time keeps the kind of call originally requested, whatever the page sends", async () => {
    const { token, link } = await setup({ callTypes: ["video", "voice"], requireApproval: true });
    const made = await book(link.slug, { ...jane(), startTime: slotAt(0).toISOString(), callType: "voice" });
    const alt = slotAt(6);
    await request(app)
      .post(`/api/booking-links/requests/${made.body.data.requestId}/decline`)
      .set(auth(token))
      .send({ alternatives: [alt.toISOString()] });

    const offerToken = createOfferToken(made.body.data.requestId);
    const info = await request(app)
      .get(`/api/public/booking/${link.slug}/offer`)
      .query({ token: offerToken })
      .set("X-Forwarded-For", freshIp());
    expect(info.body.data.callType).toBe("voice");

    sent.length = 0;
    const r = await book(link.slug, { ...jane(), startTime: alt.toISOString(), callType: "video", offer: offerToken });
    expect(r.body.data.status).toBe("confirmed");
    expect(r.body.data.callType).toBe("voice"); // the offer wins over the form
    expect((await MeetingModel.find({}))[0].title).toMatch(/\(voice call\)$/);
    expect(inviteTo("jane@client.com")!.html).toMatch(VOICE_ROW);
  });

  it("keeps saying 'voice call' when the host later changes the meeting", async () => {
    const { token, link } = await setup({ callTypes: ["video", "voice"] });
    await book(link.slug, { ...jane(), startTime: slotAt().toISOString(), callType: "voice" });
    const m = (await MeetingModel.find({}))[0];
    sent.length = 0;
    const res = await request(app)
      .put(`/api/meetings/${m._id}`)
      .set(auth(token))
      .send({ location: "Online (voice call) - moved" });
    expect(res.status).toBe(200);
    const update = mailsTo("jane@client.com").find((x) => /updated/i.test(x.subject ?? ""));
    expect(update).toBeDefined();
    expect(update!.html).toMatch(VOICE_ROW);
  });
});