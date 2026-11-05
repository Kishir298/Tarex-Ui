import type { LocalAgentState } from "@/modules/agents/lib/types";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import type { AgentPhase } from "@/modules/terminal/lib/agentActivity";
import { findLeafCwd, leafIds } from "@/modules/terminal/lib/panes";

export type SessionPhase = AgentPhase | "shell" | "saved" | "private" | "terminal";
export type SessionFilter = "all" | "attention" | "working" | "finished" | "idle";

type SessionDetails = {
  key: string;
  title: string;
  tabTitle: string | null;
  cwd: string | null;
  space: string | null;
  pane: string | null;
  phase: SessionPhase;
  stateLabel: string;
};

export type TerminalSessionRow = SessionDetails & {
  kind: "terminal";
  tabId: number;
  leafId: number;
  private: boolean;
  cold: boolean;
};

export type ActivitySessionRow = TerminalSessionRow | (SessionDetails & {
  kind: "local";
});

const PHASE_LABELS: Record<SessionPhase, string> = {
  attention: "Attention",
  working: "Working",
  finished: "Finished",
  idle: "Idle",
  shell: "Shell",
  saved: "Saved",
  private: "Private",
  terminal: "Terminal",
};

const PHASE_PRIORITY: Record<SessionPhase, number> = {
  attention: 0,
  working: 1,
  finished: 2,
  idle: 3,
  shell: 3,
  private: 3,
  terminal: 3,
  saved: 4,
};

export function activitySessionRows({
  tabs,
  spaces,
  phases,
  agents,
  ptyForLeaf,
  busyLeaves,
  localAgent,
}: {
  tabs: readonly Tab[];
  spaces: readonly { id: string; name: string }[];
  phases: Readonly<Record<number, AgentPhase>>;
  agents: Readonly<Record<number, string>>;
  ptyForLeaf: (leafId: number) => number | null;
  busyLeaves: ReadonlySet<number>;
  localAgent: LocalAgentState;
}): ActivitySessionRow[] {
  const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
  const rows: ActivitySessionRow[] = [];
  if (localAgent) {
    rows.push({
      kind: "local",
      key: "local-agent",
      title: "AI agent",
      tabTitle: null,
      cwd: null,
      space: localAgent.agent,
      pane: "Built-in",
      phase: localAgent.status === "waiting" ? "attention" : "working",
      stateLabel: localAgent.status === "waiting" ? "Approval" : "Working",
    });
  }

  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    const leaves = leafIds(tab.paneTree);
    for (const [index, leafId] of leaves.entries()) {
      const identity = {
        kind: "terminal" as const,
        key: `terminal:${tab.id}:${leafId}`,
        tabId: tab.id,
        leafId,
        private: !!tab.private,
        cold: !!tab.cold,
        pane: leaves.length > 1 ? `Pane ${index + 1}/${leaves.length}` : null,
      };
      if (tab.private) {
        rows.push({
          ...identity,
          title: "Private terminal",
          tabTitle: null,
          cwd: null,
          space: null,
          phase: tab.cold ? "saved" : "private",
          stateLabel: tab.cold ? "Saved" : "Private",
        });
        continue;
      }

      const ptyId = tab.cold ? null : ptyForLeaf(leafId);
      const agent = ptyId === null ? null : agents[ptyId] ?? null;
      // A warm leaf without an observed PTY is not proof of startup or failure.
      const phase: SessionPhase = tab.cold ? "saved"
        : ptyId === null ? "terminal"
        : phases[ptyId] ?? (busyLeaves.has(leafId) ? "working" : "shell");
      const tabTitle = tab.customTitle || tab.title || "Terminal";
      rows.push({
        ...identity,
        title: agent || tabTitle,
        tabTitle: agent ? tabTitle : null,
        cwd: findLeafCwd(tab.paneTree, leafId) ?? tab.cwd ?? null,
        space: spaceNames.get(tab.spaceId) ?? "Workspace",
        phase,
        stateLabel: PHASE_LABELS[phase],
      });
    }
  }

  return rows.sort((a, b) => PHASE_PRIORITY[a.phase] - PHASE_PRIORITY[b.phase]);
}

export function sessionMatches(
  row: ActivitySessionRow,
  query: string,
  filter: SessionFilter,
): boolean {
  if (filter === "idle") {
    if (PHASE_PRIORITY[row.phase] < PHASE_PRIORITY.idle) return false;
  } else if (filter !== "all" && row.phase !== filter) return false;

  const terms = query.trim().toLowerCase().replace(/\\/g, "/").split(/\s+/);
  const text = [row.title, row.tabTitle, row.cwd, row.space, row.pane, row.stateLabel]
    .filter(Boolean).join("\n").toLowerCase().replace(/\\/g, "/");
  return terms.every((term) => text.includes(term));
}
