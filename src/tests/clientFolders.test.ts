import "./testEnv";
import request from "supertest";
import app from "../app";
import { startTestDb, stopTestDb } from "./helpers/db";
import { createUserWithToken } from "./helpers/fixtures";
import { ClientModel } from "../models/Client";
import { ClientFolderModel } from "../models/ClientFolder";
import { DocumentModel } from "../models/Document";

beforeAll(async () => {
  await startTestDb();
}, 120_000);
afterAll(async () => {
  await stopTestDb();
});
afterEach(async () => {
  await ClientModel.deleteMany({});
  await ClientFolderModel.deleteMany({});
  await DocumentModel.deleteMany({});
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type Person = Awaited<ReturnType<typeof createUserWithToken>>;

const setup = async () => {
  const ceo = await createUserWithToken("ceo");
  const rep = await createUserWithToken("sales_person");
  const colleague = await createUserWithToken("accountant");
  const outsider = await createUserWithToken("sales_person");
  const client = await ClientModel.create({
    name: "Acme",
    createdBy: ceo.user._id,
    assignedTo: [rep.user._id, colleague.user._id],
  });
  const otherClient = await ClientModel.create({
    name: "Other Ltd",
    createdBy: ceo.user._id,
    assignedTo: [rep.user._id],
  });
  const doc = (owner: Person, title: string, clientId = client._id) =>
    DocumentModel.create({
      title,
      documentType: "working",
      fileType: "pdf",
      fileName: `${title}.pdf`,
      fileKey: `k/${title}`,
      fileUrl: `https://example.test/${title}`,
      fileSize: 1,
      modifiedBy: owner.user._id,
      ownerId: owner.user._id,
      clientId,
    });
  const createFolder = (who: Person, name: string, clientId = client._id) =>
    request(app)
      .post(`/api/clients/${clientId}/folders`)
      .set(auth(who.token))
      .send({ name });
  return { ceo, rep, colleague, outsider, client, otherClient, doc, createFolder };
};

describe("client document folders — create / list", () => {
  it("lets anyone with access to the client create a folder, and lists it", async () => {
    const { rep, colleague, client, createFolder } = await setup();
    const res = await createFolder(rep, "  Tax   returns ");
    expect(res.status).toBe(201);
    expect(res.body.data.folder.name).toBe("Tax returns");

    const list = await request(app)
      .get(`/api/clients/${client._id}/folders`)
      .set(auth(colleague.token));
    expect(list.status).toBe(200);
    expect(list.body.data.folders.map((f: any) => f.name)).toEqual(["Tax returns"]);
    expect(list.body.data.folders[0].documentCount).toBe(0);
  });

  it("refuses people without access to the client", async () => {
    const { outsider, client, createFolder } = await setup();
    expect((await createFolder(outsider, "Nope")).status).toBe(403);
    const list = await request(app)
      .get(`/api/clients/${client._id}/folders`)
      .set(auth(outsider.token));
    expect(list.status).toBe(403);
  });

  it("validates names: required, max length, unique per client ignoring case", async () => {
    const { rep, otherClient, createFolder } = await setup();
    expect((await createFolder(rep, "   ")).status).toBe(400);
    expect((await createFolder(rep, "x".repeat(81))).status).toBe(400);
    expect((await createFolder(rep, "Invoices")).status).toBe(201);
    expect((await createFolder(rep, "invoices")).status).toBe(409);
    // the same name is fine under a different client
    expect((await createFolder(rep, "Invoices", otherClient._id)).status).toBe(201);
  });

  it("counts documents per folder and unfiled documents", async () => {
    const { rep, client, doc, createFolder } = await setup();
    const folderId = (await createFolder(rep, "Invoices")).body.data.folder._id;
    const a = await doc(rep, "a");
    await doc(rep, "b");
    await DocumentModel.updateOne({ _id: a._id }, { clientFolderId: folderId });

    const list = await request(app)
      .get(`/api/clients/${client._id}/folders`)
      .set(auth(rep.token));
    expect(list.body.data.folders[0].documentCount).toBe(1);
    expect(list.body.data.unfiledCount).toBe(1);
  });
});

describe("client document folders — moving documents", () => {
  const move = (who: Person, clientId: unknown, docId: unknown, folderId: unknown) =>
    request(app)
      .put(`/api/clients/${clientId}/documents/${docId}/folder`)
      .set(auth(who.token))
      .send({ folderId });
  const docsIn = async (who: Person, clientId: unknown, folder: string) => {
    const res = await request(app)
      .get(`/api/clients/${clientId}/documents?folderId=${folder}`)
      .set(auth(who.token));
    expect(res.status).toBe(200);
    return res.body.data.documents.map((d: any) => d.title).sort();
  };

  it("moves a document into a folder and back out; listings follow", async () => {
    const { rep, client, doc, createFolder } = await setup();
    const folderId = (await createFolder(rep, "Invoices")).body.data.folder._id;
    const a = await doc(rep, "a");
    await doc(rep, "b");

    expect((await move(rep, client._id, a._id, folderId)).status).toBe(200);
    expect(await docsIn(rep, client._id, folderId)).toEqual(["a"]);
    expect(await docsIn(rep, client._id, "root")).toEqual(["b"]);
    expect(await docsIn(rep, client._id, "all")).toEqual(["a", "b"]);

    expect((await move(rep, client._id, a._id, null)).status).toBe(200);
    expect(await docsIn(rep, client._id, "root")).toEqual(["a", "b"]);
    expect((await DocumentModel.findById(a._id))?.clientFolderId).toBeUndefined();
  });

  it("only the uploader or the CEO can move a document", async () => {
    const { ceo, rep, colleague, client, doc, createFolder } = await setup();
    const folderId = (await createFolder(rep, "Invoices")).body.data.folder._id;
    const a = await doc(rep, "a");

    expect((await move(colleague, client._id, a._id, folderId)).status).toBe(403);
    expect((await DocumentModel.findById(a._id))?.clientFolderId).toBeUndefined();
    expect((await move(ceo, client._id, a._id, folderId)).status).toBe(200);
  });

  it("rejects folders or documents that belong to a different client", async () => {
    const { rep, client, otherClient, doc, createFolder } = await setup();
    const otherFolder = (await createFolder(rep, "Theirs", otherClient._id)).body.data.folder._id;
    const a = await doc(rep, "a");
    const foreignDoc = await doc(rep, "foreign", otherClient._id);

    expect((await move(rep, client._id, a._id, otherFolder)).status).toBe(404);
    const ownFolder = (await createFolder(rep, "Mine")).body.data.folder._id;
    expect((await move(rep, client._id, foreignDoc._id, ownFolder)).status).toBe(404);
  });

  it("rejects a malformed folder filter", async () => {
    const { rep, client } = await setup();
    const res = await request(app)
      .get(`/api/clients/${client._id}/documents?folderId=not-an-id`)
      .set(auth(rep.token));
    expect(res.status).toBe(400);
  });
});

describe("client document folders — rename / delete", () => {
  it("only the creator or the CEO can rename; names stay unique", async () => {
    const { ceo, rep, colleague, client, createFolder } = await setup();
    const id = (await createFolder(rep, "Old")).body.data.folder._id;
    await createFolder(rep, "Taken");
    const rename = (who: Person, name: string) =>
      request(app)
        .put(`/api/clients/${client._id}/folders/${id}`)
        .set(auth(who.token))
        .send({ name });

    expect((await rename(colleague, "Nope")).status).toBe(403);
    expect((await rename(rep, "taken")).status).toBe(409);
    expect((await rename(rep, "New")).status).toBe(200);
    expect((await rename(ceo, "By CEO")).status).toBe(200);
    expect((await ClientFolderModel.findById(id))?.name).toBe("By CEO");
  });

  it("deleting a folder returns its documents to the main list, never deletes them", async () => {
    const { rep, colleague, client, doc, createFolder } = await setup();
    const id = (await createFolder(rep, "Invoices")).body.data.folder._id;
    const a = await doc(rep, "a");
    await DocumentModel.updateOne({ _id: a._id }, { clientFolderId: id });

    const del = (who: Person) =>
      request(app)
        .delete(`/api/clients/${client._id}/folders/${id}`)
        .set(auth(who.token));

    expect((await del(colleague)).status).toBe(403);
    expect(await ClientFolderModel.findById(id)).not.toBeNull();

    const res = await del(rep);
    expect(res.status).toBe(200);
    expect(res.body.data.releasedDocuments).toBe(1);
    expect(await ClientFolderModel.findById(id)).toBeNull();
    const fresh = await DocumentModel.findById(a._id);
    expect(fresh).not.toBeNull();
    expect(fresh?.isDeleted).not.toBe(true);
    expect(fresh?.clientFolderId).toBeUndefined();
  });
});

describe("client document folders — delete together with documents", () => {
  const inFolder = async (d: { _id: unknown }, folderId: string) =>
    DocumentModel.updateOne({ _id: d._id }, { clientFolderId: folderId });
  const del = (clientId: unknown, folderId: string, who: Person, withDocs: boolean) =>
    request(app)
      .delete(`/api/clients/${clientId}/folders/${folderId}${withDocs ? "?deleteDocuments=true" : ""}`)
      .set(auth(who.token));

  it("moves the folder's documents to Trash (recoverable) when asked", async () => {
    const { ceo, rep, client, doc, createFolder } = await setup();
    const id = (await createFolder(ceo, "Old stuff")).body.data.folder._id;
    const a = await doc(rep, "a");
    const b = await doc(ceo, "b");
    await inFolder(a, id);
    await inFolder(b, id);

    const res = await del(client._id, id, ceo, true);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ trashedDocuments: 2, releasedDocuments: 0 });
    expect(await ClientFolderModel.findById(id)).toBeNull();

    for (const d of [a, b]) {
      const fresh = await DocumentModel.findById(d._id);
      expect(fresh?.isDeleted).toBe(true); // in Trash, NOT permanently gone
      expect(fresh?.deletedBy).toBeDefined();
      expect(fresh?.clientFolderId).toBeUndefined(); // a restore lands in the main list
    }

    // …and they no longer show in the client's Documents tab.
    const list = await request(app)
      .get(`/api/clients/${client._id}/documents`)
      .set(auth(ceo.token));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/"title":"a"|"title":"b"/);
  });

  it("only trashes what the caller may delete; the rest returns to the main list", async () => {
    const { rep, colleague, client, doc, createFolder } = await setup();
    const id = (await createFolder(rep, "Mixed")).body.data.folder._id;
    const mine = await doc(rep, "mine");
    const theirs = await doc(colleague, "theirs"); // someone else's document
    await inFolder(mine, id);
    await inFolder(theirs, id);

    const res = await del(client._id, id, rep, true);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ trashedDocuments: 1, releasedDocuments: 1 });

    expect((await DocumentModel.findById(mine._id))?.isDeleted).toBe(true);
    const kept = await DocumentModel.findById(theirs._id);
    expect(kept?.isDeleted).not.toBe(true);
    expect(kept?.clientFolderId).toBeUndefined();
  });

  it("accountants can never delete documents this way", async () => {
    const { colleague, client, doc, createFolder } = await setup();
    const id = (await createFolder(colleague, "Mine")).body.data.folder._id;
    const own = await doc(colleague, "own");
    await inFolder(own, id);

    const res = await del(client._id, id, colleague, true);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ trashedDocuments: 0, releasedDocuments: 1 });
    expect((await DocumentModel.findById(own._id))?.isDeleted).not.toBe(true);
  });

  it("without the flag nothing changes: documents are released, not trashed", async () => {
    const { ceo, client, doc, createFolder } = await setup();
    const id = (await createFolder(ceo, "Plain")).body.data.folder._id;
    const a = await doc(ceo, "a");
    await inFolder(a, id);
    const res = await del(client._id, id, ceo, false);
    expect(res.body.data).toMatchObject({ trashedDocuments: 0, releasedDocuments: 1 });
    expect((await DocumentModel.findById(a._id))?.isDeleted).not.toBe(true);
  });
});