import {
  scrub,
  normalizePath,
  normalizeMessage,
  topAppFrame,
  fingerprintOf,
  isClientFaultError,
  sniffImage,
  parseEmailList,
} from "../utils/errorScrub";

// Fake credentials for testing the scrubber. They are ASSEMBLED AT RUNTIME on
// purpose: a literal secret-shaped string in the source (even a made-up one)
// trips GitHub secret scanning. `.invalid` is a reserved TLD that never resolves.
const FAKE_DB_PASSWORD = ["fake", "password", "123"].join("");
const FAKE_DB_URI = ["mongodb", "+srv://", "fakeuser", ":", FAKE_DB_PASSWORD, "@", "cluster.example.invalid", "/db"].join("");
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = [b64({ alg: "HS256" }), b64({ userId: "12345678" }), "z".repeat(24)].join(".");
const FAKE_BEARER = ["Bearer", ["fake", "token", "abc"].join("-")].join(" ");

describe("scrub", () => {
  it("redacts bearer tokens, JWTs and DB credentials", () => {
    const out = scrub(
      `Authorization: ${FAKE_BEARER} and ${FAKE_JWT} at ${FAKE_DB_URI}`,
    );
    expect(out).not.toContain("fake-token-abc");
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain(FAKE_DB_PASSWORD);
    expect(out).toContain("mongodb+srv://[redacted]@cluster.example.invalid/db");
  });

  it("redacts secrets in query strings and key/value pairs", () => {
    const out = scrub('GET /x?token=NOTREAL123&ok=1 {"password":"notreal-pw"} apiKey=notreal-key');
    expect(out).not.toMatch(/NOTREAL123|notreal-pw|notreal-key/);
    expect(out).toContain("ok=1");
  });

  it("caps length and tolerates undefined", () => {
    expect(scrub(undefined)).toBe("");
    expect(scrub("x".repeat(50), 10)).toHaveLength(11); // 10 + ellipsis
  });
});

describe("normalizePath", () => {
  it("replaces ids and opaque tokens, and drops the query string", () => {
    expect(
      normalizePath("/api/tasks/65f1a2b3c4d5e6f7a8b9c0d1/return?token=zzz"),
    ).toBe("/api/tasks/:id/return");
    expect(normalizePath("/api/clients/42/notes")).toBe("/api/clients/:id/notes");
    expect(normalizePath("/api/share/Xk3jQ9vLm2PzR8tWn4YbHc7d")).toBe(
      "/api/share/:id",
    );
    expect(normalizePath("/api/tasks/me")).toBe("/api/tasks/me");
  });
});

describe("fingerprinting", () => {
  it("is stable across ids / numbers in the message", () => {
    const a = normalizeMessage("Cast to ObjectId failed for 65f1a2b3c4d5e6f7a8b9c0d1 (row 12)");
    const b = normalizeMessage("Cast to ObjectId failed for 65f1a2b3c4d5e6f7a8b9c0d2 (row 99)");
    expect(a).toBe(b);
    expect(fingerprintOf(["server", "GET", "/api/x", a])).toBe(
      fingerprintOf(["server", "GET", "/api/x", b]),
    );
  });

  it("differs when the route differs", () => {
    expect(fingerprintOf(["a", "/one"])).not.toBe(fingerprintOf(["a", "/two"]));
  });

  it("topAppFrame skips node_modules and strips line numbers and deploy paths", () => {
    const stack = [
      "Error: boom",
      "    at Query.exec (/var/task/node_modules/mongoose/lib/query.js:10:5)",
      "    at getThing (/var/task/src/controllers/thingController.ts:88:13)",
    ].join("\n");
    expect(topAppFrame(stack)).toBe("/src/controllers/thingController.ts");
  });
});

describe("isClientFaultError", () => {
  it("treats caller mistakes as not worth alerting", () => {
    expect(isClientFaultError({ name: "MulterError" })).toBe(true);
    expect(isClientFaultError({ name: "CastError" })).toBe(true);
    expect(isClientFaultError({ name: "ValidationError" })).toBe(true);
    expect(isClientFaultError({ code: 11000 })).toBe(true);
    expect(isClientFaultError({ statusCode: 404 })).toBe(true);
    expect(isClientFaultError({ type: "entity.too.large" })).toBe(true);
  });
  it("treats genuine faults as alert-worthy", () => {
    expect(isClientFaultError(new Error("db exploded"))).toBe(false);
    expect(isClientFaultError({ name: "MongoServerError", code: 50 })).toBe(false);
    expect(isClientFaultError(undefined)).toBe(false);
  });
});

describe("sniffImage", () => {
  const pad = (b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);
  it("recognises real image signatures", () => {
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe("png");
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffImage(Buffer.from("GIF89a" + "\0".repeat(10)))?.ext).toBe("gif");
    expect(
      sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]))?.ext,
    ).toBe("webp");
  });
  it("rejects HTML/SVG/text pretending to be an image", () => {
    expect(sniffImage(Buffer.from("<svg onload=alert(1)></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("<html><script>1</script></html>"))).toBeNull();
    expect(sniffImage(Buffer.alloc(4))).toBeNull();
  });
});

describe("parseEmailList", () => {
  it("splits, lowercases, de-duplicates and drops junk", () => {
    expect(parseEmailList("A@x.com, b@x.com;a@x.com  nope, c@y.org")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@y.org",
    ]);
    expect(parseEmailList(undefined)).toEqual([]);
  });
});