import "./testEnv";
import { ensureStoredFile } from "../utils/missingFile";
import * as storage from "../services/s3Storage";

jest.mock("../services/s3Storage", () => ({
  ...jest.requireActual("../services/s3Storage"),
  headObject: jest.fn(),
}));
const head = storage.headObject as jest.Mock;

/** Minimal Express req/res doubles that record what was sent. */
const makeRes = () => {
  const out: { status?: number; body?: unknown; type?: string; headers: Record<string, string> } = {
    headers: {},
  };
  const res: any = {
    setHeader: (k: string, v: string) => ((out.headers[k] = v), res),
    status: (c: number) => ((out.status = c), res),
    json: (b: unknown) => ((out.body = b), res),
    type: (t: string) => ((out.type = t), res),
    send: (b: unknown) => ((out.body = b), res),
  };
  return { res, out };
};
const makeReq = (accepts: "html" | "json") => ({ accepts: () => accepts }) as any;

beforeEach(() => {
  head.mockReset();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("ensureStoredFile", () => {
  it("lets the request carry on when the object exists", async () => {
    head.mockResolvedValue({ size: 1 });
    const { res, out } = makeRes();
    expect(await ensureStoredFile(makeReq("html"), res, "a.pdf")).toBe(true);
    expect(out.status).toBeUndefined();
  });

  it("answers a browser with a friendly page that reveals nothing about storage", async () => {
    head.mockResolvedValue(null);
    const { res, out } = makeRes();
    expect(await ensureStoredFile(makeReq("html"), res, "secret-key.pdf")).toBe(false);
    expect(out.status).toBe(404);
    expect(out.type).toBe("html");
    expect(String(out.body)).toMatch(/isn’t available/);
    expect(String(out.body)).not.toMatch(/arn:|AccessDenied|amazonaws|secret-key/);
    expect(out.headers["Cache-Control"]).toBe("no-store");
  });

  it("answers an API client with JSON", async () => {
    head.mockResolvedValue(null);
    const { res, out } = makeRes();
    expect(await ensureStoredFile(makeReq("json"), res, "a.pdf")).toBe(false);
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({ success: false, code: "FILE_MISSING" });
  });

  it("carries on when S3 can't say (e.g. 403 without s3:ListBucket)", async () => {
    head.mockRejectedValue(new Error("Forbidden"));
    const { res, out } = makeRes();
    expect(await ensureStoredFile(makeReq("html"), res, "a.pdf")).toBe(true);
    expect(out.status).toBeUndefined();
  });
});