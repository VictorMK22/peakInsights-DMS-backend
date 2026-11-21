import "./testEnv";
import request from "supertest";
import app from "../app";
import { buildSignedFileUrl } from "../utils/fileAccessToken";
import * as storage from "../services/s3Storage";

jest.mock("../services/s3Storage", () => ({
  ...jest.requireActual("../services/s3Storage"),
  headObject: jest.fn(),
  getSignedFileUrl: jest.fn(),
}));

const head = storage.headObject as jest.Mock;
const sign = storage.getSignedFileUrl as jest.Mock;

/** Path + query of a freshly signed link, so supertest can call it. */
const signedPath = (key: string) => {
  const u = new URL(buildSignedFileUrl(key));
  return u.pathname + u.search;
};

beforeEach(() => {
  head.mockReset();
  sign.mockReset();
  sign.mockResolvedValue("https://bucket.s3.amazonaws.com/signed?x=1");
});

describe("GET /api/files/:fileKey", () => {
  it("redirects to a presigned URL when the object exists", async () => {
    head.mockResolvedValue({ size: 10 });
    const res = await request(app).get(signedPath("abc.xlsx"));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://bucket.s3.amazonaws.com/signed?x=1");
  });

  it("shows a friendly page — no storage details — when the object is missing", async () => {
    head.mockResolvedValue(null);
    const res = await request(app).get(signedPath("gone.xlsx")).set("Accept", "text/html");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/isn’t available/);
    expect(res.text).not.toMatch(/arn:|AccessDenied|amazonaws|gone\.xlsx/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("answers API clients (Accept: json) with a JSON error", async () => {
    head.mockResolvedValue(null);
    const res = await request(app).get(signedPath("gone.xlsx")).set("Accept", "application/json");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "FILE_MISSING" });
  });

  it("still redirects when the existence check is inconclusive (e.g. 403 from S3)", async () => {
    head.mockRejectedValue(Object.assign(new Error("Forbidden"), { name: "Forbidden" }));
    const res = await request(app).get(signedPath("abc.xlsx"));
    expect(res.status).toBe(302);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("checks the token before touching storage", async () => {
    const res = await request(app).get("/api/files/abc.xlsx?token=bad&exp=9999999999");
    expect(res.status).toBe(403);
    expect(head).not.toHaveBeenCalled();
  });
});