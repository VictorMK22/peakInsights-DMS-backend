import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { DocumentModel } from "../models/Document";
import * as storage from "../services/s3Storage";

jest.mock("../services/s3Storage", () => ({
  ...jest.requireActual("../services/s3Storage"),
  uploadBufferToS3: jest.fn(),
  deleteFromS3: jest.fn(),
}));
const upload = storage.uploadBufferToS3 as jest.Mock;
const del = storage.deleteFromS3 as jest.Mock;

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
beforeEach(() => {
  upload.mockReset().mockResolvedValue("new-key.txt");
  del.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await DocumentModel.deleteMany({});
});

const setup = async () => {
  const { user, token } = await createUserWithToken("ceo");
  const doc = await DocumentModel.create({
    title: "Report",
    documentType: "working",
    fileType: "text/plain",
    fileName: "old.txt",
    fileKey: "old-key.txt",
    fileUrl: "https://example.test/old",
    fileSize: 3,
    modifiedBy: user._id,
    ownerId: user._id,
  });
  return { token, doc };
};

const replace = (token: string, id: unknown) =>
  request(app)
    .post(`/api/documents/${id}/replace`)
    .set("Authorization", `Bearer ${token}`)
    .attach("file", Buffer.from("new contents"), "new.txt");

describe("replacing a document's file", () => {
  it("points the record at the new file, then deletes only the old one", async () => {
    const { token, doc } = await setup();
    const res = await replace(token, doc._id);
    expect(res.status).toBe(200);

    const saved = await DocumentModel.findById(doc._id).lean();
    expect(saved!.fileKey).toBe("new-key.txt");
    expect(saved!.fileName).toBe("new.txt");
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("old-key.txt");
  });

  it("keeps the OLD file when saving fails, and cleans up the new upload", async () => {
    const { token, doc } = await setup();
    jest.spyOn(DocumentModel.prototype, "save").mockRejectedValueOnce(new Error("db down"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await replace(token, doc._id);
    expect(res.status).toBeGreaterThanOrEqual(500);

    const saved = await DocumentModel.findById(doc._id).lean();
    expect(saved!.fileKey).toBe("old-key.txt"); // record untouched
    expect(del).not.toHaveBeenCalledWith("old-key.txt"); // old file NOT deleted
    expect(del).toHaveBeenCalledWith("new-key.txt"); // orphaned upload removed
  });
});