import "./maTestEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ClientModel } from "../models/Client";
import { User } from "../models/User";
import { SupervisorMapping } from "../models/SupervisorMapping";
import { ReportSubmission } from "../models/ReportSubmission";
import { MaPeriod } from "../models/MaPeriod";
import { ReportAuditEvent } from "../models/ReportAuditEvent";
import Notification from "../models/Notification";
import * as storage from "../services/s3Storage";
import * as mail from "../services/emailService";
import * as wf from "../services/reportWorkflowService";
import * as tracking from "../services/maTrackingService";
import { computePerformance } from "../services/maPerformanceService";

jest.mock("../services/s3Storage", () => ({
  ...jest.requireActual("../services/s3Storage"),
  createDirectUploadPost: jest.fn(async () => ({ url: "https://s3/upload", fields: {} })),
  headObject: jest.fn(),
  readObjectRange: jest.fn(),
  downloadFromS3: jest.fn(),
  deleteFromS3: jest.fn(async () => undefined),
}));
jest.mock("../services/emailService", () => ({
  ...jest.requireActual("../services/emailService"),
  sendClientReportEmail: jest.fn(),
  sendMaOverdueEmail: jest.fn(async () => true),
}));

const head = storage.headObject as jest.Mock;
const range = storage.readObjectRange as jest.Mock;
const download = storage.downloadFromS3 as jest.Mock;
const del = storage.deleteFromS3 as jest.Mock;
const sendClient = mail.sendClientReportEmail as jest.Mock;
const sendOverdue = mail.sendMaOverdueEmail as jest.Mock;

const PDF = Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n" + "x".repeat(80));
const NOT_PDF = Buffer.from("PK\u0003\u0004 this is really a zip/docx " + "y".repeat(80));
const stored = new Map<string, Buffer>();

// Fake only the clock so Mongo I/O keeps working.
const fakeNow = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(`${iso}+03:00`),
    doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask", "performance", "hrtime"],
  });

let ceo: any, sup: any, prim: any, sec: any, stranger: any;
let tok: Record<string, string> = {};
let client: any;
const A = (u: any) => ({ userId: String(u._id), role: u.role });

async function upload(user: any, id: string, filename: string, content: Buffer, mime = "application/pdf") {
  const [p] = await wf.presignFinalPdfs(A(user), id, [{ filename, mimeType: mime, size: content.length }]);
  stored.set(p.fileKey, content);
  return { fileKey: p.fileKey, filename, token: p.token, exp: p.exp };
}

beforeAll(async () => {
  await startTestDb();
  await Promise.all([ReportSubmission, MaPeriod, ReportAuditEvent].map((m: any) => m.syncIndexes()));
  head.mockImplementation(async (k: string) =>
    stored.has(k) ? { size: stored.get(k)!.length, contentType: k.endsWith(".pdf") ? "application/pdf" : "application/octet-stream" } : null);
  range.mockImplementation(async (k: string, s: number, e?: number) => {
    const b = stored.get(k)!;
    return s < 0 ? b.subarray(Math.max(0, b.length + s)) : b.subarray(s, (e ?? s + 1023) + 1);
  });
  download.mockImplementation(async (k: string) => stored.get(k)!);
});
afterAll(async () => { jest.useRealTimers(); await stopTestDb(); });

beforeEach(async () => {
  jest.useRealTimers();
  await Promise.all([User, ClientModel, SupervisorMapping, ReportSubmission, MaPeriod, ReportAuditEvent, Notification].map((m: any) => m.deleteMany({})));
  stored.clear();
  [sendClient, sendOverdue, del].forEach((m) => m.mockClear());
  sendClient.mockReset();
  sendClient.mockResolvedValue({ messageId: "<msg-1@peak-insights.com>", providerId: "re_1" });

  ({ user: ceo, token: tok.ceo } = await createUserWithToken("ceo", { name: "Chief Exec", email: "ceo@peak-insights.com" }));
  ({ user: sup, token: tok.sup } = await createUserWithToken("supervisor", { name: "Emmanuel", email: "emmanuel@peak-insights.com" }));
  await User.updateOne({ _id: sup._id }, { department: "Accounting" });
  ({ user: prim, token: tok.prim } = await createUserWithToken("accountant", { name: "Pat Primary", email: "pat@peak-insights.com" }));
  ({ user: sec, token: tok.sec } = await createUserWithToken("accountant", { name: "Sam Secondary", email: "sam@peak-insights.com" }));
  ({ user: stranger, token: tok.stranger } = await createUserWithToken("accountant", { name: "Other Acct", email: "other@peak-insights.com" }));
  for (const a of [prim, sec, stranger])
    await SupervisorMapping.create({ supervisorId: sup._id, subordinateId: a._id, departmentName: "Accounting", assignedBy: ceo._id });
  client = await ClientModel.create({
    name: "Bright and Chaste Limited", email: "finance@bright.co.ke", company: "Bright and Chaste",
    createdBy: ceo._id, assignedTo: [prim._id, sec._id], allocatedAccountant: prim._id, isSalesLead: false,
  } as any);
});

const submitDraft = async () => {
  fakeNow("2026-11-10T09:00:00");
  const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
  await wf.saveDraft(A(prim), String(r._id), { summary: "October MAs prepared, reconciled and checked." });
  return wf.submitForReview(A(prim), String(r._id));
};

describe("workflow: submit → approve → attach → send", () => {
  it("approval does NOT email; only the explicit send does, as the CEO, with de-duplicated CC", async () => {
    const s = await submitDraft();
    expect(s.status).toBe("pending_review");
    expect(await Notification.countDocuments({ userId: sup._id, type: "report_submitted" })).toBe(1);

    const approved = await wf.approveReport(A(sup), String(s._id));
    expect(approved.status).toBe("approved");
    expect(sendClient).not.toHaveBeenCalled(); // ← approval is not delivery

    const ref = await upload(sup, String(s._id), "Bright - Financial Reports Oct 2026.pdf", PDF);
    const withPdf = await wf.attachFinalPdfs(A(sup), String(s._id), [ref]);
    const attId = String(withPdf.finalAttachments[0]._id);
    expect(sendClient).not.toHaveBeenCalled();

    const res = await wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: [attId] });
    expect(res.report.status).toBe("sent");
    expect(sendClient).toHaveBeenCalledTimes(1);
    const o = sendClient.mock.calls[0][0];
    expect(o.ceo.email).toBe("ceo@peak-insights.com"); // sender identity = CEO
    expect(o.toEmail).toBe("finance@bright.co.ke");
    expect(o.ccEmails.sort()).toEqual(["emmanuel@peak-insights.com", "pat@peak-insights.com", "sam@peak-insights.com"]);
    expect(o.subject).toBe("Management Accounts – Bright and Chaste Limited – October 2026");
    expect(o.attachments).toHaveLength(1);

    const saved = await ReportSubmission.findById(s._id);
    expect(String(saved!.delivery!.initiatedBy)).toBe(String(sup._id)); // initiator ≠ sender
    expect(saved!.delivery!.senderEmail).toBe("ceo@peak-insights.com");
    expect(saved!.delivery!.messageId).toBe("<msg-1@peak-insights.com>");
    expect((await MaPeriod.findOne({ clientId: client._id }))!.sentAt).toBeTruthy();
  });

  it("a second Send (double-click / retry) never sends a second email", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    const ref = await upload(sup, String(s._id), "r.pdf", PDF);
    const a = await wf.attachFinalPdfs(A(sup), String(s._id), [ref]);
    const ids = [String(a.finalAttachments[0]._id)];
    const [r1, r2] = await Promise.allSettled([
      wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: ids }),
      wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: ids }),
    ]);
    expect(sendClient).toHaveBeenCalledTimes(1);
    expect([r1.status, r2.status]).toContain("fulfilled");
    const again = await wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: ids });
    expect(again.alreadySent).toBe(true);
    expect(sendClient).toHaveBeenCalledTimes(1);
  });

  it("refuses to send before approval, without PDFs, or without confirming the attachments", async () => {
    const s = await submitDraft();
    await expect(wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: [] })).rejects.toMatchObject({ statusCode: 409 });
    await wf.approveReport(A(sup), String(s._id));
    await expect(wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: [] })).rejects.toMatchObject({ statusCode: 400 });
    const ref = await upload(sup, String(s._id), "r.pdf", PDF);
    await wf.attachFinalPdfs(A(sup), String(s._id), [ref]);
    await expect(wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: [] })).rejects.toMatchObject({ code: "CONFIRM_ATTACHMENTS" });
    expect(sendClient).not.toHaveBeenCalled();
  });

  it("a failed delivery keeps approval + PDFs and can be retried", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    const ref = await upload(sup, String(s._id), "r.pdf", PDF);
    const a = await wf.attachFinalPdfs(A(sup), String(s._id), [ref]);
    const ids = [String(a.finalAttachments[0]._id)];
    sendClient.mockRejectedValueOnce(new Error("Resend is down"));
    await expect(wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: ids })).rejects.toMatchObject({ code: "DELIVERY_FAILED" });
    let saved = await ReportSubmission.findById(s._id);
    expect(saved!.status).toBe("delivery_failed");
    expect(saved!.approvedAt).toBeTruthy();
    expect(saved!.finalAttachments.filter((f) => !f.removedAt)).toHaveLength(1);
    expect(saved!.sentAt).toBeUndefined(); // Last MAs Sent must not move
    expect((await MaPeriod.findOne({ clientId: client._id }))!.sentAt).toBeFalsy();

    const ok = await wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: ids });
    expect(ok.report.status).toBe("sent");
    saved = await ReportSubmission.findById(s._id);
    expect(saved!.delivery!.attempts.map((x) => x.status)).toEqual(["failed", "sent"]);
  });

  it("CEO_SENDER_EMAIL names the CEO's official address, even when his login email is elsewhere", async () => {
    await User.updateOne({ _id: ceo._id }, { email: "nixon.personal@gmail.com" });
    process.env.CEO_SENDER_EMAIL = "ceo.office@peak-insights.com";
    try {
      const s = await submitDraft();
      await wf.approveReport(A(sup), String(s._id));
      const ref = await upload(sup, String(s._id), "r.pdf", PDF);
      const a = await wf.attachFinalPdfs(A(sup), String(s._id), [ref]);
      const res = await wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: [String(a.finalAttachments[0]._id)] });
      expect(res.report.status).toBe("sent");
      expect(sendClient.mock.calls[0][0].ceo.email).toBe("ceo.office@peak-insights.com");
      expect(sendClient.mock.calls[0][0].ceo.name).toBe("Chief Exec"); // still the CEO's name
      expect(res.report.delivery!.senderEmail).toBe("ceo.office@peak-insights.com");
    } finally {
      delete process.env.CEO_SENDER_EMAIL;
    }
  });

  it("does not send (and does not fall back) when the CEO identity is not authorised", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    const ref = await upload(sup, String(s._id), "r.pdf", PDF);
    const a = await wf.attachFinalPdfs(A(sup), String(s._id), [ref]);
    await User.updateOne({ _id: ceo._id }, { email: "ceo@gmail.com" });
    await expect(wf.sendReportToClient(A(sup), String(s._id), { confirmedAttachmentIds: [String(a.finalAttachments[0]._id)] }))
      .rejects.toMatchObject({ code: "CEO_SENDER_NOT_CONFIGURED", statusCode: 409 });
    expect(sendClient).not.toHaveBeenCalled();
    expect((await ReportSubmission.findById(s._id))!.status).toBe("approved");
  });
});

describe("return for corrections keeps history", () => {
  it("returns with comments, accountants resubmit, versions are preserved", async () => {
    const s = await submitDraft();
    await expect(wf.returnForCorrections(A(sup), String(s._id), " ")).rejects.toMatchObject({ statusCode: 400 });
    const r = await wf.returnForCorrections(A(sup), String(s._id), "Bank rec is off by 4,200.");
    expect(r.status).toBe("returned");
    expect(await Notification.countDocuments({ userId: { $in: [prim._id, sec._id] }, type: "report_returned" })).toBe(2);
    await wf.saveDraft(A(prim), String(s._id), { summary: "Fixed the bank reconciliation difference." });
    const again = await wf.submitForReview(A(prim), String(s._id));
    expect(again.status).toBe("pending_review");
    expect(again.revision).toBe(2);
    expect(again.versions.map((v) => v.decision)).toEqual(["returned", "pending"]);
    expect(again.versions[0].comments).toMatch(/Bank rec/);
    expect(await Notification.countDocuments({ userId: sup._id, type: "report_resubmitted" })).toBe(1);
  });

  it("an approved report cannot be silently edited; re-opening retires its PDFs", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    await expect(wf.saveDraft(A(prim), String(s._id), { summary: "sneaky change after approval" })).rejects.toMatchObject({ statusCode: 409 });
    const ref = await upload(sup, String(s._id), "r.pdf", PDF);
    await wf.attachFinalPdfs(A(sup), String(s._id), [ref]);
    const re = await wf.reopenReport(A(sup), String(s._id), "Material adjustment found");
    expect(re.status).toBe("returned");
    expect(re.approvedAt).toBeUndefined();
    expect(re.finalAttachments.every((f) => f.supersededAt)).toBe(true);
  });
});

describe("PDF-only attachments", () => {
  it("rejects non-PDF types before anything is uploaded", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    for (const [name, mime] of [["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["b.xlsx", "application/vnd.ms-excel"], ["c.png", "image/png"]])
      await expect(wf.presignFinalPdfs(A(sup), String(s._id), [{ filename: name, mimeType: mime, size: 1000 }])).rejects.toMatchObject({ statusCode: 400 });
  });
  it("rejects a renamed non-PDF by inspecting its contents, and deletes it", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    const ref = await upload(sup, String(s._id), "fake.pdf", NOT_PDF);
    await expect(wf.attachFinalPdfs(A(sup), String(s._id), [ref])).rejects.toMatchObject({ statusCode: 400 });
    expect(del).toHaveBeenCalledWith(ref.fileKey);
    expect((await ReportSubmission.findById(s._id))!.finalAttachments).toHaveLength(0);
  });
  it("rejects a tampered upload token", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    const ref = await upload(sup, String(s._id), "r.pdf", PDF);
    await expect(wf.attachFinalPdfs(A(sup), String(s._id), [{ ...ref, token: "0".repeat(64) }])).rejects.toMatchObject({ statusCode: 400 });
  });
  it("lets the supervisor remove and replace an attachment before sending", async () => {
    const s = await submitDraft();
    await wf.approveReport(A(sup), String(s._id));
    const a = await wf.attachFinalPdfs(A(sup), String(s._id), [await upload(sup, String(s._id), "old.pdf", PDF)]);
    const removed = await wf.removeFinalPdf(A(sup), String(s._id), String(a.finalAttachments[0]._id));
    expect(removed.finalAttachments.filter((f) => !f.removedAt)).toHaveLength(0);
    const b = await wf.attachFinalPdfs(A(sup), String(s._id), [await upload(sup, String(s._id), "new.pdf", PDF)]);
    expect(b.finalAttachments.filter((f) => !f.removedAt).map((f) => f.filename)).toEqual(["new.pdf"]);
  });
});

describe("backend permissions", () => {
  it("accountants cannot approve, return, attach or send (service + HTTP)", async () => {
    const s = await submitDraft();
    const id = String(s._id);
    await expect(wf.approveReport(A(prim), id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(wf.returnForCorrections(A(prim), id, "x y z")).rejects.toMatchObject({ statusCode: 403 });
    await expect(wf.sendReportToClient(A(prim), id, {})).rejects.toMatchObject({ statusCode: 403 });
    for (const path of ["approve", "send"]) {
      const res = await request(app).post(`/api/reports/${id}/${path}`).set("Authorization", `Bearer ${tok.prim}`).send({});
      expect(res.status).toBe(403);
    }
    const ceoTry = await request(app).post(`/api/reports/${id}/approve`).set("Authorization", `Bearer ${tok.ceo}`).send({});
    expect(ceoTry.status).toBe(403); // CEO does not review or deliver
    expect((await ReportSubmission.findById(id))!.status).toBe("pending_review");
  });
  it("an unassigned accountant can neither see nor submit someone else's report", async () => {
    const s = await submitDraft();
    await expect(wf.getReportDetail(A(stranger), String(s._id))).rejects.toMatchObject({ statusCode: 403 });
    await expect(wf.submitForReview(A(stranger), String(s._id))).rejects.toMatchObject({ statusCode: 403 });
    const res = await request(app).get(`/api/reports/${s._id}`).set("Authorization", `Bearer ${tok.stranger}`);
    expect(res.status).toBe(403);
  });
  it("Emmanuel's own client: the Secondary submits to him; he reviews, approves and sends", async () => {
    // Emmanuel (supervisor) is the client's Primary; Sam is the Secondary.
    const mine = await ClientModel.create({
      name: "Emmanuel's Client Ltd", email: "fin@emmclient.co.ke", company: "EC",
      createdBy: ceo._id, assignedTo: [sup._id, sec._id], allocatedAccountant: sup._id, isSalesLead: false,
    } as any);
    fakeNow("2026-11-10T09:00:00");
    const r = await wf.openMaReport(A(sec), String(mine._id), "2026-10");
    expect(String(r.primaryAccountantId)).toBe(String(sup._id));
    await wf.saveDraft(A(sec), String(r._id), { summary: "Sam prepared Emmanuel's client's October MAs." });

    const submitted = await wf.submitForReview(A(sec), String(r._id));
    expect(submitted.status).toBe("pending_review");
    expect(submitted.supervisorIds.map(String)).toEqual([String(sup._id)]); // routed to Emmanuel
    expect(await Notification.countDocuments({ userId: sup._id, type: "report_submitted" })).toBe(1);

    // Emmanuel sees it in his review queue and can act on it.
    const detail = await wf.getReportDetail(A(sup), String(r._id));
    expect(detail.can.review).toBe(true);
    await wf.approveReport(A(sup), String(r._id));
    const a = await wf.attachFinalPdfs(A(sup), String(r._id), [await upload(sup, String(r._id), "r.pdf", PDF)]);
    const sent = await wf.sendReportToClient(A(sup), String(r._id), { confirmedAttachmentIds: [String(a.finalAttachments[0]._id)] });
    expect(sent.report.status).toBe("sent");
    const o = sendClient.mock.calls[0][0];
    expect(o.ceo.email).toBe("ceo@peak-insights.com");
    expect(o.ccEmails.sort()).toEqual(["emmanuel@peak-insights.com", "sam@peak-insights.com"]); // Emmanuel once, no duplicates
  });

  it("Emmanuel cannot submit his own client's report to himself; the UI is told why", async () => {
    const mine = await ClientModel.create({
      name: "Emmanuel's Client Ltd", email: "fin@emmclient.co.ke", company: "EC",
      createdBy: ceo._id, assignedTo: [sup._id, sec._id], allocatedAccountant: sup._id, isSalesLead: false,
    } as any);
    fakeNow("2026-11-10T09:00:00");
    const r = await wf.openMaReport(A(sup), String(mine._id), "2026-10");
    await wf.saveDraft(A(sup), String(r._id), { summary: "Emmanuel started this report himself." });
    const d = await wf.getReportDetail(A(sup), String(r._id));
    expect(d.can).toMatchObject({ edit: true, submit: false });
    expect(d.submitBlockedReason).toMatch(/Sam Secondary/);
    await expect(wf.submitForReview(A(sup), String(r._id))).rejects.toMatchObject({ statusCode: 409, code: "NO_REVIEWER" });
    // …but the Secondary can submit it to him.
    expect((await wf.submitForReview(A(sec), String(r._id))).status).toBe("pending_review");
  });

  it("with a second supervisor, a supervisor's own submission goes to the other one — never to himself", async () => {
    const mine = await ClientModel.create({
      name: "Emmanuel's Client Ltd", email: "fin@emmclient.co.ke", company: "EC",
      createdBy: ceo._id, assignedTo: [sup._id, sec._id], allocatedAccountant: sup._id, isSalesLead: false,
    } as any);
    const { user: sup2 } = await createUserWithToken("supervisor", { name: "Second Sup", email: "sup2@peak-insights.com" });
    await User.updateOne({ _id: sup2._id }, { department: "Accounting" });
    fakeNow("2026-11-10T09:00:00");
    const r = await wf.openMaReport(A(sup), String(mine._id), "2026-10");
    await wf.saveDraft(A(sup), String(r._id), { summary: "Emmanuel prepared and submitted this one." });
    const sub = await wf.submitForReview(A(sup), String(r._id));
    expect(sub.supervisorIds.map(String)).toEqual([String(sup2._id)]);
    await expect(wf.approveReport(A(sup), String(r._id))).rejects.toMatchObject({ statusCode: 403 }); // not his own submission
    expect((await wf.approveReport(A(sup2), String(r._id))).status).toBe("approved");
  });

  it("submitting requires report details", async () => {
    fakeNow("2026-11-10T09:00:00");
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    await expect(wf.submitForReview(A(prim), String(r._id))).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("monthly deadline monitoring & overdue alerts", () => {
  it("full lifecycle: overdue → alert stays through review → clears on approval → delivery tracked separately", async () => {
    fakeNow("2026-11-12T08:00:00");
    const before = await tracking.runMaDeadlineMonitor();
    expect(before.period).toBe("2026-10");
    expect(before.periodsCreated).toBe(1);
    expect(before.alertsActive).toBe(0);
    expect(sendOverdue).not.toHaveBeenCalled();

    // 16 Nov in Nairobi: the 15th has passed.
    fakeNow("2026-11-16T07:00:00");
    const m1 = await tracking.runMaDeadlineMonitor();
    expect(m1.alertsActive).toBe(1);
    expect(sendOverdue).toHaveBeenCalledTimes(2); // BOTH accountants
    expect(sendOverdue.mock.calls.map((c) => c[0]).sort()).toEqual(["pat@peak-insights.com", "sam@peak-insights.com"]);
    expect(await Notification.countDocuments({ type: "ma_overdue" })).toBe(2);

    // Same day again → no duplicates.
    await tracking.runMaDeadlineMonitor();
    await tracking.runMaDeadlineMonitor();
    expect(sendOverdue).toHaveBeenCalledTimes(2);
    expect(await Notification.countDocuments({ type: "ma_overdue" })).toBe(2);

    // Visible on the hub, with details.
    let alerts = await tracking.listActiveAlerts({ accountantId: String(sec._id) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ clientName: client.name, periodLabel: "October 2026", daysOverdue: 1, workflowStatus: "not_started" });
    expect(alerts[0].primary?.name).toBe("Pat Primary");

    // Submit for review: alert MUST stay.
    fakeNow("2026-11-17T09:00:00");
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    await wf.saveDraft(A(prim), String(r._id), { summary: "October MAs complete and reconciled." });
    await wf.submitForReview(A(prim), String(r._id));
    alerts = await tracking.listActiveAlerts({ accountantId: String(prim._id) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].deadlineStatus).toBe("overdue_pending_review");
    expect((await MaPeriod.findOne({ clientId: client._id }))!.alertActive).toBe(true);

    // Approve: alert clears, but delivery is still being tracked (overdue).
    fakeNow("2026-11-18T09:00:00");
    await wf.approveReport(A(sup), String(r._id));
    expect(await tracking.listActiveAlerts({ accountantId: String(prim._id) })).toHaveLength(0);
    const period = await MaPeriod.findOne({ clientId: client._id });
    expect(period!.alertActive).toBe(false);
    expect(period!.alertHistory).toHaveLength(1);
    expect(period!.alertHistory[0].clearReason).toBe("approved");
    expect(period!.alertHistory[0].clearedAt).toBeTruthy(); // history preserved
    const mon = await tracking.deliveryMonitor({ periodKey: "2026-10" });
    expect(mon[0].deadlineStatus).toBe("approved_awaiting_delivery_overdue");
    expect(mon[0].deliveryOverdue).toBe(true);
    let t = await tracking.getClientMaTracking((await ClientModel.findById(client._id))!);
    expect(t.lastSent).toBeNull(); // approval ≠ delivery

    // Send: Last MAs Sent updates only now.
    fakeNow("2026-11-19T09:00:00");
    const ref = await upload(sup, String(r._id), "r.pdf", PDF);
    const a = await wf.attachFinalPdfs(A(sup), String(r._id), [ref]);
    await wf.sendReportToClient(A(sup), String(r._id), { confirmedAttachmentIds: [String(a.finalAttachments[0]._id)] });
    t = await tracking.getClientMaTracking((await ClientModel.findById(client._id))!);
    expect(t.lastSent).toMatchObject({ periodKey: "2026-10", periodLabel: "October 2026" });
    expect(t.current).toMatchObject({ deadlineStatus: "sent", workflowStatus: "sent" });
    const actions = (await ReportAuditEvent.find({ clientId: client._id }).sort({ at: 1 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["overdue_triggered", "overdue_notified", "submitted", "overdue_cleared", "approved", "final_pdf_uploaded", "delivery_initiated", "delivery_sent"]));
  });

  it("sends a spaced reminder after 3 days, never daily spam", async () => {
    fakeNow("2026-11-16T07:00:00");
    await tracking.runMaDeadlineMonitor();
    fakeNow("2026-11-17T07:00:00");
    await tracking.runMaDeadlineMonitor();
    expect(sendOverdue).toHaveBeenCalledTimes(2);
    fakeNow("2026-11-19T07:00:00");
    await tracking.runMaDeadlineMonitor();
    expect(sendOverdue).toHaveBeenCalledTimes(4);
    expect(sendOverdue.mock.calls[2][1].reminder).toBe(true);
  });

  it("skips exempt clients and clients that start later", async () => {
    await ClientModel.updateOne({ _id: client._id }, { maRequired: false });
    fakeNow("2026-11-16T07:00:00");
    const m = await tracking.runMaDeadlineMonitor();
    expect(m.periodsCreated).toBe(0);
    expect(sendOverdue).not.toHaveBeenCalled();
    await ClientModel.updateOne({ _id: client._id }, { maRequired: true, maStartPeriod: "2026-11" });
    expect((await tracking.runMaDeadlineMonitor()).periodsCreated).toBe(0);
  });

  it("one failing client does not stop the rest", async () => {
    const c2 = await ClientModel.create({ name: "Second Co", email: "b@b.co", company: "B", createdBy: ceo._id, assignedTo: [prim._id], allocatedAccountant: prim._id, isSalesLead: false } as any);
    fakeNow("2026-11-16T07:00:00");
    await tracking.runMaDeadlineMonitor();
    sendOverdue.mockRejectedValueOnce(new Error("smtp down"));
    fakeNow("2026-11-20T07:00:00");
    const m = await tracking.runMaDeadlineMonitor();
    expect(m.failures).toHaveLength(0); // email errors are contained
    expect(await MaPeriod.countDocuments({ clientId: { $in: [client._id, c2._id] } })).toBe(2);
  });
});

describe("deleting a started-but-not-submitted report", () => {
  const del2 = (id: string, token: string) => request(app).delete(`/api/reports/${id}`).set("Authorization", `Bearer ${token}`);

  it("removes the draft but the month stays owed and overdue", async () => {
    fakeNow("2026-11-20T09:00:00"); // after the 15th
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    await wf.saveDraft(A(prim), String(r._id), { summary: "Started by mistake, will redo." });
    expect((await wf.getReportDetail(A(prim), String(r._id))).can.delete).toBe(true);

    const res = await del2(String(r._id), tok.prim);
    expect(res.status).toBe(200);
    expect(await ReportSubmission.findById(r._id)).toBeNull();

    // The obligation is untouched: the period row is still there, now "not started", still overdue.
    const period = await MaPeriod.findOne({ clientId: client._id, periodKey: "2026-10" });
    expect(period).toBeTruthy();
    expect(period!.submissionId).toBeUndefined();
    const alerts = await tracking.listActiveAlerts({ accountantId: String(prim._id) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].workflowStatus).toBe("not_started");
    expect(await ReportAuditEvent.countDocuments({ action: "report_deleted" })).toBe(1);

    // …and it can be started again from scratch.
    const again = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    expect(again.status).toBe("draft");
  });

  it("the report list tells the screen which rows can be deleted", async () => {
    fakeNow("2026-11-10T09:00:00");
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    const row = () => wf.listReports(A(prim), { scope: "mine" }).then((x) => x.find((y) => y._id === String(r._id))!);
    expect((await row()).canDelete).toBe(true);
    await wf.saveDraft(A(prim), String(r._id), { summary: "October MAs prepared and checked." });
    await wf.submitForReview(A(prim), String(r._id));
    expect((await row()).canDelete).toBe(false);
  });

  it("cannot delete once submitted (history must stay) or after a return", async () => {
    const s = await submitDraft();
    await expect(wf.deleteDraftReport(A(prim), String(s._id))).rejects.toMatchObject({ statusCode: 409, code: "NOT_DELETABLE" });
    await wf.returnForCorrections(A(sup), String(s._id), "Please fix the bank rec.");
    await expect(wf.deleteDraftReport(A(prim), String(s._id))).rejects.toMatchObject({ statusCode: 409 });
    expect((await wf.getReportDetail(A(prim), String(s._id))).can.delete).toBe(false);
    expect(await ReportSubmission.findById(s._id)).toBeTruthy();
  });

  it("only the client's own accountants can delete it — not other accountants, the supervisor or the CEO", async () => {
    fakeNow("2026-11-10T09:00:00");
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    expect((await del2(String(r._id), tok.stranger)).status).toBe(403);
    expect((await del2(String(r._id), tok.sup)).status).toBe(403);
    expect((await del2(String(r._id), tok.ceo)).status).toBe(403);
    expect(await ReportSubmission.findById(r._id)).toBeTruthy();
    // The Secondary on the client can.
    expect((await del2(String(r._id), tok.sec)).status).toBe(200);
  });
});

describe("CEO and supervisor can delete drafts on clients they serve", () => {
  const del3 = (id: string, token: string) => request(app).delete(`/api/reports/${id}`).set("Authorization", `Bearer ${token}`);
  const mkClient = (name: string, assignedTo: any[], primary: any) =>
    ClientModel.create({ name, email: "c@c.co.ke", company: name, createdBy: ceo._id, assignedTo, allocatedAccountant: primary._id, isSalesLead: false } as any);

  it("the CEO deletes a draft on a client where the CEO is the Primary", async () => {
    const c = await mkClient("CEO Client", [ceo._id, sec._id], ceo);
    fakeNow("2026-11-12T09:00:00");
    const r = await wf.openMaReport(A(ceo), String(c._id), "2026-10");
    expect((await wf.getReportDetail(A(ceo), String(r._id))).can.delete).toBe(true);
    expect((await del3(String(r._id), tok.ceo)).status).toBe(200);
    expect(await ReportSubmission.findById(r._id)).toBeNull();
  });

  it("the supervisor deletes a draft on his own client (as Primary, and as Secondary)", async () => {
    const own = await mkClient("Emmanuel Client", [sup._id, sec._id], sup);
    const secOn = await mkClient("Sup Is Secondary", [prim._id, sup._id], prim);
    fakeNow("2026-11-12T09:00:00");
    const r1 = await wf.openMaReport(A(sup), String(own._id), "2026-10");
    const r2 = await wf.openMaReport(A(sup), String(secOn._id), "2026-10");
    expect((await del3(String(r1._id), tok.sup)).status).toBe(200);
    expect((await del3(String(r2._id), tok.sup)).status).toBe(200);
  });

  it("the CEO and supervisor cannot delete drafts on clients they do NOT serve", async () => {
    fakeNow("2026-11-12T09:00:00");
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    expect((await del3(String(r._id), tok.ceo)).status).toBe(403);
    expect((await del3(String(r._id), tok.sup)).status).toBe(403);
    expect(await ReportSubmission.findById(r._id)).toBeTruthy();
  });
});

describe("marking a month's MAs as not required (e.g. test data)", () => {
  const post = (path: string, token: string, body: object = {}) => request(app).post(path).set("Authorization", `Bearer ${token}`).send(body);
  const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
  const periodId = async () => String((await MaPeriod.findOne({ clientId: client._id, periodKey: "2026-10" }))!._id);
  const overdueSetup = async () => { fakeNow("2026-11-27T09:00:00"); await tracking.runMaDeadlineMonitor(); return periodId(); };

  it("the CEO takes an overdue month off the books: alert, worklist and performance clear; the record stays", async () => {
    const id = await overdueSetup();
    expect(await tracking.listActiveAlerts({ accountantId: String(prim._id) })).toHaveLength(1);

    const res = await post(`/api/reports/ma/period/${id}/exempt`, tok.ceo, { reason: "Test client — not a real MA" });
    expect(res.status).toBe(200);

    expect(await tracking.listActiveAlerts({ accountantId: String(prim._id) })).toHaveLength(0);
    expect(await tracking.listMyMaPeriods(String(prim._id))).toHaveLength(0);
    expect(await tracking.deliveryMonitor({ periodKey: "2026-10" })).toHaveLength(0);
    const perf = (await get("/api/reports/ma/performance?scope=self", tok.prim)).body.data.accountants[0];
    expect(perf.asPrimary.due).toBe(0);

    const period = await MaPeriod.findById(id);
    expect(period!.exempt).toBe(true);
    expect(period!.alertActive).toBe(false);
    expect(period!.alertHistory[0].clearReason).toBe("exempted"); // history kept
    const ev = await ReportAuditEvent.findOne({ action: "period_exempted" });
    expect(String(ev!.actorId)).toBe(String(ceo._id));
    expect((ev!.details as any).reason).toMatch(/Test client/);
    expect(await Notification.countDocuments({ type: "ma_period_exempted", userId: { $in: [prim._id, sec._id] } })).toBe(2);

    // The monitor no longer chases it; no one can start a report on it.
    sendOverdue.mockClear();
    fakeNow("2026-11-30T09:00:00");
    await tracking.runMaDeadlineMonitor();
    expect(sendOverdue).not.toHaveBeenCalled();
    await expect(wf.openMaReport(A(prim), String(client._id), "2026-10")).rejects.toMatchObject({ code: "PERIOD_EXEMPT" });
  });

  it("needs a reason; accountants cannot do it", async () => {
    const id = await overdueSetup();
    expect((await post(`/api/reports/ma/period/${id}/exempt`, tok.ceo, { reason: " " })).status).toBe(400);
    expect((await post(`/api/reports/ma/period/${id}/exempt`, tok.prim, { reason: "I want this gone" })).status).toBe(403);
    expect((await post(`/api/reports/ma/period/${id}/exempt`, tok.stranger, { reason: "I want this gone" })).status).toBe(403);
    expect((await MaPeriod.findById(id))!.exempt).toBeFalsy();
  });

  it("a supervisor can do it for others' MAs, but not for MAs he is responsible for", async () => {
    const id = await overdueSetup();
    expect((await post(`/api/reports/ma/period/${id}/exempt`, tok.sup, { reason: "Agreed with client" })).status).toBe(200);

    const own = await ClientModel.create({ name: "Emmanuel Own", email: "o@o.co.ke", company: "O", createdBy: ceo._id, assignedTo: [sup._id, sec._id], allocatedAccountant: sup._id, isSalesLead: false } as any);
    await tracking.runMaDeadlineMonitor();
    const ownId = String((await MaPeriod.findOne({ clientId: own._id }))!._id);
    expect((await post(`/api/reports/ma/period/${ownId}/exempt`, tok.sup, { reason: "Not my MAs to drop" })).status).toBe(403);
    expect((await post(`/api/reports/ma/period/${ownId}/exempt`, tok.ceo, { reason: "Test client" })).status).toBe(200); // the CEO can
  });

  it("cannot be used once a report exists (delete the draft first) or after it was sent", async () => {
    fakeNow("2026-11-27T09:00:00");
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    const id = await periodId();
    await expect(wf.exemptMaPeriod(A(ceo), id, "Test client")).rejects.toMatchObject({ statusCode: 409, code: "HAS_REPORT" });
    await wf.deleteDraftReport(A(prim), String(r._id));
    await expect(wf.exemptMaPeriod(A(ceo), id, "Test client")).resolves.toBeUndefined();
    await MaPeriod.updateOne({ _id: id }, { exempt: false, sentAt: new Date() });
    await expect(wf.exemptMaPeriod(A(ceo), id, "Test client")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("can be reinstated: it is overdue and on the worklist again, and the audit trail shows both steps", async () => {
    const id = await overdueSetup();
    await wf.exemptMaPeriod(A(ceo), id, "Test client");
    expect((await post(`/api/reports/ma/period/${id}/reinstate`, tok.prim)).status).toBe(403);
    expect((await post(`/api/reports/ma/period/${id}/reinstate`, tok.ceo)).status).toBe(200);
    const alerts = await tracking.listActiveAlerts({ accountantId: String(prim._id) });
    expect(alerts).toHaveLength(1);
    expect(await tracking.listMyMaPeriods(String(prim._id))).toHaveLength(1);
    const actions = (await ReportAuditEvent.find({ clientId: client._id }).sort({ at: 1 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["period_exempted", "period_reinstated"]));
  });

  it("the client's history still shows the month, flagged as not required", async () => {
    const id = await overdueSetup();
    await wf.exemptMaPeriod(A(ceo), id, "Test client");
    const t = await get(`/api/reports/ma/client/${client._id}`, tok.ceo);
    expect(t.body.data.history.find((h: any) => h.periodKey === "2026-10")).toMatchObject({ exempt: true });
  });
});

describe("accountant worklist", () => {
  it("lists this month's MAs for the accountant's own clients, creating rows on demand", async () => {
    fakeNow("2026-11-12T08:00:00");
    const mine = await tracking.listMyMaPeriods(String(sec._id));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ clientName: client.name, periodKey: "2026-10", workflowStatus: "not_started", deadlineStatus: "upcoming" });
    expect(await tracking.listMyMaPeriods(String(stranger._id))).toHaveLength(0);
    const http = await request(app).get("/api/reports/ma/mine").set("Authorization", `Bearer ${tok.prim}`);
    expect(http.status).toBe(200);
    expect(http.body.data).toHaveLength(1);
    const supList = await request(app).get("/api/reports/ma/mine").set("Authorization", `Bearer ${tok.sup}`);
    expect(supList.status).toBe(200); // supervisors serve clients too — empty when they serve none
    expect(supList.body.data).toHaveLength(0);
  });
});

describe("accountant performance", () => {
  it("separates late submission, supervisor review time and delivery; shows both accountants", async () => {
    fakeNow("2026-11-12T08:00:00");
    await tracking.runMaDeadlineMonitor();
    fakeNow("2026-11-17T12:00:00"); // submitted 1.5 days late
    const r = await wf.openMaReport(A(prim), String(client._id), "2026-10");
    await wf.saveDraft(A(prim), String(r._id), { summary: "October MAs complete and reconciled." });
    await wf.submitForReview(A(prim), String(r._id));
    fakeNow("2026-11-20T12:00:00"); // supervisor took 3 days
    await wf.approveReport(A(sup), String(r._id));
    fakeNow("2026-11-21T12:00:00"); // delivered 1 day after approval
    const a = await wf.attachFinalPdfs(A(sup), String(r._id), [await upload(sup, String(r._id), "r.pdf", PDF)]);
    await wf.sendReportToClient(A(sup), String(r._id), { confirmedAttachmentIds: [String(a.finalAttachments[0]._id)] });

    const perf = await computePerformance([String(prim._id), String(sec._id)]);
    const p = perf.accountants.find((x) => x.name === "Pat Primary")!;
    const s = perf.accountants.find((x) => x.name === "Sam Secondary")!;
    expect(p.assignedClients).toBe(1);
    expect(p.asPrimary).toMatchObject({ due: 1, submittedLate: 1, submittedOnTime: 0, approved: 1, sentLate: 1, sentOnTime: 0, submissionCompliancePct: 0 });
    expect(p.asPrimary.accountantDelayDays).toBeCloseTo(1.5, 0);
    expect(p.asPrimary.supervisorDelayDays).toBeCloseTo(3, 0);
    expect(p.asPrimary.deliveryDelayDays).toBeCloseTo(1, 0);
    expect(p.asPrimary.avgDaysLateToSubmit).toBeGreaterThan(1);
    // The secondary appears, supporting — not charged with the same delay twice.
    expect(s.asSecondary.due).toBe(1);
    expect(s.asPrimary.due).toBe(0);
    expect(s.asSecondary.accountantDelayDays).toBe(0);
    expect(s.asSecondary.sharedDelayDays).toBeCloseTo(1.5, 0);
  });

  const names = (res: any) => res.body.data.accountants.map((x: any) => x.name);
  const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

  it("an accountant only ever sees their own performance", async () => {
    const own = await get("/api/reports/ma/performance", tok.prim);
    expect(names(own)).toEqual(["Pat Primary"]);
    expect((await get(`/api/reports/ma/performance?accountantId=${sec._id}`, tok.prim)).status).toBe(403);
  });

  it("the supervisor's dashboard lists his team AND himself, with himself first", async () => {
    const res = await get("/api/reports/ma/performance", tok.sup);
    expect(names(res)).toEqual(["Emmanuel", "Other Acct", "Pat Primary", "Sam Secondary"]);
    expect(res.body.data.accountants[0]).toMatchObject({ isSelf: true, roleLabel: "Accountant Supervisor" });
  });

  it("the CEO's oversight lists every accountant, the accounting supervisors and the CEO", async () => {
    const res = await get("/api/reports/ma/performance", tok.ceo);
    expect(names(res).sort()).toEqual(["Chief Exec", "Emmanuel", "Other Acct", "Pat Primary", "Sam Secondary"]);
    const labels = Object.fromEntries(res.body.data.accountants.map((x: any) => [x.name, x.roleLabel]));
    expect(labels["Chief Exec"]).toBe("CEO");
    expect(labels["Emmanuel"]).toBe("Accountant Supervisor");
  });

  it("in the accountant workspace (scope=self) the CEO and supervisor see ONLY themselves", async () => {
    expect(names(await get("/api/reports/ma/performance?scope=self", tok.ceo))).toEqual(["Chief Exec"]);
    expect(names(await get("/api/reports/ma/performance?scope=self", tok.sup))).toEqual(["Emmanuel"]);
    expect((await get(`/api/reports/ma/performance?scope=self&accountantId=${prim._id}`, tok.sup)).status).toBe(403);
  });
});

describe("CEO and accountant supervisors serve clients as accountants too", () => {
  let c2: any;
  beforeEach(async () => {
    // CEO is the allocated (primary) accountant; the supervisor is the secondary.
    c2 = await ClientModel.create({
      name: "CEO Served Ltd", email: "x@ceoserved.co.ke", company: "CEO Served",
      createdBy: ceo._id, assignedTo: [ceo._id, sup._id], allocatedAccountant: ceo._id, isSalesLead: false,
    } as any);
  });
  const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

  it("they can pick those clients and see them in their worklist", async () => {
    const ceoClients = await get("/api/reports/my-clients", tok.ceo);
    expect(ceoClients.status).toBe(200);
    expect(ceoClients.body.data.map((c: any) => c.name)).toEqual(["CEO Served Ltd"]);
    const supClients = await get("/api/reports/my-clients", tok.sup);
    expect(supClients.body.data.map((c: any) => c.name)).toEqual(["CEO Served Ltd"]);

    fakeNow("2026-11-12T08:00:00");
    const ceoWork = await get("/api/reports/ma/mine", tok.ceo);
    expect(ceoWork.body.data.map((m: any) => m.clientName)).toEqual(["CEO Served Ltd"]);
    expect(ceoWork.body.data[0].primary.name).toBe("Chief Exec");
  });

  it("the CEO can prepare and submit; the supervisor on the same client reviews it", async () => {
    fakeNow("2026-11-10T09:00:00");
    const r = await wf.openMaReport(A(ceo), String(c2._id), "2026-10");
    await wf.saveDraft(A(ceo), String(r._id), { summary: "CEO prepared these October MAs." });
    const detail = await wf.getReportDetail(A(ceo), String(r._id));
    expect(detail.can).toMatchObject({ edit: true, submit: true, review: false });
    await wf.submitForReview(A(ceo), String(r._id));
    expect((await wf.approveReport(A(sup), String(r._id))).status).toBe("approved");
  });

  it("scope=mine lists only my own reports, not everything I could oversee", async () => {
    fakeNow("2026-11-10T09:00:00");
    const mine = await wf.openMaReport(A(ceo), String(c2._id), "2026-10");
    await wf.openMaReport(A(prim), String(client._id), "2026-10");
    const all = await wf.listReports(A(ceo));
    const own = await wf.listReports(A(ceo), { scope: "mine" });
    expect(all).toHaveLength(2);
    expect(own.map((x) => x._id)).toEqual([String(mine._id)]);
  });

  it("their clients count in their performance and the CEO's own row is in the team view", async () => {
    const res = await get("/api/reports/ma/performance?scope=self", tok.ceo);
    expect(res.body.data.accountants[0]).toMatchObject({ name: "Chief Exec", assignedClients: 1, clientsRequiringMa: 1 });
  });
});