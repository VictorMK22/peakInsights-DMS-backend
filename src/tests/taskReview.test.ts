import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { TaskModel } from "../models/Task";

beforeAll(async () => {
  await startTestDb();
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await TaskModel.deleteMany({});
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const setup = async () => {
  const { user: ceo } = await createUserWithToken("ceo");
  const assignee = await createUserWithToken("accountant");
  const outsider = await createUserWithToken("tech");
  const task = await TaskModel.create({
    title: "Reconcile Q3",
    assignedBy: ceo._id,
    assignedTo: assignee.user._id,
    status: "pending",
  });
  return { assignee, outsider, task };
};

describe("task review before target time", () => {
  it("refuses to start a task that hasn't been reviewed", async () => {
    const { assignee, task } = await setup();
    const res = await request(app)
      .patch(`/api/tasks/${task._id}/status`)
      .set(auth(assignee.token))
      .send({ status: "in_progress", targetMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/review the task first/i);
    const fresh = await TaskModel.findById(task._id);
    expect(fresh?.status).toBe("pending");
    expect(fresh?.targetMinutes).toBeUndefined();
  });

  it("refuses to set a target on a pending, unreviewed task via PUT", async () => {
    const { assignee, task } = await setup();
    const res = await request(app)
      .put(`/api/tasks/${task._id}`)
      .set(auth(assignee.token))
      .send({ targetMinutes: 30 });
    expect(res.status).toBe(400);
    expect((await TaskModel.findById(task._id))?.targetMinutes).toBeUndefined();
  });

  it("lets the assignee review, then set a target and start", async () => {
    const { assignee, task } = await setup();

    const review = await request(app)
      .patch(`/api/tasks/${task._id}/review`)
      .set(auth(assignee.token));
    expect(review.status).toBe(200);
    const reviewed = await TaskModel.findById(task._id);
    expect(reviewed?.assigneeReviewedAt).toBeDefined();
    expect(String(reviewed?.assigneeReviewedBy)).toBe(String(assignee.user._id));
    expect(reviewed?.status).toBe("pending");

    const start = await request(app)
      .patch(`/api/tasks/${task._id}/status`)
      .set(auth(assignee.token))
      .send({ status: "in_progress", targetMinutes: 90 });
    expect(start.status).toBe(200);
    const started = await TaskModel.findById(task._id);
    expect(started?.status).toBe("in_progress");
    expect(started?.targetMinutes).toBe(90);
  });

  it("is idempotent and keeps the first review timestamp", async () => {
    const { assignee, task } = await setup();
    await request(app).patch(`/api/tasks/${task._id}/review`).set(auth(assignee.token));
    const first = (await TaskModel.findById(task._id))!.assigneeReviewedAt!.getTime();
    const again = await request(app)
      .patch(`/api/tasks/${task._id}/review`)
      .set(auth(assignee.token));
    expect(again.status).toBe(200);
    expect((await TaskModel.findById(task._id))!.assigneeReviewedAt!.getTime()).toBe(first);
  });

  it("only the assignee (or CEO / collaborator) can review; only pending tasks", async () => {
    const { assignee, outsider, task } = await setup();
    const denied = await request(app)
      .patch(`/api/tasks/${task._id}/review`)
      .set(auth(outsider.token));
    expect([403, 404]).toContain(denied.status);

    await TaskModel.updateOne({ _id: task._id }, { status: "in_progress" });
    const started = await request(app)
      .patch(`/api/tasks/${task._id}/review`)
      .set(auth(assignee.token));
    expect(started.status).toBe(400);
  });
});