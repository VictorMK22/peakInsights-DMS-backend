import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ClientModel } from "../models/Client";
import { SupervisorMapping } from "../models/SupervisorMapping";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
afterEach(async () => {
  await ClientModel.deleteMany({});
  await SupervisorMapping.deleteMany({});
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const list = (token: string, qs = "") =>
  request(app).get(`/api/clients?${qs}`).set(auth(token));
const grouped = (token: string, qs = "") =>
  request(app).get(`/api/clients/grouped?${qs}`).set(auth(token));
const names = (res: request.Response) =>
  res.body.data.clients.map((c: any) => c.name).sort();
const groupNames = (res: request.Response) =>
  res.body.data.groups.map((g: any) => g.user?.name ?? "(unassigned)");
const groupOf = (res: request.Response, who: string) =>
  res.body.data.groups.find((g: any) => (g.user?.name ?? "(unassigned)") === who);

/**
 * A supervisor with two accountants (Ann, Ben), one accountant outside the
 * team (Outsider) and a CEO to create the clients.
 */
const setup = async () => {
  const ceo = await createUserWithToken("ceo");
  const sup = await createUserWithToken("supervisor", { name: "Sue" });
  const ann = await createUserWithToken("accountant", { name: "Ann" });
  const ben = await createUserWithToken("accountant", { name: "Ben" });
  const outsider = await createUserWithToken("accountant", { name: "Outsider" });
  for (const m of [ann, ben])
    await SupervisorMapping.create({
      supervisorId: sup.user._id,
      subordinateId: m.user._id,
      departmentName: "Accounting",
      assignedBy: ceo.user._id,
    });
  const mk = (
    name: string,
    assignedTo: { user: { _id: unknown } }[],
    extra: Record<string, unknown> = {},
  ) =>
    ClientModel.create({
      name,
      createdBy: ceo.user._id,
      assignedTo: assignedTo.map((p) => p.user._id),
      ...extra,
    });
  return { ceo, sup, ann, ben, outsider, mk };
};

describe("GET /clients?assignee= — a supervisor looking at one team member", () => {
  it("returns only that person's clients, including ones shared with others", async () => {
    const { sup, ann, ben, mk } = await setup();
    await mk("Only Ann", [ann]);
    await mk("Only Ben", [ben]);
    await mk("Ann And Ben", [ann, ben]);

    const res = await list(sup.token, `assignee=${ann.user._id}`);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Ann And Ben", "Only Ann"]);
    expect(res.body.pagination.total).toBe(2);
  });

  it("can look at their own clients", async () => {
    const { sup, ann, mk } = await setup();
    await mk("Mine", [sup]);
    await mk("Ann's", [ann]);
    const res = await list(sup.token, `assignee=${sup.user._id}`);
    expect(names(res)).toEqual(["Mine"]);
  });

  it("still lists the whole team's clients when no assignee is given", async () => {
    const { sup, ann, ben, outsider, mk } = await setup();
    await mk("Only Ann", [ann]);
    await mk("Only Ben", [ben]);
    await mk("Not Theirs", [outsider]);
    expect(names(await list(sup.token))).toEqual(["Only Ann", "Only Ben"]);
  });

  it("refuses someone outside their team, even on a client they can see", async () => {
    const { sup, ann, outsider, mk } = await setup();
    await mk("Shared With Outsider", [ann, outsider]);
    const res = await list(sup.token, `assignee=${outsider.user._id}`);
    expect(res.status).toBe(403);
  });

  it("refuses a former team member (inactive mapping)", async () => {
    const { sup, ben, mk } = await setup();
    await mk("Ben's", [ben]);
    await SupervisorMapping.updateOne(
      { subordinateId: ben.user._id },
      { status: "historical" },
    );
    const res = await list(sup.token, `assignee=${ben.user._id}`);
    expect(res.status).toBe(403);
  });

  it("rejects a malformed id and the CEO-only 'unassigned'", async () => {
    const { sup } = await setup();
    expect((await list(sup.token, "assignee=not-an-id")).status).toBe(400);
    expect((await list(sup.token, "assignee=unassigned")).status).toBe(403);
  });

  it("combines with search", async () => {
    const { sup, ann, mk } = await setup();
    await mk("Acme Ltd", [ann]);
    await mk("Zeta Ltd", [ann]);
    const res = await list(sup.token, `assignee=${ann.user._id}&search=acme`);
    expect(names(res)).toEqual(["Acme Ltd"]);
  });
});

describe("GET /clients?assignee= — the CEO", () => {
  it("can look at any user's clients", async () => {
    const { ceo, ann, outsider, mk } = await setup();
    await mk("Ann's", [ann]);
    await mk("Outsider's", [outsider]);
    expect(names(await list(ceo.token, `assignee=${outsider.user._id}`))).toEqual([
      "Outsider's",
    ]);
    expect(names(await list(ceo.token, `assignee=${ann.user._id}`))).toEqual([
      "Ann's",
    ]);
  });

  it("can ask for clients nobody is assigned to", async () => {
    const { ceo, ann, mk } = await setup();
    await mk("Nobody's", []);
    await mk("Ann's", [ann]);
    expect(names(await list(ceo.token, "assignee=unassigned"))).toEqual([
      "Nobody's",
    ]);
  });
});

describe("GET /clients?assignee= — everyone else", () => {
  it("may only name themself", async () => {
    const { ann, ben, mk } = await setup();
    await mk("Ann's", [ann]);
    expect(names(await list(ann.token, `assignee=${ann.user._id}`))).toEqual([
      "Ann's",
    ]);
    expect((await list(ann.token, `assignee=${ben.user._id}`)).status).toBe(403);
  });
});

describe("GET /clients/grouped — a supervisor", () => {
  it("groups the team's clients by member, listing a shared client under each", async () => {
    const { sup, ann, ben, outsider, mk } = await setup();
    await mk("Only Ann", [ann]);
    await mk("Only Ben", [ben]);
    await mk("Ann And Ben", [ann, ben]);
    await mk("Not Theirs", [outsider]);

    const res = await grouped(sup.token);
    expect(res.status).toBe(200);

    const ann_ = groupOf(res, "Ann");
    expect(ann_.total).toBe(2);
    expect(ann_.clients.map((c: any) => c.name).sort()).toEqual([
      "Ann And Ben",
      "Only Ann",
    ]);
    const ben_ = groupOf(res, "Ben");
    expect(ben_.total).toBe(2);
    expect(ben_.clients.map((c: any) => c.name).sort()).toEqual([
      "Ann And Ben",
      "Only Ben",
    ]);

    // Outsider's client is invisible, Outsider is not a group, and the
    // distinct count counts the shared client once.
    expect(groupOf(res, "Outsider")).toBeUndefined();
    expect(res.body.data.totalClients).toBe(3);
  });

  it("never makes a group for someone outside the team, even on a shared client", async () => {
    const { sup, ann, outsider, mk } = await setup();
    await mk("Shared With Outsider", [ann, outsider]);
    const res = await grouped(sup.token);
    expect(groupOf(res, "Outsider")).toBeUndefined();
    expect(groupOf(res, "Ann").total).toBe(1);
    expect(res.body.data.totalClients).toBe(1);
  });

  it("lists every team member, with 0 for those with no clients, and the supervisor first", async () => {
    const { sup, ann, mk } = await setup();
    await mk("Only Ann", [ann]);
    const res = await grouped(sup.token);
    expect(groupNames(res)).toEqual(["Sue", "Ann", "Ben"]);
    expect(groupOf(res, "Ben")).toMatchObject({ total: 0, clients: [] });
    expect(groupOf(res, "Sue").total).toBe(0);
  });

  it("includes the supervisor's own clients as a group", async () => {
    const { sup, mk } = await setup();
    await mk("Mine", [sup]);
    const res = await grouped(sup.token);
    expect(groupOf(res, "Sue").clients.map((c: any) => c.name)).toEqual(["Mine"]);
  });

  it("previews the first clients A–Z but reports the full total", async () => {
    const { sup, ann, mk } = await setup();
    // Created in reverse so creation order and A–Z order disagree.
    for (let i = 4; i >= 1; i--) await mk(`Client ${i}`, [ann]);

    const res = await grouped(sup.token, "perGroup=2");
    const g = groupOf(res, "Ann");
    expect(g.total).toBe(4);
    expect(g.clients.map((c: any) => c.name)).toEqual(["Client 1", "Client 2"]);
  });

  it("perGroup=0 returns counts only", async () => {
    const { sup, ann, mk } = await setup();
    await mk("Only Ann", [ann]);
    const g = groupOf(await grouped(sup.token, "perGroup=0"), "Ann");
    expect(g).toMatchObject({ total: 1, clients: [] });
  });

  it("populates each previewed client's assignees", async () => {
    const { sup, ann, ben, mk } = await setup();
    await mk("Ann And Ben", [ann, ben]);
    const c = groupOf(await grouped(sup.token), "Ann").clients[0];
    expect(c.assignedTo.map((u: any) => u.name).sort()).toEqual(["Ann", "Ben"]);
  });

  it("applies the search and tab filters to the groups", async () => {
    const { ceo, sup, ann, ben, mk } = await setup();
    await mk("Acme Ltd", [ann]);
    await mk("Zeta Ltd", [ben]);
    const res = await grouped(sup.token, "search=acme");
    expect(groupOf(res, "Ann").total).toBe(1);
    expect(groupOf(res, "Ben").total).toBe(0);
    expect(res.body.data.totalClients).toBe(1);

    await mk("Won Co", [ann], { isSalesLead: true, salesStage: "won" });
    await mk("Prospect Co", [ann], { isSalesLead: true, salesStage: "in_discussion" });
    const prospects = await grouped(ceo.token, "tab=prospects");
    expect(groupOf(prospects, "Ann").clients.map((c: any) => c.name)).toEqual([
      "Prospect Co",
    ]);
  });

  it("mine=true narrows to the supervisor's own group", async () => {
    const { sup, ann, mk } = await setup();
    await mk("Mine", [sup]);
    await mk("Ann's", [ann]);
    const res = await grouped(sup.token, "mine=true");
    expect(groupNames(res)).toEqual(["Sue"]);
    expect(res.body.data.totalClients).toBe(1);
  });

  it("each group matches what ?assignee= returns for that person", async () => {
    const { sup, ann, ben, mk } = await setup();
    await mk("A", [ann]);
    await mk("B", [ben]);
    await mk("AB", [ann, ben]);
    const res = await grouped(sup.token, "perGroup=20");
    for (const [who, u] of [["Ann", ann], ["Ben", ben]] as const) {
      const flat = await list(sup.token, `assignee=${u.user._id}`);
      expect(groupOf(res, who).clients.map((c: any) => c.name).sort()).toEqual(
        names(flat),
      );
      expect(groupOf(res, who).total).toBe(flat.body.pagination.total);
    }
  });
});

describe("GET /clients/grouped — the CEO", () => {
  it("groups every client by person, with an Unassigned group last", async () => {
    const { ceo, ann, outsider, mk } = await setup();
    await mk("Ann's", [ann]);
    await mk("Outsider's", [outsider]);
    await mk("Nobody's", []);

    const res = await grouped(ceo.token);
    expect(groupNames(res)).toEqual(["Ann", "Outsider", "(unassigned)"]);
    expect(groupOf(res, "(unassigned)")).toMatchObject({
      key: "unassigned",
      total: 1,
    });
    expect(res.body.data.totalClients).toBe(3);
  });

  it("leaves out people with no clients and has no Unassigned group when there are none", async () => {
    const { ceo, ann, mk } = await setup();
    await mk("Ann's", [ann]);
    expect(groupNames(await grouped(ceo.token))).toEqual(["Ann"]);
  });

  it("mine=true gives the CEO just their own group (Sales / Accountant workspace)", async () => {
    const { ceo, ann, mk } = await setup();
    await mk("CEO's", [ceo]);
    await mk("Ann's", [ann]);
    await mk("Nobody's", []);
    const res = await grouped(ceo.token, "mine=true");
    expect(groupNames(res)).toEqual([ceo.user.name]);
  });
});

describe("GET /clients/grouped — access", () => {
  it("is closed to sales people and accountants", async () => {
    const { ann } = await setup();
    const sales = await createUserWithToken("sales_person");
    expect((await grouped(ann.token)).status).toBe(403);
    expect((await grouped(sales.token)).status).toBe(403);
  });
});

describe("GET /clients — alphabetical order", () => {
  const order = (res: request.Response) =>
    res.body.data.clients.map((c: any) => c.company?.trim() || c.name);

  it("sorts by company, else name, ignoring case, with numbers in natural order", async () => {
    const { ceo, mk } = await setup();
    await mk("zed", []);
    await mk("Contact Z", [], { company: "Beta Ltd" });
    await mk("Client 10", []);
    await mk("Client 2", []);
    await mk("alpha", []);
    await mk("Contact A", [], { company: "   " }); // blank company -> name
    const res = await list(ceo.token);
    expect(order(res)).toEqual([
      "alpha",
      "Beta Ltd",
      "Client 2",
      "Client 10",
      "Contact A",
      "zed",
    ]);
  });

  it("keeps the order across pages without repeats", async () => {
    const { ceo, mk } = await setup();
    for (const n of ["E", "C", "A", "D", "B"]) await mk(`Co ${n}`, []);
    const p1 = await list(ceo.token, "limit=2&page=1");
    const p2 = await list(ceo.token, "limit=2&page=2");
    const p3 = await list(ceo.token, "limit=2&page=3");
    expect([...order(p1), ...order(p2), ...order(p3)]).toEqual([
      "Co A", "Co B", "Co C", "Co D", "Co E",
    ]);
    expect(p1.body.pagination).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3 });
  });
});

describe("GET /clients?assignee=&accountantRole= — an accountant's primary and secondary clients", () => {
  it("splits one accountant's clients for the CEO", async () => {
    const { ceo, ann, ben, mk } = await setup();
    await mk("Primary Two", [ann], { allocatedAccountant: ann.user._id });
    await mk("Primary One", [ann, ben], { allocatedAccountant: ann.user._id });
    await mk("Secondary B", [ann, ben], { allocatedAccountant: ben.user._id });
    await mk("Secondary A", [ben, ann], { allocatedAccountant: ben.user._id });
    await mk("Bens Only", [ben], { allocatedAccountant: ben.user._id });

    const q = (role: string) =>
      list(ceo.token, `assignee=${ann.user._id}&accountantRole=${role}`);
    const primary = await q("primary");
    const secondary = await q("secondary");
    expect(primary.body.data.clients.map((c: any) => c.name)).toEqual([
      "Primary One",
      "Primary Two",
    ]);
    expect(secondary.body.data.clients.map((c: any) => c.name)).toEqual([
      "Secondary A",
      "Secondary B",
    ]);
    expect(secondary.body.pagination.total).toBe(2);
  });

  it("leaves out prospects still in the sales pipeline", async () => {
    const { ceo, ann, mk } = await setup();
    await mk("Won", [ann], { allocatedAccountant: ann.user._id, isSalesLead: true, salesStage: "won" });
    await mk("Prospect", [ann], { allocatedAccountant: ann.user._id, isSalesLead: true, salesStage: "in_discussion" });
    const res = await list(ceo.token, `assignee=${ann.user._id}&accountantRole=primary`);
    expect(names(res)).toEqual(["Won"]);
  });

  it("lets a supervisor see a team member's split but not an outsider's", async () => {
    const { sup, ann, outsider, mk } = await setup();
    await mk("Anns", [ann], { allocatedAccountant: ann.user._id });
    await mk("Outsiders", [outsider], { allocatedAccountant: outsider.user._id });
    const ok = await list(sup.token, `assignee=${ann.user._id}&accountantRole=primary`);
    expect(ok.status).toBe(200);
    expect(names(ok)).toEqual(["Anns"]);
    const no = await list(sup.token, `assignee=${outsider.user._id}&accountantRole=primary`);
    expect(no.status).toBe(403);
  });

  it("without ?assignee= still means the caller's own split", async () => {
    const { ann, ben, mk } = await setup();
    await mk("Mine", [ann], { allocatedAccountant: ann.user._id });
    await mk("Bens", [ben], { allocatedAccountant: ben.user._id });
    const res = await list(ann.token, "accountantRole=primary");
    expect(names(res)).toEqual(["Mine"]);
  });
});