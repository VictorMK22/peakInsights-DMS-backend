import "./testEnv";
import axios from "axios";
import {
  diagnoseZohoMeetingPassword,
  fetchZohoMeetingPassword,
  interpretMeetingPassword,
  parseEventResult,
  zohoMeetingJoinLink,
  ZohoCalendarSession,
} from "../services/zohoCalendarService";

// Zoho's meeting host in this environment (it depends on the configured region).
const MEETING_ORIGIN = new URL(zohoMeetingJoinLink("1")).origin;

// Each test uses its own calendar uid: the organization id is cached per
// calendar for the life of the process, and tests mustn't leak into each other.
let n = 0;
const session = (): ZohoCalendarSession => ({
  accessToken: "tok-123",
  calendarUid: `cal-${++n}`,
  email: "ceo@example.com",
});

const get = jest.spyOn(axios, "get");
const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

/** Zoho answering both calls: the org lookup, then the meeting itself. */
const zohoReturns = (session_: Record<string, unknown>, zsoid: unknown = 9001) =>
  get.mockImplementation(async (url: string) => {
    if (/user\.json$/.test(url)) return { data: { userDetails: { zsoid } } };
    return { data: { session: session_ } };
  });

const httpError = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

beforeEach(() => {
  get.mockReset();
  consoleError.mockClear();
});
afterAll(() => {
  get.mockRestore();
  consoleError.mockRestore();
});

describe("interpretMeetingPassword", () => {
  it("treats empty / missing as 'no password'", () => {
    for (const v of [undefined, null, "", "   "]) {
      expect(interpretMeetingPassword(v)).toEqual({ kind: "none" });
    }
  });

  it("accepts a full password, trimmed, including numeric ones", () => {
    expect(interpretMeetingPassword(" GLivoM ")).toEqual({ kind: "ok", password: "GLivoM" });
    expect(interpretMeetingPassword(482913)).toEqual({ kind: "ok", password: "482913" });
  });

  it("refuses a password Zoho has partly hidden — a guest can't use that", () => {
    expect(interpretMeetingPassword("a***z")).toEqual({ kind: "masked" });
    expect(interpretMeetingPassword("******")).toEqual({ kind: "masked" });
  });
});

describe("parseEventResult", () => {
  const event = (meetingdata: Record<string, unknown>) => ({
    uid: "u1",
    etag: "e1",
    conference_data: { meetingdata },
  });

  it("keeps the meeting key and picks up a password that came back in full", () => {
    const r = parseEventResult(event({ meeting_id: "1049772213", pwd: "Abc123" }));
    expect(r.meetingKey).toBe("1049772213");
    expect(r.meetingPassword).toBe("Abc123");
  });

  it("looks under other likely field names too", () => {
    expect(parseEventResult(event({ meeting_id: "1", password: "P1" })).meetingPassword).toBe("P1");
    expect(parseEventResult(event({ meeting_id: "1", meeting_password: "P2" })).meetingPassword).toBe("P2");
  });

  it("ignores a masked or absent password", () => {
    expect(parseEventResult(event({ meeting_id: "1", pwd: "a***z" })).meetingPassword).toBeUndefined();
    expect(parseEventResult(event({ meeting_id: "1" })).meetingPassword).toBeUndefined();
  });
});

describe("fetchZohoMeetingPassword", () => {
  it("looks up the organization, then returns the meeting's password", async () => {
    zohoReturns({ meetingKey: 1049772213, pwd: "Abc123" });
    const r = await fetchZohoMeetingPassword(session(), "1049772213");
    expect(r).toEqual({ status: "ok", password: "Abc123" });

    const [orgCall, meetingCall] = get.mock.calls;
    expect(orgCall[0]).toMatch(/\/api\/v2\/user\.json$/);
    expect(meetingCall[0]).toMatch(/\/api\/v2\/9001\/sessions\/1049772213\.json$/);
    // Authenticated as the host, and identifying itself to Zoho.
    expect((meetingCall[1] as any).headers).toMatchObject({
      Authorization: "Zoho-oauthtoken tok-123",
      "X-ZSOURCE": "PeakInsightsHub",
    });
  });

  it("only looks the organization up once per calendar", async () => {
    zohoReturns({ pwd: "Abc123" });
    const s = session();
    await fetchZohoMeetingPassword(s, "1");
    await fetchZohoMeetingPassword(s, "2");
    await fetchZohoMeetingPassword(s, "3");
    const orgCalls = get.mock.calls.filter(([u]) => /user\.json$/.test(String(u)));
    expect(orgCalls).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(4); // 1 org + 3 meetings
  });

  it("reports 'ok, no password' when the meeting has none — not a failure", async () => {
    zohoReturns({ meetingKey: 5, pwd: "" });
    expect(await fetchZohoMeetingPassword(session(), "5")).toEqual({ status: "ok" });
    zohoReturns({ meetingKey: 5 });
    expect(await fetchZohoMeetingPassword(session(), "5")).toEqual({ status: "ok" });
  });

  it("reports 'masked' when Zoho only returns part of the password", async () => {
    zohoReturns({ pwd: "a***z", encryptPwd: "a***z" });
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({
      status: "unavailable",
      reason: "masked",
    });
  });

  it("says to reconnect when the permission is missing (accounts connected before it existed)", async () => {
    get.mockRejectedValue(httpError(401, { error: { message: "INVALID_OAUTHTOKEN" } }));
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({
      status: "unavailable",
      reason: "needs_reconnect",
    });
    get.mockRejectedValue(httpError(400, { error: { code: 2000, message: "INVALID_OAUTHSCOPE" } }));
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({
      status: "unavailable",
      reason: "needs_reconnect",
    });
  });

  it("reports a plain 'error' for network trouble or Zoho being down — and never throws", async () => {
    get.mockRejectedValue(new Error("socket hang up"));
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({
      status: "unavailable",
      reason: "error",
    });
    get.mockRejectedValue(httpError(500, "Internal error"));
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({
      status: "unavailable",
      reason: "error",
    });
  });

  it("treats a response without an organization id as an error", async () => {
    get.mockResolvedValue({ data: { userDetails: {} } });
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({
      status: "unavailable",
      reason: "error",
    });
  });

  it("doesn't cache an organization id it never got, so the next call retries", async () => {
    const s = session();
    get.mockRejectedValueOnce(httpError(500));
    expect((await fetchZohoMeetingPassword(s, "1")).status).toBe("unavailable");
    zohoReturns({ pwd: "Later1" });
    expect(await fetchZohoMeetingPassword(s, "1")).toEqual({ status: "ok", password: "Later1" });
  });

  it("gives up after a few seconds instead of keeping a client waiting for their confirmation", async () => {
    jest.useFakeTimers();
    try {
      get.mockImplementation(() => new Promise(() => undefined)); // Zoho never answers
      const pending = fetchZohoMeetingPassword(session(), "1");
      await jest.advanceTimersByTimeAsync(6100);
      expect(await pending).toEqual({ status: "unavailable", reason: "error" });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("when Zoho's own join link carries the password", () => {
  const link = (qs: string) => `${MEETING_ORIGIN}/join?key=1049772213${qs}`;

  it("uses that link when the password itself is hidden — clients join with one click", async () => {
    zohoReturns({ pwd: "a***z", encryptPwd: "x***y", joinLink: link("&pwd=abcDEF123") });
    const r = await fetchZohoMeetingPassword(session(), "1049772213");
    expect(r).toEqual({ status: "ok", joinLink: link("&pwd=abcDEF123") });
  });

  it("returns both the password and the link when it has both", async () => {
    zohoReturns({ pwd: "Abc123", joinLink: link("&pwd=abcDEF123") });
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({
      status: "ok",
      password: "Abc123",
      joinLink: link("&pwd=abcDEF123"),
    });
  });

  it("ignores a join link with no password in it", async () => {
    zohoReturns({ pwd: "a***z", joinLink: link("") });
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({ status: "unavailable", reason: "masked" });
  });

  it("ignores a join link whose password is itself hidden", async () => {
    zohoReturns({ pwd: "a***z", joinLink: link("&pwd=ab***yz") });
    expect(await fetchZohoMeetingPassword(session(), "1")).toEqual({ status: "unavailable", reason: "masked" });
  });

  it("never accepts a link to some other site or over plain http", async () => {
    zohoReturns({ pwd: "a***z", joinLink: "https://evil.example.com/join?key=1&pwd=abc123" });
    expect((await fetchZohoMeetingPassword(session(), "1")).status).toBe("unavailable");
    zohoReturns({ pwd: "a***z", joinLink: `${MEETING_ORIGIN.replace("https:", "http:")}/join?key=1&pwd=abc123` });
    expect((await fetchZohoMeetingPassword(session(), "1")).status).toBe("unavailable");
    zohoReturns({ pwd: "a***z", joinLink: "javascript:alert(1)" });
    expect((await fetchZohoMeetingPassword(session(), "1")).status).toBe("unavailable");
  });
});

describe("diagnoseZohoMeetingPassword (the host's one-click check)", () => {
  const link = (qs: string) => `${MEETING_ORIGIN}/join?key=1${qs}`;

  it("says it works when Zoho returns the full password", async () => {
    zohoReturns({ pwd: "Abc123", encryptPwd: "XyZ789" });
    const d = await diagnoseZohoMeetingPassword(session(), "1");
    expect(d.verdict).toBe("works");
    expect(d.details).toEqual({
      organizationLookup: "ok", meetingLookup: "ok",
      password: "full", encryptedPassword: "full", joinLinkHasPassword: false,
    });
  });

  it("explains plainly when Zoho hides the password, and what to do instead", async () => {
    zohoReturns({ pwd: "a***z", encryptPwd: "a***z" });
    const d = await diagnoseZohoMeetingPassword(session(), "1");
    expect(d.verdict).toBe("hidden_by_zoho");
    expect(d.details.password).toBe("hidden");
    expect(d.message).toMatch(/partly hidden/);
    expect(d.message).toMatch(/send it to the client yourself/);
    expect(d.message).toMatch(/fixed meeting link/);
  });

  it("recognises a one-click link", async () => {
    zohoReturns({ pwd: "a***z", joinLink: link("&pwd=abcDEF123") });
    const d = await diagnoseZohoMeetingPassword(session(), "1");
    expect(d.verdict).toBe("one_click");
    expect(d.details.joinLinkHasPassword).toBe(true);
  });

  it("says when the meeting simply has no password", async () => {
    zohoReturns({ pwd: "" });
    const d = await diagnoseZohoMeetingPassword(session(), "1");
    expect(d.verdict).toBe("no_password");
    expect(d.details.password).toBe("none");
  });

  it("says to reconnect when the permission is missing — and where it failed", async () => {
    get.mockRejectedValue(httpError(401, { error: { message: "INVALID_OAUTHSCOPE" } }));
    const d = await diagnoseZohoMeetingPassword(session(), "1");
    expect(d.verdict).toBe("reconnect");
    expect(d.details).toMatchObject({ organizationLookup: "needs_reconnect", meetingLookup: "not_reached" });
    expect(d.message).toMatch(/reconnect Zoho Calendar/i);
  });

  it("separates 'organization lookup worked, meeting lookup failed'", async () => {
    get.mockImplementation(async (url: string) => {
      if (/user\.json$/.test(url)) return { data: { userDetails: { zsoid: 9001 } } };
      throw httpError(500);
    });
    const d = await diagnoseZohoMeetingPassword(session(), "1");
    expect(d.verdict).toBe("error");
    expect(d.details).toMatchObject({ organizationLookup: "ok", meetingLookup: "error" });
  });

  it("never reveals a password, and never throws", async () => {
    zohoReturns({ pwd: "SuperSecret99", encryptPwd: "AlsoSecret88", joinLink: link("&pwd=TokenSecret77") });
    const d = await diagnoseZohoMeetingPassword(session(), "1");
    const text = JSON.stringify(d);
    for (const secret of ["SuperSecret99", "AlsoSecret88", "TokenSecret77"]) {
      expect(text).not.toContain(secret);
    }
    get.mockRejectedValue(new Error("boom"));
    await expect(diagnoseZohoMeetingPassword(session(), "1")).resolves.toMatchObject({ verdict: "error" });
  });

  it("gives up after a few seconds", async () => {
    jest.useFakeTimers();
    try {
      get.mockImplementation(() => new Promise(() => undefined));
      const pending = diagnoseZohoMeetingPassword(session(), "1");
      await jest.advanceTimersByTimeAsync(6100);
      expect((await pending).verdict).toBe("error");
    } finally {
      jest.useRealTimers();
    }
  });
});