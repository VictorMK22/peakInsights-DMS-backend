import "./testEnv";

// ── Mocks: no DB, no network ────────────────────────────────────
const zoho = {
  isZohoCalendarConfigured: jest.fn(() => true),
  getZohoCalendarSession: jest.fn(),
  createZohoEvent: jest.fn(),
  updateZohoEvent: jest.fn(),
  deleteZohoEvent: jest.fn(async () => undefined),
};
jest.mock("../services/zohoCalendarService", () => zoho);

const meetingModel = { bulkWrite: jest.fn(), updateOne: jest.fn() };
jest.mock("../models/Meeting", () => ({ MeetingModel: meetingModel }));

const userFindResult = [{ email: "Ann@x.com" }, { email: "bob@x.com" }];
jest.mock("../models/User", () => ({
  User: {
    find: () => ({ select: () => ({ lean: async () => userFindResult }) }),
    findById: () => ({
      select: () => ({ lean: async () => ({ email: "org@x.com" }) }),
    }),
  },
}));

import {
  pushNewMeetingsToZoho,
  syncUpdatedMeetingToZoho,
  removeMeetingsFromZoho,
  buildMeetingDescription,
  mapLimit,
} from "../services/meetingZohoSyncService";

const SESSION = { accessToken: "tok", calendarUid: "cal", email: "org@x.com" };

const mk = (over: Record<string, unknown> = {}): any => ({
  _id: `m${Math.random().toString(36).slice(2, 7)}`,
  title: "Sync",
  description: "Desc",
  agenda: "A1",
  location: "Room 1",
  meetingLink: "https://meeting.zoho.com/join?key=123",
  startTime: new Date("2026-11-02T09:00:00Z"),
  endTime: new Date("2026-11-02T10:00:00Z"),
  organizer: "org1",
  attendees: [{ userId: "u1" }, { userId: "u2" }],
  externalAttendees: [{ email: "Ext@y.com" }, { email: "org@x.com" }],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  zoho.isZohoCalendarConfigured.mockReturnValue(true);
  zoho.getZohoCalendarSession.mockResolvedValue(SESSION);
  let n = 0;
  zoho.createZohoEvent.mockImplementation(async () => ({
    uid: `uid${++n}`,
    etag: `etag${n}`,
  }));
  zoho.updateZohoEvent.mockImplementation(async (a: any) => ({
    status: "updated",
    uid: a.uid,
    etag: "newetag",
  }));
});

describe("buildMeetingDescription", () => {
  it("joins description, agenda and join link", () => {
    expect(buildMeetingDescription(mk())).toBe(
      "Desc\n\nAgenda:\nA1\n\nJoin: https://meeting.zoho.com/join?key=123",
    );
  });
  it("is empty when there is nothing to say", () => {
    expect(buildMeetingDescription({})).toBe("");
  });
});

describe("mapLimit", () => {
  it("never runs more than `limit` at once and keeps order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});

describe("pushNewMeetingsToZoho", () => {
  it("creates one event per occurrence and stores each uid + etag", async () => {
    await pushNewMeetingsToZoho([mk({ _id: "a" }), mk({ _id: "b" }), mk({ _id: "c" })], "org1");
    expect(zoho.createZohoEvent).toHaveBeenCalledTimes(3);
    const ops = meetingModel.bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(3);
    expect(ops[0].updateOne.update.$set).toEqual({
      calendarEventUid: expect.any(String),
      calendarEventEtag: expect.any(String),
    });
    expect(new Set(ops.map((o: any) => o.updateOne.update.$set.calendarEventUid)).size).toBe(3);
  });

  it("invites internal + external guests, lower-cased, minus the organizer", async () => {
    await pushNewMeetingsToZoho([mk()], "org1");
    const arg = zoho.createZohoEvent.mock.calls[0][0];
    expect(arg.attendeeEmails.sort()).toEqual(
      ["ann@x.com", "bob@x.com", "ext@y.com"].sort(),
    );
    expect(arg.url).toBe("https://meeting.zoho.com/join?key=123");
    expect(arg.withZohoMeeting).toBeUndefined(); // meeting is never re-created here
  });

  it("fills in a pre-generated Zoho Meeting event instead of duplicating it", async () => {
    await pushNewMeetingsToZoho(
      [mk({ _id: "a", calendarEventUid: "pre1" }), mk({ _id: "b" })],
      "org1",
    );
    const upd = zoho.updateZohoEvent.mock.calls[0][0];
    expect(upd.uid).toBe("pre1");
    expect(upd.conference).toBeUndefined(); // keep the attached meeting
    expect(zoho.createZohoEvent).toHaveBeenCalledTimes(1); // only the second
  });

  it("recreates the event if the pre-generated one is gone", async () => {
    zoho.updateZohoEvent.mockResolvedValue({ status: "gone" });
    await pushNewMeetingsToZoho([mk({ _id: "a", calendarEventUid: "pre1" })], "org1");
    expect(zoho.createZohoEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one occurrence fails", async () => {
    zoho.createZohoEvent
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ uid: "ok", etag: "e" });
    await pushNewMeetingsToZoho([mk({ _id: "a" }), mk({ _id: "b" })], "org1");
    expect(meetingModel.bulkWrite.mock.calls[0][0]).toHaveLength(1);
  });

  it("does nothing when the organizer has no Zoho connection", async () => {
    zoho.getZohoCalendarSession.mockResolvedValue(null);
    await pushNewMeetingsToZoho([mk()], "org1");
    expect(zoho.createZohoEvent).not.toHaveBeenCalled();
  });

  it("does nothing when Zoho isn't configured, and never throws", async () => {
    zoho.isZohoCalendarConfigured.mockReturnValue(false);
    await expect(pushNewMeetingsToZoho([mk()], "org1")).resolves.toBeUndefined();
    expect(zoho.getZohoCalendarSession).not.toHaveBeenCalled();
  });
});

describe("syncUpdatedMeetingToZoho", () => {
  it("updates the existing event in place and stores the new etag", async () => {
    const m = mk({
      calendarEventUid: "e1",
      calendarEventEtag: "old",
      conferenceProvider: "custom",
    });
    await syncUpdatedMeetingToZoho(m, {
      calendarEventUid: "e1",
      conferenceProvider: "custom",
    });
    expect(zoho.updateZohoEvent).toHaveBeenCalledTimes(1);
    expect(zoho.updateZohoEvent.mock.calls[0][0].etag).toBe("old");
    expect(zoho.createZohoEvent).not.toHaveBeenCalled();
    expect(meetingModel.updateOne).toHaveBeenCalledWith(
      { _id: m._id },
      { $set: { calendarEventEtag: "newetag" } },
    );
  });

  it("backfills an event for a meeting that never had one", async () => {
    const m = mk({ calendarEventUid: undefined });
    await syncUpdatedMeetingToZoho(m, {});
    expect(zoho.createZohoEvent).toHaveBeenCalledTimes(1);
    expect(meetingModel.updateOne).toHaveBeenCalledWith(
      { _id: m._id },
      { $set: { calendarEventUid: "uid1", calendarEventEtag: "etag1" } },
    );
    expect(m.calendarEventUid).toBe("uid1");
  });

  it("deletes the old event when a different Zoho Meeting event is swapped in", async () => {
    const m = mk({ calendarEventUid: "new", conferenceProvider: "zoho_meeting" });
    await syncUpdatedMeetingToZoho(m, {
      calendarEventUid: "old",
      conferenceProvider: "zoho_meeting",
    });
    expect(zoho.deleteZohoEvent).toHaveBeenCalledWith({ session: SESSION, uid: "old" });
  });

  it("detaches the Zoho Meeting when the link is changed to a custom one", async () => {
    const m = mk({ calendarEventUid: "e1", conferenceProvider: "custom" });
    await syncUpdatedMeetingToZoho(m, {
      calendarEventUid: "e1",
      conferenceProvider: "zoho_meeting",
    });
    expect(zoho.updateZohoEvent.mock.calls[0][0].conference).toBe("none");
    expect(zoho.deleteZohoEvent).not.toHaveBeenCalled();
    expect(zoho.createZohoEvent).not.toHaveBeenCalled();
  });

  it("leaves the meeting attached on a normal edit", async () => {
    const m = mk({ calendarEventUid: "e1", conferenceProvider: "zoho_meeting" });
    await syncUpdatedMeetingToZoho(m, {
      calendarEventUid: "e1",
      conferenceProvider: "zoho_meeting",
    });
    expect(zoho.updateZohoEvent.mock.calls[0][0].conference).toBeUndefined();
  });

  it("recreates the event if Zoho says it's gone", async () => {
    zoho.updateZohoEvent.mockResolvedValue({ status: "gone" });
    await syncUpdatedMeetingToZoho(mk({ calendarEventUid: "e1" }), {
      calendarEventUid: "e1",
    });
    expect(zoho.createZohoEvent).toHaveBeenCalledTimes(1);
  });

  it("swallows Zoho failures so the edit isn't lost", async () => {
    zoho.updateZohoEvent.mockRejectedValue(new Error("down"));
    await expect(
      syncUpdatedMeetingToZoho(mk({ calendarEventUid: "e1" }), { calendarEventUid: "e1" }),
    ).resolves.toBeUndefined();
  });
});

describe("removeMeetingsFromZoho", () => {
  it("deletes the event of every cancelled meeting, with its stored etag", async () => {
    await removeMeetingsFromZoho(
      [
        mk({ calendarEventUid: "e1", calendarEventEtag: "t1", conferenceProvider: "zoho_meeting" }),
        mk({ calendarEventUid: "e2", conferenceProvider: "custom" }),
        mk({ calendarEventUid: "e3", conferenceProvider: undefined }),
        mk({ calendarEventUid: undefined }),
      ],
      "org1",
    );
    const calls = zoho.deleteZohoEvent.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.uid).sort()).toEqual(["e1", "e2", "e3"]);
    expect(calls.find((c: any) => c.uid === "e1").etag).toBe("t1");
  });

  it("is a no-op when none have an event", async () => {
    await removeMeetingsFromZoho([mk({ calendarEventUid: undefined })], "org1");
    expect(zoho.getZohoCalendarSession).not.toHaveBeenCalled();
  });
});