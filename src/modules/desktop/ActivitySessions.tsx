import "@/styles/activity-sessions.css";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import {
  activitySessionRows,
  sessionMatches,
  type ActivitySessionRow,
  type SessionFilter,
  type TerminalSessionRow,
} from "@/modules/desktop/activitySessionModel";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import { useTerminalBusy } from "@/modules/terminal/lib/terminalActivity";
import { ptyIdForLeaf } from "@/modules/terminal/lib/terminalSessionApi";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

type Props = {
  tabs: Tab[];
  activeTabId: number;
  activeLeafId: number | null;
  onActivate: (tabId: number, leafId: number) => void;
  onOpenAi: () => void;
};

export function ActivitySessions({ tabs, activeTabId, activeLeafId, onActivate, onOpenAi }: Props) {
  const phases = useAgentActivityStore((state) => state.phases);
  const agents = useAgentActivityStore((state) => state.agents);
  const localAgent = useAgentStore((state) => state.localAgent);
  const spaces = useSpaces((state) => state.spaces);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [busyLeaves, setBusyLeaves] = useState<ReadonlySet<number>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const reportBusy = useCallback((leafId: number, busy: boolean) => {
    setBusyLeaves((previous) => {
      if (previous.has(leafId) === busy) return previous;
      const next = new Set(previous);
      if (busy) next.add(leafId);
      else next.delete(leafId);
      return next;
    });
  }, []);

  const rows = activitySessionRows({
    tabs, spaces, phases, agents, ptyForLeaf: ptyIdForLeaf, busyLeaves, localAgent,
  });
  const visibleRows = rows.filter((row) => sessionMatches(row, query, filter));
  const visibleKeys = new Set(visibleRows.map((row) => row.key));

  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && listRef.current?.contains(focused)
      && focused.closest("li")?.hidden) searchRef.current?.focus();
  });

  const rowButtons = () => Array.from(
    listRef.current?.querySelectorAll<HTMLButtonElement>("li:not([hidden]) > button") ?? [],
  );
  const navigateRows = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = rowButtons();
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    buttons[next]?.focus();
  };
  const clearSearch = () => {
    setQuery("");
    searchRef.current?.focus();
  };

  return (
    <section className="tarex-activity-sessions" aria-label="Sessions across all spaces">
      <div className="tarex-session-search">
        <input
          ref={searchRef}
          type="search"
          aria-label="Search sessions"
          placeholder="Search name, path, space"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              rowButtons()[0]?.focus();
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              clearSearch();
            }
          }}
        />
        {query && <button type="button" onClick={clearSearch} aria-label="Clear session search">Clear</button>}
      </div>
      <div className="tarex-session-controls">
        <span role="status">{visibleRows.length}/{rows.length} sessions</span>
        <select
          aria-label="Filter session state"
          value={filter}
          onChange={(event) => setFilter(event.target.value as SessionFilter)}
        >
          <option value="all">All states</option>
          <option value="attention">Attention</option>
          <option value="working">Working</option>
          <option value="finished">Finished</option>
          <option value="idle">Idle / saved</option>
        </select>
      </div>
      <div className="tarex-session-scroll">
        <ul ref={listRef} aria-label="Session activity">
          {rows.map((row) => row.kind === "terminal" ? (
            <TerminalSessionItem
              key={row.key}
              row={row}
              hidden={!visibleKeys.has(row.key)}
              selected={row.tabId === activeTabId && row.leafId === activeLeafId}
              onActivate={() => onActivate(row.tabId, row.leafId)}
              onKeyDown={navigateRows}
              onBusyChange={reportBusy}
            />
          ) : (
            <SessionItem
              key={row.key}
              row={row}
              hidden={!visibleKeys.has(row.key)}
              selected={false}
              onActivate={onOpenAi}
              onKeyDown={navigateRows}
            />
          ))}
        </ul>
        {visibleRows.length === 0 && (
          <div className="tarex-session-empty">
            <strong>{rows.length === 0 ? "No sessions yet" : "No matching sessions"}</strong>
            <p>{rows.length === 0
              ? "Open a terminal to see its activity here."
              : "Try another name, path, space, or state."}</p>
            {rows.length > 0 && (
              <button type="button" onClick={() => { setFilter("all"); clearSearch(); }}>
                Reset filters
              </button>
            )}
          </div>
        )}
      </div>
      <p className="tarex-session-footnote">All spaces · Attention first</p>
    </section>
  );
}

type ItemProps = {
  row: ActivitySessionRow;
  hidden: boolean;
  selected: boolean;
  onActivate: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

function TerminalSessionItem({
  row, onBusyChange, ...props
}: Omit<ItemProps, "row"> & {
  row: TerminalSessionRow;
  onBusyChange: (leafId: number, busy: boolean) => void;
}) {
  const busy = useTerminalBusy(row.private || row.cold ? null : row.leafId);
  // Filtered rows stay mounted so a command transition can bring them back.
  useEffect(() => onBusyChange(row.leafId, busy), [row.leafId, busy, onBusyChange]);
  useEffect(() => () => onBusyChange(row.leafId, false), [row.leafId, onBusyChange]);
  return <SessionItem {...props} row={row} />;
}

function SessionItem({ row, hidden, selected, onActivate, onKeyDown }: ItemProps) {
  const context = [row.tabTitle, row.space, row.pane].filter(Boolean).join(" · ");
  const description = row.kind === "local"
    ? row.phase === "attention" ? "Approve a tool to continue" : "Open AI conversation"
    : row.private ? "Details hidden" : row.cwd ?? (row.phase === "saved" ? "Open to restore terminal" : "Open terminal");
  return (
    <li hidden={hidden}>
      <button
        type="button"
        className="tarex-session-row"
        data-phase={row.phase}
        aria-current={selected ? "true" : undefined}
        onClick={onActivate}
        onKeyDown={onKeyDown}
        title={[row.title, row.stateLabel, context, description].filter(Boolean).join("\n")}
      >
        <span className="tarex-session-titleline">
          <span className="tarex-session-indicator" aria-hidden="true" />
          <strong>{row.title}</strong>
          <span className="tarex-session-state">{row.stateLabel}</span>
        </span>
        {context && <span className="tarex-session-context">{context}</span>}
        <span className="tarex-session-description">{description}</span>
        {selected && <span className="tarex-session-current">Current pane</span>}
      </button>
    </li>
  );
}
