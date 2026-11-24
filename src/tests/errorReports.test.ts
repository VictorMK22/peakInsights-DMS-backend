import "./testEnv";
import express from "express";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ErrorReport } from "../models/ErrorReport";
import { User } from "../models/User";
import Notification from "../models/Notification";
import * as storage from "../services/s3Storage";
import * as mail from "../services/emailService";
import {
  reportError,
  _resetFallbackThrottle,
} from "../services/errorReportService";
import {
  requestContext,
  installConsoleErrorCapture,
} from "../middleware/requestContext";
import { errorHandler } from "../middleware/errorHandler";

jest.mock("../services/s3Storage", () => ({
  ...jest.requireActual("../services/s3Storage"),
  uploadBufferToS3: jest.fn(),
  isS3Configured: jest.fn(),
}));
jest.mock("../services/emailService", () => ({
  ...jest.requireActual("../services/emailService"),
  sendErrorAlertEmail: jest.fn(),
  sendUserErrorReportEmail: jest.fn(),
  sendErrorReportCommentEmail: jest.fn(),
  sendErrorReportStatusEmail: jest.fn(),
}));

const upload = storage.uploadBufferToS3 as jest.Mock;
const s3Configured = storage.isS3Configured as jest.Mock;
const alertMail = mail.sendErrorAlertEmail as jest.Mock;
const userReportMail = mail.sendUserErrorReportEmail as jest.Mock;
const commentMail = mail.sendErrorReportCommentEmail as jest.Mock;
const statusMail = mail.sendErrorReportStatusEmail as jest.Mock;

// A real (tiny) PNG signature + padding — sniffImage checks the bytes.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const waitFor = async (fn: () => Promise<boolean>, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
};

beforeAll(async () => {
  process.env.ERROR_REPORTING_ENABLED = "true";
  // Email is opt-in; most tests below exercise the email path.
  process.env.ERROR_EMAILS_ENABLED = "true";
  await startTestDb();
  await ErrorReport.createIndexes();
  installConsoleErrorCapture();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
beforeEach(() => {
  alertMail.mockReset().mockResolvedValue(true);
  userReportMail.mockReset().mockResolvedValue(true);
  commentMail.mockReset().mockResolvedValue(true);
  statusMail.mockReset().mockResolvedValue(true);
  upload.mockReset().mockResolvedValue("stored-key.png");
  s3Configured.mockReset().mockReturnValue(true);
  _resetFallbackThrottle();
});
afterEach(async () => {
  jest.restoreAllMocks();
  delete process.env.ERROR_ALERT_EMAILS;
  await ErrorReport.deleteMany({});
  await Notification.deleteMany({});
  await User.deleteMany({});
});

const techSupervisor = async () => {
  const s = await createUserWithToken("supervisor");
  await User.updateOne({ _id: s.user._id }, { department: "ICT" });
  return s;
};

const boom = (msg = "db exploded") => new Error(msg);

describe("reportError: who is alerted", () => {
  it("emails active supervisors in a Tech department — and nobody else", async () => {
    const tech = await techSupervisor();
    const sales = await createUserWithToken("supervisor");
    await User.updateOne({ _id: sales.user._id }, { department: "Sales" });
    await createUserWithToken("tech"); // tech STAFF are not the supervisor

    await reportError({ source: "server", error: boom(), context: { method: "GET", route: "/api/x" } });

    expect(alertMail).toHaveBeenCalledTimes(1);
    expect(alertMail.mock.calls[0][0]).toBe(tech.user.email);
    const n = await Notification.findOne({ userId: tech.user._id });
    expect(n?.type).toBe("error_report_new");
  });

  it("also alerts ERROR_ALERT_EMAILS, de-duplicated against supervisors", async () => {
    const tech = await techSupervisor();
    process.env.ERROR_ALERT_EMAILS = `${tech.user.email}, backup@example.com`;
    await reportError({ source: "server", error: boom() });
    const to = alertMail.mock.calls.map((c) => c[0]).sort();
    expect(to).toEqual([tech.user.email, "backup@example.com"].sort());
  });

  it("does not throw or email when there is nobody to alert", async () => {
    await expect(reportError({ source: "server", error: boom() })).resolves.toBeUndefined();
    expect(alertMail).not.toHaveBeenCalled();
    expect(await ErrorReport.countDocuments()).toBe(1); // still stored
  });
});

describe("reportError: de-duplication", () => {
  it("collapses a burst of identical concurrent errors into ONE report and ONE email", async () => {
    await techSupervisor();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        reportError({
          source: "server",
          error: boom("db exploded"),
          context: { method: "GET", route: "/api/tasks/:id" },
          requestId: "aaaa1111",
        }),
      ),
    );
    const reports = await ErrorReport.find({});
    expect(reports).toHaveLength(1);
    expect(reports[0].occurrences).toBe(12);
    expect(alertMail).toHaveBeenCalledTimes(1);
  });

  it("does not re-alert inside the cooldown, and re-alerts after it while unacknowledged", async () => {
    await techSupervisor();
    const input = { source: "server" as const, error: boom(), context: { route: "/api/y" } };
    await reportError(input);
    await reportError(input);
    expect(alertMail).toHaveBeenCalledTimes(1);

    // pretend the last alert was 2 hours ago
    await ErrorReport.updateMany({}, { lastAlertedAt: new Date(Date.now() - 2 * 3600_000) });
    await reportError(input);
    expect(alertMail).toHaveBeenCalledTimes(2);
    expect(alertMail.mock.calls[1][2]).toMatchObject({ isRepeat: true, sinceLastAlert: 2 });
  });

  it("stays quiet once acknowledged, but a recurrence after RESOLVE is a new report + alert", async () => {
    await techSupervisor();
    const input = { source: "server" as const, error: boom(), context: { route: "/api/z" } };
    await reportError(input);
    const first = (await ErrorReport.findOne())!;

    await ErrorReport.updateOne({ _id: first._id }, { status: "acknowledged", lastAlertedAt: new Date(0) });
    await reportError(input);
    expect(alertMail).toHaveBeenCalledTimes(1); // acknowledged → silent

    // resolving frees the fingerprint (what PATCH does)
    await ErrorReport.updateOne({ _id: first._id }, { status: "resolved", $unset: { openKey: 1 } });
    await reportError(input);
    expect(await ErrorReport.countDocuments()).toBe(2);
    expect(alertMail).toHaveBeenCalledTimes(2);
  });

  it("different errors are different reports", async () => {
    await techSupervisor();
    await reportError({ source: "server", error: boom("one") });
    await reportError({ source: "server", error: new TypeError("two") });
    expect(await ErrorReport.countDocuments()).toBe(2);
  });

  it("stops emailing once the hourly alert budget is spent (still stores)", async () => {
    await techSupervisor();
    process.env.ERROR_ALERT_MAX_PER_HOUR = "2";
    try {
      for (let i = 0; i < 4; i++) await reportError({ source: "server", error: boom(`distinct ${i}x${"y".repeat(i)}`), context: { route: `/r${i}` } });
    } finally {
      delete process.env.ERROR_ALERT_MAX_PER_HOUR;
    }
    expect(await ErrorReport.countDocuments()).toBe(4);
    expect(alertMail).toHaveBeenCalledTimes(2);
  });

  it("scrubs credentials from what it stores and emails", async () => {
    await techSupervisor();
    await reportError({
      source: "server",
      error: boom("connect failed mongodb+srv://admin:hunter2@c0.mongodb.net Bearer abc.def"),
    });
    const r = (await ErrorReport.findOne())!;
    expect(r.message).not.toMatch(/hunter2|abc\.def/);
    expect(r.stack ?? "").not.toMatch(/hunter2/);
  });
});

describe("warnings are not emailed", () => {
  it("stores a low-severity (warning) report in the queue, but sends no email", async () => {
    const tech = await techSupervisor();
    await reportError({ source: "server", error: boom("minor"), severity: "low" });
    expect(await ErrorReport.countDocuments()).toBe(1);
    expect(alertMail).not.toHaveBeenCalled();
    // not marked as alerted, so it can still alert if it is later raised
    expect((await ErrorReport.findOne())!.lastAlertedAt).toBeUndefined();
    expect(await Notification.countDocuments({ userId: tech.user._id })).toBe(0);
  });

  it("a warning that the supervisor raises to high starts alerting", async () => {
    await techSupervisor();
    const input = { source: "server" as const, error: boom("grows"), severity: "low" as const, context: { route: "/api/w" } };
    await reportError(input);
    await ErrorReport.updateOne({}, { severity: "high" });
    await reportError(input);
    expect(alertMail).toHaveBeenCalledTimes(1);
  });

  it("a user report marked Minor is saved + visible, with no email to the supervisor", async () => {
    const tech = await techSupervisor();
    const u = await createUserWithToken("sales_person");
    const res = await request(app)
      .post("/api/error-reports")
      .set(auth(u.token))
      .field("description", "button is a bit misaligned")
      .field("severity", "low");
    expect(res.status).toBe(201);
    expect(res.body.data.notified).toMatchObject({ emailed: 0, emailSkipped: true });
    expect(userReportMail).not.toHaveBeenCalled();
    expect(await ErrorReport.countDocuments()).toBe(1);
    // still reaches the in-app bell
    expect(await Notification.countDocuments({ userId: tech.user._id, type: "error_report_new" })).toBe(1);
    // …and the tech team can see it in the queue
    const queue = await request(app).get("/api/error-reports").set(auth(tech.token));
    expect(queue.body.data.total).toBe(1);
  });

  it("the cutoff is configurable (ERROR_ALERT_MIN_SEVERITY)", async () => {
    await techSupervisor();
    process.env.ERROR_ALERT_MIN_SEVERITY = "critical";
    try {
      await reportError({ source: "server", error: boom("high but below cutoff"), severity: "high" });
      expect(alertMail).not.toHaveBeenCalled();
      await reportError({ source: "server", error: boom("down"), severity: "critical", context: { route: "/api/c" } });
      expect(alertMail).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.ERROR_ALERT_MIN_SEVERITY;
    }
  });

  it("replies back to the reporter are still emailed even on a Minor report", async () => {
    const tech = await techSupervisor();
    const u = await createUserWithToken("accountant");
    const created = await request(app).post("/api/error-reports").set(auth(u.token)).field("description", "typo").field("severity", "low");
    await request(app)
      .post(`/api/error-reports/${created.body.data.report._id}/comments`)
      .set(auth(tech.token))
      .field("body", "Fixed, thanks");
    expect(commentMail).toHaveBeenCalledTimes(1);
    expect(commentMail.mock.calls[0][0]).toBe(u.user.email);
  });
});

describe("in-workspace only (emails off, the default)", () => {
  const withEmailsOff = async (fn: () => Promise<void>) => {
    delete process.env.ERROR_EMAILS_ENABLED;
    try {
      await fn();
    } finally {
      process.env.ERROR_EMAILS_ENABLED = "true";
    }
  };

  it("an error is stored and rings the supervisor's bell — with NO email", async () => {
    await withEmailsOff(async () => {
      const tech = await techSupervisor();
      process.env.ERROR_ALERT_EMAILS = "oncall@example.com";
      await reportError({ source: "server", error: boom("workspace only") });
      expect(await ErrorReport.countDocuments()).toBe(1);
      expect(alertMail).not.toHaveBeenCalled();
      const n = await Notification.findOne({ userId: tech.user._id });
      expect(n?.type).toBe("error_report_new");
      const queue = await request(app).get("/api/error-reports").set(auth(tech.token));
      expect(queue.body.data.total).toBe(1);
    });
  });

  it("a user report reaches the supervisor in-app only, and says so", async () => {
    await withEmailsOff(async () => {
      const tech = await techSupervisor();
      const u = await createUserWithToken("sales_person");
      const res = await request(app)
        .post("/api/error-reports")
        .set(auth(u.token))
        .field("description", "page is blank")
        .field("severity", "high")
        .attach("screenshots", PNG, { filename: "image.png", contentType: "image/png" });
      expect(res.status).toBe(201);
      expect(res.body.data.notified).toMatchObject({ emailed: 0, emailsEnabled: false, recipients: 1 });
      expect(userReportMail).not.toHaveBeenCalled();
      expect(await Notification.countDocuments({ userId: tech.user._id, type: "error_report_new" })).toBe(1);
      const open = await request(app).get(`/api/error-reports/${res.body.data.report._id}`).set(auth(tech.token));
      expect(open.body.data.report.attachments).toHaveLength(1);
    });
  });

  it("replies and resolution notify the reporter in-app only", async () => {
    await withEmailsOff(async () => {
      const tech = await techSupervisor();
      const u = await createUserWithToken("accountant");
      const created = await request(app).post("/api/error-reports").set(auth(u.token)).field("description", "x").field("severity", "high");
      const id = created.body.data.report._id;
      await request(app).post(`/api/error-reports/${id}/comments`).set(auth(tech.token)).field("body", "on it");
      await request(app).patch(`/api/error-reports/${id}`).set(auth(tech.token)).send({ status: "resolved" });
      expect(commentMail).not.toHaveBeenCalled();
      expect(statusMail).not.toHaveBeenCalled();
      expect(await Notification.countDocuments({ userId: u.user._id })).toBe(2);
    });
  });

  it("DB unavailable and emails off: nothing is emailed (logged only)", async () => {
    await withEmailsOff(async () => {
      process.env.ERROR_ALERT_EMAILS = "oncall@example.com";
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      jest.spyOn(ErrorReport, "findOneAndUpdate").mockRejectedValue(new Error("db down") as never);
      await reportError({ source: "server", error: boom("no db") });
      expect(alertMail).not.toHaveBeenCalled();
    });
  });
});

describe("screenshots when storage (S3) is not configured", () => {
  it("answers 503 with a clear message, does NOT auto-report it as a system error, and tells the UI so", async () => {
    await techSupervisor();
    s3Configured.mockReturnValue(false);
    const u = await createUserWithToken("sales_person");
    const res = await request(app)
      .post("/api/error-reports")
      .set(auth(u.token))
      .field("description", "with image")
      .attach("screenshots", PNG, { filename: "image.png", contentType: "image/png" });
    expect(res.status).toBe(503);
    expect(res.body.reported).toBe(false);
    expect(res.body.message).toMatch(/S3/);
    await new Promise((r) => setTimeout(r, 200));
    expect(await ErrorReport.countDocuments()).toBe(0); // no report about the report
    expect(alertMail).not.toHaveBeenCalled();
  });
});

describe("reportError: database unavailable", () => {
  it("falls back to ERROR_ALERT_EMAILS, throttled in memory", async () => {
    process.env.ERROR_ALERT_EMAILS = "oncall@example.com";
    const spy = jest
      .spyOn(ErrorReport, "findOneAndUpdate")
      .mockRejectedValue(new Error("MongoNetworkError: db down") as never);
    try {
      await reportError({ source: "server", error: boom("no db"), severity: "critical" });
      await reportError({ source: "server", error: boom("no db"), severity: "critical" });
    } finally {
      spy.mockRestore();
    }
    expect(alertMail).toHaveBeenCalledTimes(1);
    expect(alertMail.mock.calls[0][0]).toBe("oncall@example.com");
  });
});

describe("5xx capture across the real middleware", () => {
  const build = () => {
    const a = express();
    a.use(express.json());
    a.use(requestContext);
    // The common pattern in this codebase: log, then answer 500 yourself.
    a.get("/api/things/:id", async (_req, res) => {
      await Promise.resolve();
      try {
        throw boom("swallowed failure");
      } catch (err) {
        console.error("getThing error:", err);
        res.status(500).json({ success: false, message: "Server error" });
      }
    });
    a.get("/api/forwarded", (_r, _s, next) => next(boom("forwarded failure")));
    a.get("/api/multer", (_r, _s, next) => {
      const e = new Error("File type .exe is not allowed");
      e.name = "MulterError";
      next(e);
    });
    a.get("/api/notfound", (_r, _s, next) => next(Object.assign(new Error("nope"), { statusCode: 404 })));
    a.use(errorHandler);
    return a;
  };

  it("reports a handler that swallowed its error (no next(err)) — with stack, normalised route and request id", async () => {
    await techSupervisor();
    // NB: console.error must NOT be spied here — that would replace the
    // capture hook this test is exercising.
    const res = await request(build()).get("/api/things/65f1a2b3c4d5e6f7a8b9c0d1?token=SECRET");
    expect(res.status).toBe(500);
    expect(res.headers["x-request-id"]).toMatch(/^[a-f0-9]{8}$/);

    await waitFor(async () => (await ErrorReport.countDocuments()) === 1);
    const r = (await ErrorReport.findOne())!;
    expect(r.context.route).toBe("/api/things/:id");
    expect(r.context.statusCode).toBe(500);
    expect(r.context.path).not.toContain("SECRET"); // query string dropped
    expect(r.message).toBe("swallowed failure");
    expect(r.stack).toContain("swallowed failure");
    expect(r.requestIds).toContain(res.headers["x-request-id"]);
    await waitFor(async () => alertMail.mock.calls.length === 1);
  });

  it("reports an error forwarded to errorHandler exactly once and returns the request id", async () => {
    await techSupervisor();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(build()).get("/api/forwarded");
    expect(res.status).toBe(500);
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
    await waitFor(async () => (await ErrorReport.countDocuments()) === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect((await ErrorReport.findOne())!.occurrences).toBe(1); // not double-counted
    expect(alertMail).toHaveBeenCalledTimes(1);
  });

  it("ignores caller-fault errors (multer / 4xx) so alerts stay meaningful", async () => {
    await techSupervisor();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const a = build();
    await request(a).get("/api/multer");
    await request(a).get("/api/notfound");
    await new Promise((r) => setTimeout(r, 200));
    expect(await ErrorReport.countDocuments()).toBe(0);
    expect(alertMail).not.toHaveBeenCalled();
  });
});

describe("POST /api/error-reports (a person shares a problem)", () => {
  it("stores screenshots + comment, emails the tech supervisor with the images attached, and notifies them", async () => {
    const tech = await techSupervisor();
    const sales = await createUserWithToken("supervisor");
    await User.updateOne({ _id: sales.user._id }, { department: "Sales" });
    const reporter = await createUserWithToken("sales_person");

    const res = await request(app)
      .post("/api/error-reports")
      .set(auth(reporter.token))
      .field("description", "The client page goes blank when I save")
      .field("severity", "high")
      .field("pageUrl", "https://app.example.com/sales/clients/65f1a2b3c4d5e6f7a8b9c0d1?x=1")
      .attach("screenshots", PNG, { filename: "image.png", contentType: "image/png" })
      .attach("screenshots", PNG, { filename: "snip.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.data.notified).toEqual({ emailed: 1, recipients: 1, emailsEnabled: true });
    expect(upload).toHaveBeenCalledTimes(2);
    // extension comes from the detected bytes, not the client filename
    expect(upload.mock.calls[0][0]).toBeInstanceOf(Buffer);
    expect(upload.mock.calls[0][1]).toBe("screenshot.png");

    const r = (await ErrorReport.findOne())!;
    expect(r.source).toBe("user_report");
    expect(r.severity).toBe("high");
    expect(r.attachments).toHaveLength(2);
    expect(r.context.pageUrl).toBe("/sales/clients/65f1a2b3c4d5e6f7a8b9c0d1"); // no query string
    expect(String(r.reportedBy)).toBe(String(reporter.user._id));

    expect(userReportMail).toHaveBeenCalledTimes(1);
    const [to, , data, attachments] = userReportMail.mock.calls[0];
    expect(to).toBe(tech.user.email); // not the Sales supervisor
    expect(data.reporterName).toBe(reporter.user.name);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].content).toBeInstanceOf(Buffer);
    expect(await Notification.countDocuments({ userId: tech.user._id, type: "error_report_new" })).toBe(1);
    // the reporter's view never contains internals
    expect(res.body.data.report.stack).toBeUndefined();
  });

  it("still saves the report if the email fails, and says so honestly", async () => {
    await techSupervisor();
    userReportMail.mockResolvedValue(false);
    const u = await createUserWithToken("accountant");
    const res = await request(app)
      .post("/api/error-reports")
      .set(auth(u.token))
      .field("description", "broken");
    expect(res.status).toBe(201);
    expect(res.body.data.notified.emailed).toBe(0);
    expect(await ErrorReport.countDocuments()).toBe(1);
  });

  it("rejects non-images pretending to be images, and empty reports — with 4xx, never 500", async () => {
    const u = await createUserWithToken("sales_person");
    const fake = await request(app)
      .post("/api/error-reports")
      .set(auth(u.token))
      .attach("screenshots", Buffer.from("<svg onload=alert(1)>padding padding"), {
        filename: "x.png",
        contentType: "image/png",
      });
    expect(fake.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();

    const empty = await request(app).post("/api/error-reports").set(auth(u.token)).field("title", "");
    expect(empty.status).toBe(400);

    const wrongType = await request(app)
      .post("/api/error-reports")
      .set(auth(u.token))
      .attach("screenshots", Buffer.from("hello"), { filename: "a.txt", contentType: "text/plain" });
    expect(wrongType.status).toBe(400);
  });

  it("links the report to the server error whose request id the person quotes", async () => {
    await techSupervisor();
    await reportError({ source: "server", error: boom("linked"), requestId: "deadbeef", context: { route: "/api/l" } });
    const server = (await ErrorReport.findOne({ source: "server" }))!;
    const u = await createUserWithToken("sales_person");
    await request(app)
      .post("/api/error-reports")
      .set(auth(u.token))
      .field("description", "saw this")
      .field("requestId", "DEADBEEF");
    const mine = (await ErrorReport.findOne({ source: "user_report" }))!;
    expect(String(mine.relatedReportId)).toBe(String(server._id));
  });

  it("requires login", async () => {
    const res = await request(app).post("/api/error-reports").field("description", "x");
    expect(res.status).toBe(401);
  });
});

describe("conversation + triage", () => {
  const filed = async () => {
    const tech = await techSupervisor();
    const reporter = await createUserWithToken("accountant");
    const other = await createUserWithToken("accountant");
    const created = await request(app)
      .post("/api/error-reports")
      .set(auth(reporter.token))
      .field("description", "report totals are wrong");
    return { tech, reporter, other, id: created.body.data.report._id as string };
  };

  it("only the reporter and the tech team can open a report (others get 404)", async () => {
    const { reporter, other, tech, id } = await filed();
    expect((await request(app).get(`/api/error-reports/${id}`).set(auth(reporter.token))).status).toBe(200);
    expect((await request(app).get(`/api/error-reports/${id}`).set(auth(tech.token))).status).toBe(200);
    expect((await request(app).get(`/api/error-reports/${id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).get(`/api/error-reports/not-an-id`).set(auth(other.token))).status).toBe(404);
  });

  it("regular users cannot list the whole queue or triage", async () => {
    const { reporter, id } = await filed();
    expect((await request(app).get("/api/error-reports").set(auth(reporter.token))).status).toBe(403);
    expect(
      (await request(app).patch(`/api/error-reports/${id}`).set(auth(reporter.token)).send({ status: "resolved" })).status,
    ).toBe(403);
  });

  it("/mine lists only my own reports", async () => {
    const { reporter, other } = await filed();
    const mine = await request(app).get("/api/error-reports/mine").set(auth(reporter.token));
    expect(mine.body.data.reports).toHaveLength(1);
    const theirs = await request(app).get("/api/error-reports/mine").set(auth(other.token));
    expect(theirs.body.data.reports).toHaveLength(0);
  });

  it("supervisor reply reaches the reporter; internal notes never do", async () => {
    const { tech, reporter, id } = await filed();

    const reply = await request(app)
      .post(`/api/error-reports/${id}/comments`)
      .set(auth(tech.token))
      .field("body", "Looking into it — can you send the period you ran?");
    expect(reply.status).toBe(201);
    expect(commentMail).toHaveBeenCalledTimes(1);
    expect(commentMail.mock.calls[0][0]).toBe(reporter.user.email);
    expect(await Notification.countDocuments({ userId: reporter.user._id, type: "error_report_comment" })).toBe(1);

    commentMail.mockClear();
    await request(app)
      .post(`/api/error-reports/${id}/comments`)
      .set(auth(tech.token))
      .field("body", "private: probably the FX rounding bug")
      .field("internal", "true");
    expect(commentMail).not.toHaveBeenCalled();

    const seenByReporter = await request(app).get(`/api/error-reports/${id}`).set(auth(reporter.token));
    const bodies = seenByReporter.body.data.report.comments.map((c: any) => c.body);
    expect(bodies).toEqual(["Looking into it — can you send the period you ran?"]);
    const seenByIct = await request(app).get(`/api/error-reports/${id}`).set(auth(tech.token));
    expect(seenByIct.body.data.report.comments).toHaveLength(2);
  });

  it("reporter reply (with a screenshot) goes to the tech team; writing on a resolved report re-opens it", async () => {
    const { tech, reporter, id } = await filed();
    await request(app).patch(`/api/error-reports/${id}`).set(auth(tech.token)).send({ status: "resolved" });
    expect(statusMail).toHaveBeenCalledTimes(1);
    expect(statusMail.mock.calls[0][0]).toBe(reporter.user.email);

    const res = await request(app)
      .post(`/api/error-reports/${id}/comments`)
      .set(auth(reporter.token))
      .field("body", "still wrong")
      .attach("screenshots", PNG, { filename: "image.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.data.report.status).toBe("new");
    expect(commentMail).toHaveBeenCalledTimes(1);
    expect(commentMail.mock.calls[0][0]).toBe(tech.user.email);
    expect(commentMail.mock.calls[0][3]).toHaveLength(1); // screenshot attached
    // reporter cannot flag their own comment internal
    const sneaky = await request(app)
      .post(`/api/error-reports/${id}/comments`)
      .set(auth(reporter.token))
      .field("body", "x")
      .field("internal", "true");
    expect(sneaky.body.data.report.comments.at(-1).internal).toBe(false);
  });

  it("triage: status / severity / assignee, with validation", async () => {
    const { tech, id } = await filed();
    const ok = await request(app)
      .patch(`/api/error-reports/${id}`)
      .set(auth(tech.token))
      .send({ status: "investigating", severity: "critical", assignee: String(tech.user._id) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.report).toMatchObject({ status: "investigating", severity: "critical" });
    expect((await request(app).patch(`/api/error-reports/${id}`).set(auth(tech.token)).send({ status: "bogus" })).status).toBe(400);
    expect((await request(app).patch(`/api/error-reports/${id}`).set(auth(tech.token)).send({})).status).toBe(400);
  });

  it("queue: filters, search by request id, counts", async () => {
    const { tech } = await filed();
    await reportError({ source: "server", error: boom("q"), requestId: "cafe0001", context: { route: "/api/q" } });
    const all = await request(app).get("/api/error-reports").set(auth(tech.token));
    expect(all.body.data.total).toBe(2);
    expect(all.body.data.counts.new).toBe(2);
    const srv = await request(app).get("/api/error-reports?source=server").set(auth(tech.token));
    expect(srv.body.data.total).toBe(1);
    const byRid = await request(app).get("/api/error-reports?q=cafe0001").set(auth(tech.token));
    expect(byRid.body.data.total).toBe(1);
    // list never ships stacks
    expect(srv.body.data.reports[0].stack).toBeUndefined();
  });

  it("re-opening a resolved auto-captured report fails cleanly if a newer one is already open", async () => {
    const { tech } = await filed();
    const input = { source: "server" as const, error: boom("again"), context: { route: "/api/again" } };
    await reportError(input);
    const old = (await ErrorReport.findOne({ source: "server" }))!;
    await request(app).patch(`/api/error-reports/${old._id}`).set(auth(tech.token)).send({ status: "resolved" });
    await reportError(input); // recurrence → new open report
    const res = await request(app).patch(`/api/error-reports/${old._id}`).set(auth(tech.token)).send({ status: "new" });
    expect(res.status).toBe(409);
  });
});

describe("only the tech supervisor has the error reports", () => {
  it("the CEO and Tech staff cannot list, open, comment on or triage other people's reports", async () => {
    const tech = await techSupervisor();
    const reporter = await createUserWithToken("sales_person");
    const created = await request(app).post("/api/error-reports").set(auth(reporter.token)).field("description", "broken").field("severity", "high");
    const id = created.body.data.report._id;

    for (const role of ["ceo", "tech"] as const) {
      const u = await createUserWithToken(role);
      expect((await request(app).get("/api/error-reports").set(auth(u.token))).status).toBe(403);
      expect((await request(app).get(`/api/error-reports/${id}`).set(auth(u.token))).status).toBe(404);
      expect((await request(app).post(`/api/error-reports/${id}/comments`).set(auth(u.token)).field("body", "x")).status).toBe(404);
      expect((await request(app).patch(`/api/error-reports/${id}`).set(auth(u.token)).send({ status: "resolved" })).status).toBe(403);
    }
    // the tech supervisor still can
    expect((await request(app).get("/api/error-reports").set(auth(tech.token))).status).toBe(200);
  });

  it("a supervisor outside the Tech department cannot either", async () => {
    await techSupervisor();
    const sales = await createUserWithToken("supervisor");
    await User.updateOne({ _id: sales.user._id }, { department: "Sales" });
    expect((await request(app).get("/api/error-reports").set(auth(sales.token))).status).toBe(403);
  });

  it("the CEO and Tech staff can still report a problem and follow their OWN report", async () => {
    const tech = await techSupervisor();
    for (const role of ["ceo", "tech"] as const) {
      const u = await createUserWithToken(role);
      const res = await request(app).post("/api/error-reports").set(auth(u.token)).field("description", `from ${role}`).field("severity", "high");
      expect(res.status).toBe(201);
      const id = res.body.data.report._id;
      const mine = await request(app).get("/api/error-reports/mine").set(auth(u.token));
      expect(mine.body.data.reports).toHaveLength(1);
      const own = await request(app).get(`/api/error-reports/${id}`).set(auth(u.token));
      expect(own.status).toBe(200);
      expect(own.body.data.report.stack).toBeUndefined(); // reporter view, not triage view
      // the tech supervisor is the one who gets told
      expect(await Notification.countDocuments({ userId: tech.user._id, type: "error_report_new" })).toBeGreaterThan(0);
      await Notification.deleteMany({});
    }
  });
});

describe("POST /api/error-reports/client (browser errors)", () => {
  it("accepts an anonymous browser crash, de-duplicates it, alerts once", async () => {
    await techSupervisor();
    const body = {
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'map')",
      stack: "TypeError: x\n at https://app/assets/index-abc.js:1:2",
      kind: "react-boundary",
      pageUrl: "https://app.example.com/sales/clients/65f1a2b3c4d5e6f7a8b9c0d1?tab=2",
    };
    const a = await request(app).post("/api/error-reports/client").send(body);
    expect(a.status).toBe(202);
    await waitFor(async () => (await ErrorReport.countDocuments()) === 1);
    await request(app).post("/api/error-reports/client").send(body);
    await waitFor(async () => (await ErrorReport.findOne())!.occurrences === 2);
    const r = (await ErrorReport.findOne())!;
    expect(r.source).toBe("client");
    expect(r.severity).toBe("high"); // react-boundary
    expect(r.context.route).toBe("/sales/clients/:id");
    expect(alertMail).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty payload", async () => {
    expect((await request(app).post("/api/error-reports/client").send({})).status).toBe(400);
  });
});