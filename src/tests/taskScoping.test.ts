import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { TaskModel } from "../models/Task";
import { DocumentModel } from "../models/Document";
import { SupervisorMapping } from "../models/SupervisorMapping";

beforeAll(async () => {
  await startTestDb();
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await TaskModel.deleteMany({});
  await DocumentModel.deleteMany({});
  await SupervisorMapping.deleteMany({});
});

const mkTask = (title: string, assignedBy: unknown, assignedTo: unknown) =>
  TaskModel.create({ title, assignedBy, assignedTo, status: "pending" });

const list = (token: string) =>
  request(app).get("/api/tasks").set("Authorization", `Bearer ${token}`);

const titles = (res: request.Response): string[] =>
  (res.body.data.tasks as { title: string }[]).map((t) => t.title).sort();

describe("task visibility", () => {
  it.each(["sales_person", "tech", "accountant"] as const)(
    "%s sees only the tasks assigned to them",
    async (role) => {
      const { user: ceo } = await createUserWithToken("ceo");
      const me = await createUserWithToken(role);
      const other = await createUserWithToken("accountant");
      await mkTask("mine", ceo._id, me.user._id);
      await mkTask("someone else's", ceo._id, other.user._id);

      const res = await list(me.token);

      expect(res.status).toBe(200);
      expect(titles(res)).toEqual(["mine"]);
    },
  );

  it("tech also sees tasks they assigned to others", async () => {
    const me = await createUserWithToken("tech");
    const other = await createUserWithToken("accountant");
    const { user: ceo } = await createUserWithToken("ceo");
    await mkTask("i assigned this", me.user._id, other.user._id);
    await mkTask("unrelated", ceo._id, other.user._id);

    expect(titles(await list(me.token))).toEqual(["i assigned this"]);
  });

  it("the CEO still sees every task", async () => {
    const ceo = await createUserWithToken("ceo");
    const a = await createUserWithToken("sales_person");
    const b = await createUserWithToken("tech");
    await mkTask("one", ceo.user._id, a.user._id);
    await mkTask("two", ceo.user._id, b.user._id);

    expect(titles(await list(ceo.token))).toEqual(["one", "two"]);
  });

  it.each(["sales_person", "tech"] as const)(
    "%s cannot open a task by id that isn't theirs",
    async (role) => {
      const { user: ceo } = await createUserWithToken("ceo");
      const me = await createUserWithToken(role);
      const other = await createUserWithToken("accountant");
      const t = await mkTask("not mine", ceo._id, other.user._id);

      const res = await request(app)
        .get(`/api/tasks/${t._id}`)
        .set("Authorization", `Bearer ${me.token}`);

      expect(res.status).toBe(403);
    },
  );

  it("tech cannot cancel a task they neither created nor were assigned", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const me = await createUserWithToken("tech");
    const other = await createUserWithToken("accountant");
    const t = await mkTask("not mine", ceo._id, other.user._id);

    const res = await request(app)
      .patch(`/api/tasks/${t._id}/status`)
      .set("Authorization", `Bearer ${me.token}`)
      .send({ status: "cancelled" });

    expect([403, 404]).toContain(res.status);
    expect((await TaskModel.findById(t._id))!.status).toBe("pending");
  });
});

describe("supervisor approval is limited to their own team", () => {
  const approve = (token: string, id: unknown) =>
    request(app)
      .patch(`/api/tasks/${id}/approve`)
      .set("Authorization", `Bearer ${token}`);

  const submitted = (assignedBy: unknown, assignedTo: unknown) =>
    TaskModel.create({
      title: "done",
      assignedBy,
      assignedTo,
      status: "submitted",
    });

  it("refuses a supervisor who is not the assigner and whose team doesn't include the assignee", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const sup = await createUserWithToken("supervisor");
    const stranger = await createUserWithToken("accountant");
    const t = await submitted(ceo._id, stranger.user._id);

    const res = await approve(sup.token, t._id);

    expect(res.status).toBe(403);
    expect((await TaskModel.findById(t._id))!.status).toBe("submitted");
  });

  it("does not refuse a supervisor for a task assigned to their own team member", async () => {
    const { user: ceo } = await createUserWithToken("ceo");
    const sup = await createUserWithToken("supervisor");
    const member = await createUserWithToken("accountant");
    await SupervisorMapping.create({
      supervisorId: sup.user._id,
      subordinateId: member.user._id,
      departmentName: "Test",
      assignedBy: ceo._id,
      status: "active",
    });
    const t = await submitted(ceo._id, member.user._id);

    const res = await approve(sup.token, t._id);

    expect(res.status).not.toBe(403);
  });

  it("lets the CEO approve any submitted task", async () => {
    const ceo = await createUserWithToken("ceo");
    const member = await createUserWithToken("accountant");
    const t = await submitted(ceo.user._id, member.user._id);

    expect((await approve(ceo.token, t._id)).status).not.toBe(403);
  });
});

describe("dashboard counts are scoped to the caller", () => {
  const mkDoc = (ownerId: unknown, title: string) =>
    DocumentModel.create({
      title,
      fileType: "pdf",
      fileName: `${title}.pdf`,
      fileKey: `k/${title}`,
      fileUrl: `https://example.test/${title}`,
      fileSize: 1,
      modifiedBy: ownerId,
      ownerId,
    });

  it.each(["sales_person", "tech"] as const)(
    "%s counts only their own documents and tasks",
    async (role) => {
      const { user: ceo } = await createUserWithToken("ceo");
      const me = await createUserWithToken(role);
      const other = await createUserWithToken("accountant");
      await mkDoc(me.user._id, "mine");
      await mkDoc(other.user._id, "theirs-1");
      await mkDoc(other.user._id, "theirs-2");
      await mkTask("my task", ceo._id, me.user._id);
      await mkTask("their task", ceo._id, other.user._id);

      const res = await request(app)
        .get("/api/analytics/dashboard")
        .set("Authorization", `Bearer ${me.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.stats.totalDocs).toBe(1);
      expect(res.body.data.stats.totalTasks).toBe(1);
    },
  );
});
