export const CONNECTION_POLL_MS = 10_000;
export const CONNECTION_STALE_MS = 30_000;
export const CONNECTION_LIMIT = 1024;
export const CONNECTION_ROW_LIMIT = 60;

export type NetworkConnection = {
  id: string;
  processName: string | null;
  pid: number | null;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  loopback: boolean;
};

export type ConnectionSnapshot = {
  connections: NetworkConnection[];
  total: number;
  truncated: boolean;
  sampledAt: number;
  partial: boolean;
};

export function formatEndpoint(address: string, port: number): string {
  const host =
    address.startsWith("[") && address.endsWith("]")
      ? address.slice(1, -1)
      : address;
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function filterConnections(
  connections: readonly NetworkConnection[],
  query: string,
  includeLocalhost: boolean,
): NetworkConnection[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return connections.filter((connection) => {
    // The OS collector identifies loopback; private LAN addresses stay visible.
    if (!includeLocalhost && connection.loopback) return false;
    if (!terms.length) return true;
    const text = [
      connection.processName ?? "",
      connection.pid ?? "",
      formatEndpoint(connection.localAddress, connection.localPort),
      formatEndpoint(connection.remoteAddress, connection.remotePort),
      connection.state,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function shortText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= limit
  );
}

function port(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 65535;
}

function validConnection(value: unknown): value is NetworkConnection {
  if (!record(value)) return false;
  return (
    shortText(value.id, 512) &&
    (value.processName === null || shortText(value.processName, 512)) &&
    (value.pid === null ||
      (Number.isSafeInteger(value.pid) && Number(value.pid) >= 0)) &&
    shortText(value.localAddress, 128) &&
    port(value.localPort) &&
    shortText(value.remoteAddress, 128) &&
    port(value.remotePort) &&
    shortText(value.state, 40) &&
    typeof value.loopback === "boolean"
  );
}

export function parseConnectionSnapshot(value: unknown): ConnectionSnapshot {
  if (
    !record(value) ||
    !Array.isArray(value.connections) ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0 ||
    typeof value.truncated !== "boolean" ||
    typeof value.partial !== "boolean" ||
    typeof value.sampledAt !== "number" ||
    !Number.isFinite(value.sampledAt) ||
    value.sampledAt <= 0 ||
    value.sampledAt > 8.64e15
  ) {
    throw new Error("Invalid connection snapshot from the system.");
  }
  const connections: NetworkConnection[] = [];
  const ids = new Set<string>();
  let partial = value.partial;
  for (const entry of value.connections.slice(0, CONNECTION_LIMIT)) {
    if (!validConnection(entry) || ids.has(entry.id)) {
      partial = true;
      continue;
    }
    ids.add(entry.id);
    connections.push({
      id: entry.id,
      processName: entry.processName,
      pid: entry.pid,
      localAddress: entry.localAddress,
      localPort: entry.localPort,
      remoteAddress: entry.remoteAddress,
      remotePort: entry.remotePort,
      state: entry.state,
      loopback: entry.loopback,
    });
  }
  connections.sort(
    (a, b) =>
      Number(b.state === "ESTABLISHED") - Number(a.state === "ESTABLISHED") ||
      (a.processName ?? "").localeCompare(b.processName ?? "") ||
      a.id.localeCompare(b.id),
  );
  return {
    connections,
    total: Math.max(Number(value.total), value.connections.length),
    truncated: value.truncated || value.connections.length > CONNECTION_LIMIT,
    sampledAt: value.sampledAt,
    partial,
  };
}

export function connectionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

export type ConnectionMonitorState = {
  snapshot: ConnectionSnapshot | null;
  busy: boolean;
  visible: boolean;
  stale: boolean;
  error: string;
};

// One rail owns the observer. Native IPC survives unmount, without retaining its React owner.
export function createConnectionMonitor(read: () => Promise<unknown>) {
  let state: ConnectionMonitorState = {
    snapshot: null,
    busy: false,
    visible: false,
    stale: false,
    error: "",
  };
  let observer: ((state: ConnectionMonitorState) => void) | null = null;
  let isPresented = () => false;
  let owner = 0;
  let generation = 0;
  let pending = false;
  let lastCompleted = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = (update: Partial<ConnectionMonitorState>) => {
    state = { ...state, ...update };
    observer?.(state);
  };
  const active = () => observer !== null && state.visible && isPresented();
  const stopTimers = () => {
    clearTimeout(timer);
    clearTimeout(staleTimer);
  };
  const watchAge = () => {
    clearTimeout(staleTimer);
    if (!active()) return;
    const age = state.snapshot ? Date.now() - state.snapshot.sampledAt : 0;
    if (age >= CONNECTION_STALE_MS) {
      emit({ stale: true });
    } else {
      staleTimer = setTimeout(() => {
        if (active()) emit({ stale: true });
      }, CONNECTION_STALE_MS - Math.max(0, age));
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (active() && !state.error) timer = setTimeout(sample, CONNECTION_POLL_MS);
  };
  const sample = async () => {
    if (!active() || pending) return;
    clearTimeout(timer);
    pending = true;
    const current = generation;
    emit({ busy: true, error: "" });
    watchAge();
    try {
      const reply = await read();
      if (current !== generation || !active()) return;
      const snapshot = parseConnectionSnapshot(reply);
      emit({
        snapshot,
        stale: Date.now() - snapshot.sampledAt >= CONNECTION_STALE_MS,
      });
    } catch (error) {
      if (current === generation && active())
        emit({ error: connectionError(error), stale: state.snapshot !== null });
    } finally {
      pending = false;
      lastCompleted = Date.now();
      emit({ busy: false });
      // Failed samples wait for Retry. Obsolete samples resume at the regular cadence.
      schedule();
      if (state.snapshot) watchAge();
    }
  };

  return {
    attach(
      listener: (state: ConnectionMonitorState) => void,
      presented: () => boolean,
    ) {
      stopTimers();
      const identity = ++owner;
      generation++;
      observer = listener;
      isPresented = presented;
      state = { ...state, visible: false, busy: pending };
      listener(state);
      return {
        setVisible(visible: boolean) {
          if (identity !== owner || visible === state.visible) return;
          generation++;
          stopTimers();
          emit({ visible });
          if (!visible) return;
          watchAge();
          if (pending || state.error) return;
          const remaining = lastCompleted + CONNECTION_POLL_MS - Date.now();
          if (remaining > 0) timer = setTimeout(sample, remaining);
          else void sample();
        },
        refresh() {
          if (identity === owner) void sample();
        },
        dispose() {
          if (identity !== owner) return;
          generation++;
          observer = null;
          isPresented = () => false;
          state = { ...state, visible: false };
          stopTimers();
        },
      };
    },
  };
}
