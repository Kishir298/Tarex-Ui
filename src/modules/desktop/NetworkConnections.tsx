import {
  CONNECTION_ROW_LIMIT,
  connectionError,
  createConnectionMonitor,
  filterConnections,
  formatEndpoint,
  type ConnectionMonitorState,
} from "@/modules/desktop/networkConnectionModel";
import {
  subscribeWindowPresentation,
  terminalWindowPresentation,
} from "@/modules/terminal/ghostty/windowPresentation";
import { writeTerminalClipboard } from "@/modules/terminal/lib/terminalClipboard";
import "@/styles/network-connections.css";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";

const monitor = createConnectionMonitor(() => invoke("network_connections"));
type Controller = ReturnType<typeof monitor.attach>;
type CopyState = { kind: "pending" | "copied" | "error"; message: string } | null;

export function NetworkConnections() {
  const headingId = useId();
  const filterId = useId();
  const [state, setState] = useState<ConnectionMonitorState>({
    snapshot: null,
    busy: false,
    visible: false,
    stale: false,
    error: "",
  });
  const [query, setQuery] = useState("");
  const [includeLocalhost, setIncludeLocalhost] = useState(false);
  const [copy, setCopy] = useState<CopyState>(null);
  const controller = useRef<Controller | null>(null);
  const copyGeneration = useRef(0);
  const copyPending = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 601px)");
    const presented = () =>
      media.matches && terminalWindowPresentation().visible;
    const owner = monitor.attach(setState, presented);
    controller.current = owner;
    const sync = () => {
      const visible = presented();
      owner.setVisible(visible);
      if (!visible) {
        copyGeneration.current++;
        setCopy(null);
      }
    };
    media.addEventListener("change", sync);
    const unsubscribe = subscribeWindowPresentation(sync);
    return () => {
      copyGeneration.current++;
      controller.current = null;
      owner.dispose();
      media.removeEventListener("change", sync);
      unsubscribe();
    };
  }, []);

  const copyEndpoint = async (endpoint: string) => {
    const owner = controller.current;
    if (!owner || !state.visible || copyPending.current) return;
    const generation = ++copyGeneration.current;
    const current = () =>
      controller.current === owner &&
      copyGeneration.current === generation &&
      terminalWindowPresentation().visible &&
      window.matchMedia("(min-width: 601px)").matches;
    copyPending.current = true;
    setCopy({ kind: "pending", message: "Copying endpoint…" });
    try {
      await writeTerminalClipboard(endpoint);
      if (current())
        setCopy({ kind: "copied", message: `Copied ${endpoint}` });
    } catch (error) {
      if (current())
        setCopy({
          kind: "error",
          message: `Copy failed: ${connectionError(error)}`,
        });
    } finally {
      copyPending.current = false;
    }
  };

  const { snapshot, busy, error, stale, visible } = state;
  const filtered = filterConnections(
    snapshot?.connections ?? [],
    query,
    includeLocalhost,
  );
  const rows = filtered.slice(0, CONNECTION_ROW_LIMIT);
  const sampled = snapshot ? new Date(snapshot.sampledAt) : null;
  const summary = !visible
    ? "Updates paused"
    : error
      ? snapshot
        ? "Stale / sample failed"
        : "Sample failed"
      : stale
        ? snapshot
          ? "Stale snapshot"
          : "Snapshot delayed"
        : busy
          ? snapshot
            ? "Refreshing…"
            : "Reading system…"
          : snapshot
            ? "Auto / 10s"
            : "Waiting for sample";

  return (
    <section className="terex-connections" aria-labelledby={headingId}>
      <header className="terex-connections-heading">
        <h3 id={headingId}>CONNECTIONS</h3>
        <span title="TCP connections in the retained sample">
          {snapshot ? snapshot.connections.length : "--"}
        </span>
      </header>
      <div className="terex-connections-toolbar">
        <span>TCP / OS snapshot</span>
        <button
          type="button"
          disabled={busy || !visible}
          onClick={() => controller.current?.refresh()}
          aria-label={
            error ? "Retry connection snapshot" : "Refresh connection snapshot"
          }
        >
          {error ? "Retry" : "Refresh"}
        </button>
      </div>
      <div
        className="terex-connections-sample"
        role="status"
        aria-atomic="true"
        data-stale={stale || !!error}
      >
        <span>{summary}</span>
        {sampled ? (
          <time
            dateTime={sampled.toISOString()}
            title={sampled.toLocaleString()}
          >
            Sample {sampled.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })}
          </time>
        ) : null}
      </div>
      <label className="terex-connections-filter" htmlFor={filterId}>
        <span className="terex-connections-sr">
          Filter connections by process, PID or address
        </span>
        <input
          id={filterId}
          type="search"
          value={query}
          maxLength={256}
          placeholder="Process / address"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
      </label>
      <label className="terex-connections-localhost">
        <input
          type="checkbox"
          checked={includeLocalhost}
          onChange={(event) => setIncludeLocalhost(event.target.checked)}
        />
        <span>Include localhost</span>
      </label>
      {error ? (
        <p className="terex-connections-error" role="alert">
          {error} Use Retry.
        </p>
      ) : null}
      {snapshot?.partial ? (
        <p className="terex-connections-note">
          Partial sample. Some connections or process details are unavailable.
        </p>
      ) : null}
      {snapshot?.truncated ? (
        <p className="terex-connections-note">
          Sample limited: {snapshot.connections.length} of {snapshot.total}
          {" "}reported connections. Filter searches this sample.
        </p>
      ) : null}
      {rows.length ? (
        <section
          className="terex-connections-scroll"
          aria-label="TCP connection list"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded list needs a keyboard scroll target.
          tabIndex={0}
        >
          <ul className="terex-connections-list">
            {rows.map((connection) => {
              const remote = formatEndpoint(
                connection.remoteAddress,
                connection.remotePort,
              );
              const local = formatEndpoint(
                connection.localAddress,
                connection.localPort,
              );
              const process =
                connection.processName ??
                (connection.pid !== null
                  ? `PID ${connection.pid}`
                  : "Unknown process");
              return (
                <li
                  key={connection.id}
                  className="terex-connection"
                  data-established={connection.state === "ESTABLISHED"}
                >
                  <div className="terex-connection-process">
                    <strong title={process}>{process}</strong>
                    {connection.processName !== null &&
                    connection.pid !== null ? (
                      <span title="Process ID">{connection.pid}</span>
                    ) : null}
                  </div>
                  <div className="terex-connection-endpoint">
                    <code title={remote}>{remote}</code>
                    <button
                      type="button"
                      title={`Copy ${remote}`}
                      aria-label={`Copy remote endpoint ${remote} for ${process}`}
                      disabled={!visible || copy?.kind === "pending"}
                      onClick={() => void copyEndpoint(remote)}
                    >
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                        <path d="M10.5 3.5v-1h-8v8h1" />
                      </svg>
                    </button>
                  </div>
                  <details className="terex-connection-detail">
                    <summary
                      aria-label={`Details for ${process}, ${remote}, ${connection.state}`}
                    >
                      <span className="terex-connection-state">
                        {connection.state}
                      </span>
                      <span
                        className="terex-connection-expand"
                        aria-hidden="true"
                      >
                        +
                      </span>
                    </summary>
                    <dl>
                      <div>
                        <dt>REMOTE</dt>
                        <dd>{remote}</dd>
                      </div>
                      <div>
                        <dt>LOCAL</dt>
                        <dd>{local}</dd>
                      </div>
                      <div>
                        <dt>PID</dt>
                        <dd>{connection.pid ?? "Unavailable"}</dd>
                      </div>
                      <div>
                        <dt>PROCESS</dt>
                        <dd>{connection.processName ?? "Unavailable"}</dd>
                      </div>
                      {connection.loopback ? (
                        <div>
                          <dt>SCOPE</dt>
                          <dd>Localhost</dd>
                        </div>
                      ) : null}
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      ) : snapshot ? (
        <p className="terex-connections-empty">
          {query.trim()
            ? "No matches in this sample."
            : includeLocalhost
              ? "No TCP connections in this sample."
              : "No non-localhost TCP connections in this sample."}
        </p>
      ) : !error ? (
        <p className="terex-connections-empty">
          {busy ? "Waiting for system data…" : "No sample yet."}
        </p>
      ) : null}
      {snapshot ? (
        <p className="terex-connections-count">
          {rows.length} shown / {filtered.length} matching
          {filtered.length > rows.length ? ". Narrow the filter to see more." : ""}
        </p>
      ) : null}
      {copy ? (
        <p
          className="terex-connections-copy-status"
          data-error={copy.kind === "error"}
          role="status"
        >
          {copy.message}
        </p>
      ) : null}
    </section>
  );
}
