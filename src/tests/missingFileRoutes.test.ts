import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { DocumentModel } from "../models/Document";
import { AuditLog } from "../models/AuditLog";
import { ShareLink } from "../models/ShareLink";
import * as storage from "../services/s3Storage";

jest.mock("../services/s3Storage", () => ({
  ...jest.requireActual("../services/s3Storage"),
  headObject: jest.fn(),
  getSignedFileUrl: jest.fn(),
}));
const head = storage.headObject as jest.Mock;
const sign = storage.getSignedFileUrl as jest.Mock;

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
beforeEach(() => {
  head.mockReset();
  sign.mockReset();
  sign.mockResolvedValue("https://bucket.s3.amazonaws.com/signed?x=1");
});
afterEach(async () => {
  await DocumentModel.deleteMany({});
  await AuditLog.deleteMany({});
  await ShareLink.deleteMany({});
});

const setup = async () => {
  const { user, token } = await createUserWithToken("ceo");
  const doc = await DocumentModel.create({
    title: "Report",
    documentType: "working",
    fileType: "application/pdf",
    fileName: "Report.pdf",
    fileKey: "k/report.pdf",
    fileUrl: "https://example.test/report",
    fileSize: 1,
    modifiedBy: user._id,
    ownerId: user._id,
  });
  const link = await ShareLink.create({
    documentId: doc._id,
    token: "share-token-123",
    createdBy: user._id,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { token, doc, link };
};

describe("download route", () => {
  it("redirects and logs the download when the file exists", async () => {
    const { token, doc } = await setup();
    head.mockResolvedValue({ size: 1 });
    const res = await request(app)
      .get(`/api/documents/${doc._id}/download`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(302);
    expect(await AuditLog.countDocuments({ documentId: doc._id, action: "downloaded" })).toBe(1);
  });

  it("returns a clear 404 and logs NO download when the file is missing", async () => {
    const { token, doc } = await setup();
    head.mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/documents/${doc._id}/download`)
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "FILE_MISSING" });
    expect(await AuditLog.countDocuments({ documentId: doc._id, action: "downloaded" })).toBe(0);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("share link route", () => {
  it("redirects and counts the visit when the file exists", async () => {
    const { link } = await setup();
    head.mockResolvedValue({ size: 1 });
    const res = await request(app).get(`/api/share/${link.token}`);
    expect(res.status).toBe(302);
    expect((await ShareLink.findById(link._id))!.accessCount).toBe(1);
  });

  it("shows the friendly page and does NOT count a visit when the file is missing", async () => {
    const { link } = await setup();
    head.mockResolvedValue(null);
    const res = await request(app).get(`/api/share/${link.token}`).set("Accept", "text/html");
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/isn’t available/);
    expect(res.text).not.toMatch(/arn:|AccessDenied|amazonaws/);
    expect((await ShareLink.findById(link._id))!.accessCount).toBe(0);
  });
});