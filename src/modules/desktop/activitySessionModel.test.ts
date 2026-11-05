import { activitySessionRows, sessionMatches } from "@/modules/desktop/activitySessionModel";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { describe, expect, it, vi } from "vitest";

function terminal(id: number, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal", id, title: `Terminal ${id}`, spaceId: "work",
    paneTree: { kind: "leaf", id: id + 100 }, activeLeafId: id + 100,
    ...overrides,
  };
}

function sessions(overrides: Partial<Parameters<typeof activitySessionRows>[0]> = {}) {
  return activitySessionRows({
    tabs: [], spaces: [{ id: "work", name: "Client project" }],
    phases: {}, agents: {}, ptyForLeaf: (id) => id + 1000,
    busyLeaves: new Set(), localAgent: null, ...overrides,
  });
}

describe("activity sessions", () => {
  it("prioritizes genuine attention, working commands, completion, and saved panes", () => {
    const rows = sessions({
      tabs: [terminal(1, { cold: true }), terminal(2), terminal(3), terminal(4), terminal(5)],
      phases: { 1102: "finished", 1103: "attention", 1105: "idle" },
      agents: { 1105: "Claude Code" },
      busyLeaves: new Set([104, 105]),
    });
    expect(rows.map((row) => [row.key, row.phase])).toEqual([
      ["terminal:3:103", "attention"], ["terminal:4:104", "working"],
      ["terminal:2:102", "finished"], ["terminal:5:105", "idle"],
      ["terminal:1:101", "saved"],
    ]);
    expect(rows.filter((row) => sessionMatches(row, "", "attention"))).toHaveLength(1);
  });

  it("uses PTY identity for signals and preserves every split leaf's activation identity", () => {
    const tabs: Tab[] = [terminal(7, {
      cwd: "/fallback", paneTree: {
        kind: "split", id: 900, dir: "row", children: [
          { kind: "leaf", id: 41, cwd: "/work/api" },
          { kind: "split", id: 901, dir: "col", children: [
            { kind: "leaf", id: 42, cwd: "C:\\work\\web" },
            { kind: "leaf", id: 43 },
          ] },
        ],
      },
    }), { kind: "editor", id: 8, spaceId: "work", title: "Notes", path: "/notes", dirty: false, preview: false }];
    const rows = sessions({
      tabs, ptyForLeaf: (id) => id + 500,
      phases: { 41: "attention", 542: "working", 543: "finished" },
      agents: { 41: "Wrong identity", 542: "Codex" },
    });
    expect(rows.map((row) => row.key)).toEqual(["terminal:7:42", "terminal:7:43", "terminal:7:41"]);
    expect(rows[0]).toMatchObject({ tabId: 7, leafId: 42, title: "Codex", pane: "Pane 2/3", cwd: "C:\\work\\web" });
    expect(rows[2]).toMatchObject({ phase: "shell", cwd: "/work/api" });
    expect(sessionMatches(rows[0], "client C:/work/web Codex", "working")).toBe(true);
    expect(sessionMatches(rows[0], "terminal 7", "all")).toBe(true);
  });

  it("redacts private metadata before sorting or searching and never resolves its PTY", () => {
    const ptyForLeaf = vi.fn(() => 99);
    const [row] = sessions({
      tabs: [terminal(1, {
        private: true, title: "Secret client", customTitle: "Acquisition",
        cwd: "/hidden/project", paneTree: { kind: "leaf", id: 101, cwd: "/hidden/client" },
      })],
      ptyForLeaf, agents: { 99: "Confidential Agent" }, phases: { 99: "attention" },
      busyLeaves: new Set([101]),
    });
    expect(ptyForLeaf).not.toHaveBeenCalled();
    expect(row).toMatchObject({ title: "Private terminal", cwd: null, tabTitle: null, space: null, phase: "private" });
    for (const query of ["Secret", "Acquisition", "hidden", "Client project", "Confidential Agent"]) {
      expect(sessionMatches(row, query, "all")).toBe(false);
      expect(JSON.stringify(row)).not.toContain(query);
    }
    expect(sessionMatches(row, "Private terminal", "all")).toBe(true);
    expect(sessionMatches(row, "", "attention")).toBe(false);
  });

  it("treats cold panes as saved and an unobserved PTY as unknown rather than permanently starting", () => {
    const ptyForLeaf = vi.fn(() => null);
    const rows = sessions({ tabs: [terminal(1, { cold: true }), terminal(2)], ptyForLeaf });
    expect(ptyForLeaf).toHaveBeenCalledExactlyOnceWith(102);
    expect(rows.map((row) => row.phase)).toEqual(["terminal", "saved"]);
    expect(sessions({ tabs: [terminal(2)] })[0].phase).toBe("shell");
  });

  it("places local approval above a working terminal and removes the local row when idle", () => {
    const rows = sessions({
      tabs: [terminal(1)], phases: { 1101: "working" },
      localAgent: { agent: "Terex UI", status: "waiting" },
    });
    expect(rows[0]).toMatchObject({ kind: "local", phase: "attention", stateLabel: "Approval" });
    expect(sessionMatches(rows[0], "Terex", "attention")).toBe(true);
    expect(sessions()).toEqual([]);
  });
});
