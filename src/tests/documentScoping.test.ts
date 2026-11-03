import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { DocumentModel } from "../models/Document";
import { SupervisorMapping } from "../models/SupervisorMapping";

beforeAll(async () => {
  await startTestDb();
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await DocumentModel.deleteMany({});
  await SupervisorMapping.deleteMany({});
});

const mkDoc = (
  ownerId: unknown,
  title: string,
  documentType: "working" | "storage" | "learning" = "working",
) =>
  DocumentModel.create({
    title,
    documentType,
    fileType: "pdf",
    fileName: `${title}.pdf`,
    fileKey: `k/${title}`,
    fileUrl: `https://example.test/${title}`,
    fileSize: 1,
    modifiedBy: ownerId,
    ownerId,
  });

const list = (token: string) =>
  request(app).get("/api/documents").set("Authorization", `Bearer ${token}`);

const titles = (res: request.Response): string[] =>
  (res.body.data.documents as { title: string }[]).map((d) => d.title).sort();

describe("document visibility", () => {
  it.each(["sales_person", "tech", "accountant"] as const)(
    "%s sees their own documents and learning material, nothing else",
    async (role) => {
      const me = await createUserWithToken(role);
      const other = await createUserWithToken("accountant");
      await mkDoc(me.user._id, "mine");
      await mkDoc(other.user._id, "theirs");
      await mkDoc(other.user._id, "training", "learning");

      const res = await list(me.token);

      expect(res.status).toBe(200);
      expect(titles(res)).toEqual(["mine", "training"]);
    },
  );

  it("the CEO still sees every document", async () => {
    const ceo = await createUserWithToken("ceo");
    const a = await createUserWithToken("sales_person");
    const b = await createUserWithToken("tech");
    await mkDoc(a.user._id, "one");
    await mkDoc(b.user._id, "two");

    expect(titles(await list(ceo.token))).toEqual(["one", "two"]);
  });

  it("a supervisor sees own + team documents, not another team's", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const sup = await createUserWithToken("supervisor");
    const member = await createUserWithToken("accountant");
    const outsider = await createUserWithToken("accountant");
    await SupervisorMapping.create({
      supervisorId: sup.user._id,
      subordinateId: member.user._id,
      departmentName: "Test",
      assignedBy: ceo._id,
      status: "active",
    });
    await mkDoc(sup.user._id, "supervisor's own");
    await mkDoc(member.user._id, "team member's");
    await mkDoc(outsider.user._id, "other team's");

    expect(titles(await list(sup.token))).toEqual([
      "supervisor's own",
      "team member's",
    ]);
  });

  it.each(["sales_person", "tech"] as const)(
    "%s cannot open someone else's document by id",
    async (role) => {
      const me = await createUserWithToken(role);
      const other = await createUserWithToken("accountant");
      const d = await mkDoc(other.user._id, "theirs");

      const res = await request(app)
        .get(`/api/documents/${d._id}`)
        .set("Authorization", `Bearer ${me.token}`);

      expect(res.status).toBe(403);
    },
  );

  it("tech cannot delete someone else's document", async () => {
    const me = await createUserWithToken("tech");
    const other = await createUserWithToken("accountant");
    const d = await mkDoc(other.user._id, "theirs");

    const res = await request(app)
      .delete(`/api/documents/${d._id}`)
      .set("Authorization", `Bearer ${me.token}`);

    expect(res.status).toBe(403);
    expect((await DocumentModel.findById(d._id))!.isDeleted).not.toBe(true);
  });

  it("type counts follow the same rule as the list", async () => {
    const me = await createUserWithToken("sales_person");
    const other = await createUserWithToken("accountant");
    await mkDoc(me.user._id, "mine");
    await mkDoc(other.user._id, "theirs");

    const res = await request(app)
      .get("/api/documents/type-counts")
      .set("Authorization", `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.counts.working.documents).toBe(1);
  });
});
