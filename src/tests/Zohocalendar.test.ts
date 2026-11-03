import "./testEnv";
import axios from "axios";

jest.mock("axios");
const http = axios as jest.Mocked<typeof axios>;

import {
  toZohoDateTime,
  parseZohoTime,
  buildEventData,
  parseEventResult,
  zohoMeetingJoinLink,
  parseZohoBusyEvents,
  parseZohoEventsForDisplay,
  createZohoEvent,
  updateZohoEvent,
  deleteZohoEvent,
  listZohoEvents,
  ZohoEventLike,
  ZohoCalendarSession,
} from "../services/zohoCalendarService";
import { dropEventsAlreadyShownAsMeetings } from "../controllers/zohoCalendarController";

const session: ZohoCalendarSession = {
  accessToken: "tok",
  calendarUid: "cal==",
  email: "me@x.com",
};
const fields = {
  title: "Sync",
  startTime: new Date("2026-11-02T09:00:00Z"),
  endTime: new Date("2026-11-02T10:00:00Z"),
};
const evData = (call: any[]) => JSON.parse(call[2].params.eventdata);
// axios.delete(url, config) has no body argument, so its config is 2nd.
const delData = (call: any[]) => JSON.parse(call[1].params.eventdata);

beforeEach(() => jest.resetAllMocks());

describe("date helpers", () => {
  it("formats dates the way Zoho expects", () => {
    expect(toZohoDateTime(new Date("2026-11-02T09:05:07.123Z"))).toBe(
      "20261102T090507Z",
    );
  });

  it("parses offset, Z, floating and all-day values", () => {
    expect(parseZohoTime("20170718T205000+0530")!.date.toISOString()).toBe(
      "2017-07-18T15:20:00.000Z",
    );
    expect(parseZohoTime("20170718T205000Z")!.date.toISOString()).toBe(
      "2017-07-18T20:50:00.000Z",
    );
    expect(parseZohoTime("20170718T205000")!.date.toISOString()).toBe(
      "2017-07-18T20:50:00.000Z",
    );
    const day = parseZohoTime("20170718")!;
    expect(day.allDay).toBe(true);
    expect(day.ymd).toBe("2017-07-18");
  });

  it("rejects garbage", () => {
    expect(parseZohoTime("nope")).toBeNull();
    expect(parseZohoTime(undefined)).toBeNull();
  });
});

describe("buildEventData", () => {
  it("builds a busy, non-notifying event with Zoho date formats", () => {
    const d: any = buildEventData({ ...fields, attendeeEmails: ["a@x.com"] });
    expect(d.dateandtime).toEqual({
      start: "20261102T090000Z",
      end: "20261102T100000Z",
    });
    expect(d.transparency).toBe(0);
    expect(d.notify_attendee).toBe(0);
    expect(d.attendees).toEqual([{ email: "a@x.com", permission: 1, attendance: 1 }]);
  });

  it("always sends description/location so edits can clear them", () => {
    const d: any = buildEventData(fields);
    expect(d.description).toBe("");
    expect(d.location).toBe("");
    expect(d.attendees).toBeUndefined();
  });

  it("bounds long free text (it travels in the URL)", () => {
    const d: any = buildEventData({
      ...fields,
      description: "x".repeat(5000),
      location: "y".repeat(500),
    });
    expect(d.description).toHaveLength(2000);
    expect(d.location).toHaveLength(255);
  });
});

describe("parseEventResult / join link", () => {
  it("reads uid, etag and the Zoho Meeting key", () => {
    const r = parseEventResult({
      uid: "u1@zoho.com",
      etag: 1669788841981,
      viewEventURL: "https://calendar.zoho.com/zc/viewevent/x",
      conference_data: { meetingdata: { meeting_id: "1074329242" } },
    });
    expect(r).toEqual({
      uid: "u1@zoho.com",
      etag: "1669788841981",
      viewUrl: "https://calendar.zoho.com/zc/viewevent/x",
      meetingKey: "1074329242",
    });
  });

  it("throws when Zoho returns no event", () => {
    expect(() => parseEventResult(undefined)).toThrow();
  });

  it("builds a guest join link (not the host start link)", () => {
    expect(zohoMeetingJoinLink("1074329242")).toBe(
      "https://meeting.zoho.com/join?key=1074329242",
    );
  });
});

describe("parseZohoBusyEvents", () => {
  const ev = (extra: Partial<ZohoEventLike> = {}): ZohoEventLike => ({
    uid: "e1",
    dateandtime: { start: "20261102T090000Z", end: "20261102T100000Z" },
    ...extra,
  });

  it("keeps an ordinary timed event", () => {
    const out = parseZohoBusyEvents([ev()]);
    expect(out).toHaveLength(1);
    expect(out[0].uid).toBe("e1");
  });

  it("skips free, all-day, cancelled and self-declined events", () => {
    const out = parseZohoBusyEvents(
      [
        ev({ transparency: 1 }),
        ev({ isallday: true, dateandtime: { start: "20261102", end: "20261103" } }),
        ev({ estatus: "cancelled" }),
        ev({ attendees: [{ email: "ME@x.com", status: "DECLINED" }] }),
      ],
      "me@x.com",
    );
    expect(out).toHaveLength(0);
  });

  it("keeps events where only someone else declined", () => {
    expect(
      parseZohoBusyEvents(
        [ev({ attendees: [{ email: "other@x.com", status: "DECLINED" }] })],
        "me@x.com",
      ),
    ).toHaveLength(1);
  });

  it("ignores malformed or zero-length events", () => {
    expect(
      parseZohoBusyEvents([
        ev({ dateandtime: { start: "bad", end: "bad" } }),
        ev({ dateandtime: { start: "20261102T090000Z", end: "20261102T090000Z" } }),
        { uid: "no-times" },
      ]),
    ).toHaveLength(0);
  });
});

describe("parseZohoEventsForDisplay", () => {
  const ev = (extra: Partial<ZohoEventLike> = {}): ZohoEventLike => ({
    uid: "g1",
    title: "Dentist",
    dateandtime: { start: "20261102T090000Z", end: "20261102T100000Z" },
    ...extra,
  });

  it("keeps titles, free and all-day events", () => {
    const out = parseZohoEventsForDisplay([
      ev(),
      ev({ uid: "g2", transparency: 1 }),
      ev({ uid: "g3", isallday: true, dateandtime: { start: "20261102", end: "20261103" } }),
    ]);
    expect(out.map((e) => e.uid)).toEqual(["g1", "g2", "g3"]);
    expect(out[0].title).toBe("Dentist");
    expect(out[1].free).toBe(true);
    expect(out[2].allDay).toBe(true);
    expect(out[2].start).toBe("2026-11-02");
    expect(out[2].end).toBe("2026-11-03");
  });

  it("makes a same-day all-day event span its day", () => {
    const [e] = parseZohoEventsForDisplay([
      ev({ isallday: true, dateandtime: { start: "20261102", end: "20261102" } }),
    ]);
    expect(e.end).toBe("2026-11-03");
  });

  it("gives each occurrence of a recurring event its own id", () => {
    const out = parseZohoEventsForDisplay([
      ev({ dateandtime: { start: "20261102T090000Z", end: "20261102T100000Z" } }),
      ev({ dateandtime: { start: "20261109T090000Z", end: "20261109T100000Z" } }),
    ]);
    expect(new Set(out.map((e) => e.id)).size).toBe(2);
  });

  it("drops cancelled and declined events; exposes the join link", () => {
    const out = parseZohoEventsForDisplay(
      [
        ev({ uid: "c", estatus: "cancelled" }),
        ev({ uid: "d", attendees: [{ email: "me@x.com", status: "DECLINED" }] }),
        ev({
          uid: "m",
          conference_data: { meetingdata: { meeting_id: "555" } },
        }),
      ],
      "me@x.com",
    );
    expect(out.map((e) => e.uid)).toEqual(["m"]);
    expect(out[0].meetLink).toBe("https://meeting.zoho.com/join?key=555");
  });
});

describe("dropEventsAlreadyShownAsMeetings", () => {
  const view = (uid: string, title: string) => ({
    id: uid,
    uid,
    title,
    start: "2026-11-02T09:00:00.000Z",
    end: "2026-11-02T10:00:00.000Z",
    allDay: false,
    free: false,
  });
  const known = {
    title: "Weekly sync",
    startTime: new Date("2026-11-02T09:00:00Z"),
    endTime: new Date("2026-11-02T10:00:00Z"),
  };

  it("hides events this app created, by uid", () => {
    const out = dropEventsAlreadyShownAsMeetings(
      [view("abc", "Renamed in Zoho")],
      [{ ...known, calendarEventUid: "abc" }],
    );
    expect(out).toHaveLength(0);
  });

  it("hides an invitee's copy by title + identical time", () => {
    const out = dropEventsAlreadyShownAsMeetings(
      [view("x", "weekly SYNC"), view("y", "Dentist")],
      [known],
    );
    expect(out.map((e) => e.uid)).toEqual(["y"]);
  });
});

describe("createZohoEvent", () => {
  it("asks Zoho for a meeting only when requested, and reads its key", async () => {
    http.post.mockResolvedValue({
      data: {
        events: [
          {
            uid: "u1",
            etag: 1,
            conference_data: { meetingdata: { meeting_id: "777" } },
          },
        ],
      },
    });
    const r = await createZohoEvent({ session, withZohoMeeting: true, ...fields });
    expect(evData(http.post.mock.calls[0]).conference).toBe("zmeeting");
    expect(http.post.mock.calls[0][2]!.headers!.Authorization).toBe(
      "Zoho-oauthtoken tok",
    );
    expect(r.meetingKey).toBe("777");

    http.post.mockClear();
    await createZohoEvent({ session, ...fields });
    expect(evData(http.post.mock.calls[0]).conference).toBeUndefined();
  });
});

describe("updateZohoEvent", () => {
  const ok = (etag: number) => ({ data: { events: [{ uid: "u1", etag }] } });

  it("PUTs with the stored etag (numeric in the body, string in the header)", async () => {
    http.put.mockResolvedValue(ok(2));
    const r = await updateZohoEvent({ session, uid: "u1", etag: "1", ...fields });
    expect(r).toMatchObject({ status: "updated", uid: "u1", etag: "2" });
    const body = evData(http.put.mock.calls[0]);
    expect(body.uid).toBe("u1");
    expect(body.etag).toBe(1);
    expect((http.put.mock.calls[0][2] as any).headers.etag).toBe("1");
  });

  it("keeps an attached meeting by NOT sending `conference`; detaches with 'none'", async () => {
    http.put.mockResolvedValue(ok(2));
    await updateZohoEvent({ session, uid: "u1", etag: "1", ...fields });
    expect(evData(http.put.mock.calls[0]).conference).toBeUndefined();

    await updateZohoEvent({ session, uid: "u1", etag: "1", conference: "none", ...fields });
    expect(evData(http.put.mock.calls[1]).conference).toBe("none");
  });

  it("refetches the etag and retries once when the stored one is stale", async () => {
    http.put
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce(ok(9));
    http.get.mockResolvedValue({ data: { events: [{ uid: "u1", etag: 222 }] } });
    const r = await updateZohoEvent({ session, uid: "u1", etag: "1", ...fields });
    expect(r).toMatchObject({ status: "updated", etag: "9" });
    expect(evData(http.put.mock.calls[1]).etag).toBe(222);
  });

  it("rethrows when the failure isn't an etag problem", async () => {
    http.put.mockRejectedValue({ response: { status: 500 } });
    http.get.mockResolvedValue({ data: { events: [{ uid: "u1", etag: 1 }] } });
    await expect(
      updateZohoEvent({ session, uid: "u1", etag: "1", ...fields }),
    ).rejects.toBeTruthy();
    expect(http.put).toHaveBeenCalledTimes(1);
  });

  it("reports 'gone' on 404, or when the refetch finds nothing", async () => {
    http.put.mockRejectedValue({ response: { status: 404 } });
    expect(await updateZohoEvent({ session, uid: "u1", etag: "1", ...fields })).toEqual({
      status: "gone",
    });

    http.put.mockReset();
    http.get.mockRejectedValue({ response: { status: 404 } });
    expect(await updateZohoEvent({ session, uid: "u1", ...fields })).toEqual({
      status: "gone",
    });
  });

  it("looks the etag up first when none is stored", async () => {
    http.get.mockResolvedValue({ data: { events: [{ uid: "u1", etag: 55 }] } });
    http.put.mockResolvedValue(ok(56));
    await updateZohoEvent({ session, uid: "u1", ...fields });
    expect(evData(http.put.mock.calls[0]).etag).toBe(55);
  });
});

describe("deleteZohoEvent", () => {
  it("deletes with the stored etag", async () => {
    http.delete.mockResolvedValue({ data: {} });
    await deleteZohoEvent({ session, uid: "u1", etag: "5" });
    expect(delData(http.delete.mock.calls[0]).etag).toBe(5);
  });

  it("treats an already-deleted event as success", async () => {
    http.delete.mockRejectedValue({ response: { status: 404 } });
    await expect(
      deleteZohoEvent({ session, uid: "u1", etag: "5" }),
    ).resolves.toBeUndefined();
  });

  it("retries with a fresh etag when the stored one is stale", async () => {
    http.delete
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({ data: {} });
    http.get.mockResolvedValue({ data: { events: [{ uid: "u1", etag: 99 }] } });
    await deleteZohoEvent({ session, uid: "u1", etag: "5" });
    expect(delData(http.delete.mock.calls[1]).etag).toBe(99);
  });

  it("does nothing if the event is already gone and no etag is stored", async () => {
    http.get.mockRejectedValue({ response: { status: 404 } });
    await deleteZohoEvent({ session, uid: "u1" });
    expect(http.delete).not.toHaveBeenCalled();
  });
});

describe("listZohoEvents", () => {
  it("splits long ranges into <=31-day queries and expands recurrences", async () => {
    http.get.mockResolvedValue({ data: { events: [{ uid: "a" }] } });
    const from = new Date("2026-11-01T00:00:00Z");
    const to = new Date("2027-01-10T00:00:00Z"); // 70 days
    const out = await listZohoEvents(session, from, to);
    expect(http.get).toHaveBeenCalledTimes(3);
    for (const call of http.get.mock.calls) {
      const p: any = (call[1] as any).params;
      expect(p.byinstance).toBe(true);
      const r = JSON.parse(p.range);
      const days =
        (parseZohoTime(r.end)!.date.getTime() - parseZohoTime(r.start)!.date.getTime()) /
        86_400_000;
      expect(days).toBeLessThanOrEqual(31);
    }
    expect(out).toHaveLength(3);
  });
});