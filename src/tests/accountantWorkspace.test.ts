import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ClientModel } from "../models/Client";
import { ClientNoteModel } from "../models/ClientNote";
import { TaskModel } from "../models/Task";
import { MeetingModel } from "../models/Meeting";

beforeAll(async () => {
  await startTestDb();
}, 120_000); // generous: first run may still need to finish caching the mongod binary

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await ClientModel.deleteMany({});
  await ClientNoteModel.deleteMany({});
  await TaskModel.deleteMany({});
  await MeetingModel.deleteMany({});
});

const daysFromNow = (n: number) =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000);

describe("GET /api/analytics/accountant-workspace", () => {
  it("is rejected for a role that isn't accountant, ceo or supervisor", async () => {
    const { token } = await createUserWithToken("sales_person");

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("returns an empty-but-valid shape when the accountant has no clients", async () => {
    const { token } = await createUserWithToken("accountant");

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      clientCount: 0,
      taskDeadlines: { overdue: [], dueSoon: [] },
      upcomingMeetings: [],
      recentActivity: [],
    });
  });

  it("only rolls up clients assigned to this accountant, not another accountant's book", async () => {
    const { user: accountant, token } = await createUserWithToken("accountant");
    const { user: otherAccountant } = await createUserWithToken("accountant");

    const myClient = await ClientModel.create({
      name: "My Client",
      createdBy: accountant._id,
      assignedTo: [accountant._id],
    });
    const otherClient = await ClientModel.create({
      name: "Someone Else's Client",
      createdBy: otherAccountant._id,
      assignedTo: [otherAccountant._id],
    });

    await ClientNoteModel.create({
      clientId: myClient._id,
      authorId: accountant._id,
      body: "Note on my client",
    });
    await ClientNoteModel.create({
      clientId: otherClient._id,
      authorId: otherAccountant._id,
      body: "Note on someone else's client",
    });

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.clientCount).toBe(1);
    expect(res.body.data.recentActivity).toHaveLength(1);
    expect(res.body.data.recentActivity[0].client.name).toBe("My Client");
  });

  it("separates the accountant's own overdue and upcoming task deadlines", async () => {
    const { user: accountant, token } = await createUserWithToken("accountant");
    const { user: ceo } = await createUserWithToken("ceo");
    const client = await ClientModel.create({
      name: "Acme Corp",
      createdBy: accountant._id,
      assignedTo: [accountant._id],
    });

    await TaskModel.create({
      title: "File overdue VAT return",
      assignedBy: ceo._id,
      assignedTo: accountant._id,
      clientId: client._id,
      status: "in_progress",
      priority: "high",
      dueDate: daysFromNow(-2),
    });
    await TaskModel.create({
      title: "Prepare monthly reconciliation",
      assignedBy: ceo._id,
      assignedTo: accountant._id,
      clientId: client._id,
      status: "pending",
      priority: "medium",
      dueDate: daysFromNow(2),
    });
    // Completed — must be excluded even though it's technically "overdue"
    await TaskModel.create({
      title: "Old completed task",
      assignedBy: ceo._id,
      assignedTo: accountant._id,
      clientId: client._id,
      status: "completed",
      priority: "low",
      dueDate: daysFromNow(-10),
    });
    // Someone else's task — must not leak into this accountant's list
    await TaskModel.create({
      title: "Not mine",
      assignedBy: ceo._id,
      assignedTo: ceo._id,
      status: "pending",
      priority: "low",
      dueDate: daysFromNow(-1),
    });

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.taskDeadlines.overdue).toHaveLength(1);
    expect(res.body.data.taskDeadlines.overdue[0].title).toBe(
      "File overdue VAT return",
    );
    expect(res.body.data.taskDeadlines.dueSoon).toHaveLength(1);
    expect(res.body.data.taskDeadlines.dueSoon[0].title).toBe(
      "Prepare monthly reconciliation",
    );
  });

  it("lists upcoming meetings tied to the accountant's clients within the next 7 days", async () => {
    const { user: accountant, token } = await createUserWithToken("accountant");
    const client = await ClientModel.create({
      name: "Acme Corp",
      createdBy: accountant._id,
      assignedTo: [accountant._id],
    });

    await MeetingModel.create({
      title: "Quarterly review with Acme",
      organizer: accountant._id,
      startTime: daysFromNow(2),
      endTime: daysFromNow(2),
      status: "scheduled",
      clientId: client._id,
    });
    // Too far out — should not appear
    await MeetingModel.create({
      title: "Next quarter planning",
      organizer: accountant._id,
      startTime: daysFromNow(30),
      endTime: daysFromNow(30),
      status: "scheduled",
      clientId: client._id,
    });
    // Cancelled — should not appear
    await MeetingModel.create({
      title: "Cancelled catch-up",
      organizer: accountant._id,
      startTime: daysFromNow(1),
      endTime: daysFromNow(1),
      status: "cancelled",
      clientId: client._id,
    });

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.upcomingMeetings).toHaveLength(1);
    expect(res.body.data.upcomingMeetings[0].title).toBe(
      "Quarterly review with Acme",
    );
  });

  it("lists recent client notes in the activity feed, newest first", async () => {
    const { user: accountant, token } = await createUserWithToken("accountant");
    const client = await ClientModel.create({
      name: "Acme Corp",
      createdBy: accountant._id,
      assignedTo: [accountant._id],
    });

    await ClientNoteModel.create({
      clientId: client._id,
      authorId: accountant._id,
      body: "Called client about outstanding balance",
    });
    await ClientNoteModel.create({
      clientId: client._id,
      authorId: accountant._id,
      body: "Sent the filing checklist",
    });

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const types = res.body.data.recentActivity.map((a: any) => a.type);
    expect(types).toEqual(["note", "note"]);
    expect(res.body.data.recentActivity[0].client.name).toBe("Acme Corp");
  });
});