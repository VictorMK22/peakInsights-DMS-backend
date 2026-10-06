import "./testEnv";
import { workspacesForTeam } from "../controllers/userController";

// Pure mapping from "roles on my team" -> "workspaces I can work in".
// No database involved, so this runs anywhere.

describe("workspacesForTeam", () => {
  it("maps each staff role to its workspace", () => {
    expect(workspacesForTeam(["sales_person"])).toEqual(["sales"]);
    expect(workspacesForTeam(["accountant"])).toEqual(["accountant"]);
    expect(workspacesForTeam(["tech"])).toEqual(["tech"]);
  });

  it("returns one entry per workspace, not one per team member", () => {
    expect(
      workspacesForTeam(["accountant", "accountant", "accountant"]),
    ).toEqual(["accountant"]);
  });

  it("lists the most common team role first on a mixed team", () => {
    expect(
      workspacesForTeam(["accountant", "sales_person", "sales_person", "tech"]),
    ).toEqual(["sales", "accountant", "tech"]);
  });

  it("ignores roles that have no workspace of their own", () => {
    // A supervisor reporting to another supervisor, or a stray CEO, must
    // not produce a bogus workspace key.
    expect(workspacesForTeam(["supervisor", "ceo", "accountant"])).toEqual([
      "accountant",
    ]);
  });

  describe("when the team is empty", () => {
    it("falls back to the supervisor's own department", () => {
      expect(workspacesForTeam([], "Finance")).toEqual(["accountant"]);
      expect(workspacesForTeam([], "Accounting")).toEqual(["accountant"]);
      expect(workspacesForTeam([], "ICT")).toEqual(["tech"]);
    });

    it("uses the same default as demoteSupervisor for unknown/blank departments", () => {
      expect(workspacesForTeam([], "Marketing")).toEqual(["sales"]);
      expect(workspacesForTeam([], undefined)).toEqual(["sales"]);
      expect(workspacesForTeam([], "")).toEqual(["sales"]);
    });

    it("prefers the real team over the department when a team exists", () => {
      // A Finance supervisor who actually manages sales people gets the
      // sales workspace — the team decides, not the label.
      expect(workspacesForTeam(["sales_person"], "Finance")).toEqual(["sales"]);
    });
  });
});
