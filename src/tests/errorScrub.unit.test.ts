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

describe("scrub", () => {
  it("redacts bearer tokens, JWTs and DB credentials", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxMjM0NTY3OCJ9.abcdefghijk12345";
    const out = scrub(
      `Authorization: Bearer abc.def-123 and ${jwt} at mongodb+srv://admin:p4ss@cluster0.mongodb.net/db`,
    );
    expect(out).not.toContain("abc.def-123");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("p4ss");
    expect(out).toContain("mongodb+srv://[redacted]@cluster0.mongodb.net/db");
  });

  it("redacts secrets in query strings and key/value pairs", () => {
    const out = scrub('GET /x?token=SECRET123&ok=1 {"password":"hunter2"} apiKey=abc');
    expect(out).not.toMatch(/SECRET123|hunter2|apiKey=abc/);
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