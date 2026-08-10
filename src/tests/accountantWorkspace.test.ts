import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ClientModel } from "../models/Client";
import { ClientInvoiceModel } from "../models/ClientInvoice";
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
  await ClientInvoiceModel.deleteMany({});
  await ClientNoteModel.deleteMany({});
  await TaskModel.deleteMany({});
  await MeetingModel.deleteMany({});
});

const daysFromNow = (n: number) =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000);

describe("GET /api/analytics/accountant-workspace", () => {
  it("is rejected for a role that isn't accountant or ceo", async () => {
    const { token } = await createUserWithToken("user");

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
      invoiceSummary: [],
      overdueInvoices: [],
      dueSoonInvoices: [],
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

    await ClientInvoiceModel.create({
      clientId: myClient._id,
      authorId: accountant._id,
      amount: 500,
      currency: "USD",
      status: "unpaid",
      dueDate: daysFromNow(-3),
    });
    await ClientInvoiceModel.create({
      clientId: otherClient._id,
      authorId: otherAccountant._id,
      amount: 9999,
      currency: "USD",
      status: "unpaid",
      dueDate: daysFromNow(-3),
    });

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.clientCount).toBe(1);
    expect(res.body.data.overdueInvoices).toHaveLength(1);
    expect(res.body.data.overdueInvoices[0].amount).toBe(500);
    expect(res.body.data.overdueInvoices[0].clientId.name).toBe("My Client");
  });

  it("buckets invoices correctly across overdue / due-soon / paid-this-month / cancelled", async () => {
    const { user: accountant, token } = await createUserWithToken("accountant");
    const client = await ClientModel.create({
      name: "Acme Corp",
      createdBy: accountant._id,
      assignedTo: [accountant._id],
    });

    // Overdue (unpaid, past due date)
    await ClientInvoiceModel.create({
      clientId: client._id,
      authorId: accountant._id,
      invoiceNumber: "INV-001",
      amount: 1000,
      currency: "USD",
      status: "unpaid",
      dueDate: daysFromNow(-5),
    });
    // Overdue (explicitly marked "overdue" status)
    await ClientInvoiceModel.create({
      clientId: client._id,
      authorId: accountant._id,
      invoiceNumber: "INV-002",
      amount: 250,
      currency: "USD",
      status: "overdue",
      dueDate: daysFromNow(-1),
    });
    // Due soon (within the next 7 days)
    await ClientInvoiceModel.create({
      clientId: client._id,
      authorId: accountant._id,
      invoiceNumber: "INV-003",
      amount: 400,
      currency: "USD",
      status: "unpaid",
      dueDate: daysFromNow(3),
    });
    // Unpaid with no due date — must NOT be counted as overdue
    // (guards against Mongo's null-comparison ordering quirk).
    await ClientInvoiceModel.create({
      clientId: client._id,
      authorId: accountant._id,
      invoiceNumber: "INV-004",
      amount: 75,
      currency: "USD",
      status: "unpaid",
    });
    // Paid this month
    await ClientInvoiceModel.create({
      clientId: client._id,
      authorId: accountant._id,
      invoiceNumber: "INV-005",
      amount: 600,
      currency: "USD",
      status: "paid",
      paidAt: new Date(),
    });
    // Cancelled — should not count toward outstanding or overdue
    await ClientInvoiceModel.create({
      clientId: client._id,
      authorId: accountant._id,
      invoiceNumber: "INV-006",
      amount: 300,
      currency: "USD",
      status: "cancelled",
      dueDate: daysFromNow(-10),
    });

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const usd = res.body.data.invoiceSummary.find((s: any) => s._id === "USD");
    expect(usd).toBeDefined();
    // outstanding = unpaid + overdue statuses = 1000 + 250 + 400 + 75
    expect(usd.outstandingAmount).toBe(1725);
    expect(usd.outstandingCount).toBe(4);
    // overdue = unpaid/overdue AND dueDate in the past AND dueDate set = 1000 + 250
    expect(usd.overdueAmount).toBe(1250);
    expect(usd.overdueCount).toBe(2);
    expect(usd.paidThisMonthAmount).toBe(600);
    expect(usd.paidThisMonthCount).toBe(1);

    expect(res.body.data.overdueInvoices).toHaveLength(2);
    expect(
      res.body.data.overdueInvoices.map((i: any) => i.invoiceNumber),
    ).toEqual(["INV-001", "INV-002"]); // sorted by dueDate ascending

    expect(res.body.data.dueSoonInvoices).toHaveLength(1);
    expect(res.body.data.dueSoonInvoices[0].invoiceNumber).toBe("INV-003");
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

  it("combines recent notes and invoice updates into one activity feed, newest first", async () => {
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
    await ClientInvoiceModel.create({
      clientId: client._id,
      authorId: accountant._id,
      invoiceNumber: "INV-100",
      amount: 200,
      currency: "USD",
      status: "unpaid",
    });

    const res = await request(app)
      .get("/api/analytics/accountant-workspace")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const types = res.body.data.recentActivity.map((a: any) => a.type);
    expect(types).toEqual(expect.arrayContaining(["note", "invoice"]));
    expect(res.body.data.recentActivity[0].client.name).toBe("Acme Corp");
  });
});
