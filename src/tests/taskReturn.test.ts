import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { TaskModel } from "../models/Task";
import Notification from "../models/Notification";
import { SupervisorMapping } from "../models/SupervisorMapping";

beforeAll(async () => {
  await startTestDb();
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await TaskModel.deleteMany({});
  await Notification.deleteMany({});
  await SupervisorMapping.deleteMany({});
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const setup = async (status: "submitted" | "in_progress" = "submitted") => {
  const ceo = await createUserWithToken("ceo");
  const assignee = await createUserWithToken("accountant");
  const otherTech = await createUserWithToken("tech");
  const task = await TaskModel.create({
    title: "Reconcile Q3",
    assignedBy: ceo.user._id,
    assignedTo: assignee.user._id,
    status,
    assigneeReviewedAt: new Date(),
    targetMinutes: 60,
    startedAt: new Date(Date.now() - 30 * 60_000),
  });
  return { ceo, assignee, otherTech, task };
};

describe("returning a submitted task with comments", () => {
  it("sends the task back to in_progress and records the comments", async () => {
    const { ceo, assignee, task } = await setup();

    const res = await request(app)
      .patch(`/api/tasks/${task._id}/return`)
      .set(auth(ceo.token))
      .send({ comments: "  Totals don't reconcile with the bank statement.  " });

    expect(res.status).toBe(200);
    const fresh = await TaskModel.findById(task._id);
    expect(fresh?.status).toBe("in_progress");
    expect(fresh?.completedAt).toBeUndefined();
    expect(fresh?.approvalHistory).toHaveLength(1);
    expect(fresh?.approvalHistory[0].action).toBe("returned");
    expect(fresh?.approvalHistory[0].reason).toBe(
      "Totals don't reconcile with the bank statement.",
    );
    expect(String(fresh?.approvalHistory[0].by)).toBe(String(ceo.user._id));

    const note = await Notification.findOne({
      userId: assignee.user._id,
      type: "task_returned",
    });
    expect(note?.message).toMatch(/returned for rework/i);
  });

  it("requires comments", async () => {
    const { ceo, task } = await setup();
    for (const body of [{}, { comments: "" }, { comments: "   " }]) {
      const res = await request(app)
        .patch(`/api/tasks/${task._id}/return`)
        .set(auth(ceo.token))
        .send(body);
      expect(res.status).toBe(400);
    }
    expect((await TaskModel.findById(task._id))?.status).toBe("submitted");
  });

  it("only works on submitted tasks", async () => {
    const { ceo, task } = await setup("in_progress");
    const res = await request(app)
      .patch(`/api/tasks/${task._id}/return`)
      .set(auth(ceo.token))
      .send({ comments: "Not ready" });
    expect(res.status).toBe(400);
    expect((await TaskModel.findById(task._id))?.approvalHistory).toHaveLength(0);
  });

  it("is refused for the assignee and for approvers outside the task", async () => {
    const { assignee, otherTech, task } = await setup();

    const byAssignee = await request(app)
      .patch(`/api/tasks/${task._id}/return`)
      .set(auth(assignee.token))
      .send({ comments: "returning my own task" });
    expect(byAssignee.status).toBe(403);

    // a tech user may only act on tasks they assigned
    const byTech = await request(app)
      .patch(`/api/tasks/${task._id}/return`)
      .set(auth(otherTech.token))
      .send({ comments: "not mine" });
    expect(byTech.status).toBe(403);

    expect((await TaskModel.findById(task._id))?.status).toBe("submitted");
  });
});

describe("supervisor scoping when returning", () => {
  it("lets a supervisor return their own team member's task, but not an outsider's", async () => {
    const { ceo, assignee, task } = await setup();
    const sup = await createUserWithToken("supervisor");

    const outside = await request(app)
      .patch(`/api/tasks/${task._id}/return`)
      .set(auth(sup.token))
      .send({ comments: "Please redo" });
    expect(outside.status).toBe(403);
    expect((await TaskModel.findById(task._id))?.status).toBe("submitted");

    await SupervisorMapping.create({
      supervisorId: sup.user._id,
      subordinateId: assignee.user._id,
      departmentName: "Test",
      assignedBy: ceo.user._id,
      status: "active",
    });
    const inTeam = await request(app)
      .patch(`/api/tasks/${task._id}/return`)
      .set(auth(sup.token))
      .send({ comments: "Please redo" });
    expect(inTeam.status).toBe(200);
    expect((await TaskModel.findById(task._id))?.status).toBe("in_progress");
  });
});

describe("stale rejection reason", () => {
  it("is cleared when the task is resubmitted", async () => {
    const { assignee, task } = await setup("in_progress");
    await TaskModel.updateOne(
      { _id: task._id },
      { rejectionReason: "old feedback" },
    );

    const res = await request(app)
      .patch(`/api/tasks/${task._id}/status`)
      .set(auth(assignee.token))
      .send({ status: "submitted" });

    expect(res.status).toBe(200);
    const fresh = await TaskModel.findById(task._id);
    expect(fresh?.status).toBe("submitted");
    expect(fresh?.rejectionReason).toBeUndefined();
  });

  it("is cleared when the task is approved (status endpoint and shortcut)", async () => {
    const a = await setup();
    await TaskModel.updateOne({ _id: a.task._id }, { rejectionReason: "old" });
    const viaStatus = await request(app)
      .patch(`/api/tasks/${a.task._id}/status`)
      .set(auth(a.ceo.token))
      .send({ status: "completed" });
    expect(viaStatus.status).toBe(200);
    expect((await TaskModel.findById(a.task._id))?.rejectionReason).toBeUndefined();

    const b = await setup();
    await TaskModel.updateOne({ _id: b.task._id }, { rejectionReason: "old" });
    const viaApprove = await request(app)
      .patch(`/api/tasks/${b.task._id}/approve`)
      .set(auth(b.ceo.token));
    expect(viaApprove.status).toBe(200);
    expect((await TaskModel.findById(b.task._id))?.rejectionReason).toBeUndefined();
  });
});