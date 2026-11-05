import {
  CONNECTION_LIMIT,
  CONNECTION_POLL_MS,
  CONNECTION_STALE_MS,
  createConnectionMonitor,
  filterConnections,
  formatEndpoint,
  parseConnectionSnapshot,
  type ConnectionMonitorState,
  type NetworkConnection,
} from "@/modules/desktop/networkConnectionModel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connection = (fields: Partial<NetworkConnection> = {}): NetworkConnection => ({
  id: "42/tcp",
  processName: "test-client",
  pid: 42,
  localAddress: "192.168.1.2",
  localPort: 51000,
  remoteAddress: "203.0.113.10",
  remotePort: 443,
  state: "ESTABLISHED",
  loopback: false,
  ...fields,
});

const snapshot = (connections = [connection()]) => ({
  connections,
  total: connections.length,
  truncated: false,
  sampledAt: Date.now(),
  partial: false,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("connection presentation", () => {
  it.each<[string, number, string]>([
    ["203.0.113.8", 443, "203.0.113.8:443"],
    ["::1", 8080, "[::1]:8080"],
    ["2001:db8::1", 443, "[2001:db8::1]:443"],
    ["[2001:db8::1]", 443, "[2001:db8::1]:443"],
    ["fe80::1%en0", 80, "[fe80::1%en0]:80"],
    ["::ffff:127.0.0.1", 5000, "[::ffff:127.0.0.1]:5000"],
  ])("formats %s without inferring HTTP", (address, port, expected) => {
    expect(formatEndpoint(address, port)).toBe(expected);
  });

  it("keeps LAN, ULA and link-local addresses when excluding native loopback rows", () => {
    const retained = ["192.168.1.5", "10.0.0.2", "172.16.2.4", "fd00::2", "fe80::1%en0"]
      .map((remoteAddress) => connection({ id: remoteAddress, remoteAddress }));
    const loopback = ["127.0.0.1", "127.12.0.2", "::1", "::ffff:127.0.0.1"]
      .map((remoteAddress) => connection({ id: remoteAddress, remoteAddress, loopback: true }));
    const all = [...retained, ...loopback];
    expect(filterConnections(all, "", false)).toEqual(retained);
    expect(filterConnections(all, "", true)).toEqual(all);
    expect(filterConnections(loopback, "127", false)).toEqual([]);
  });

  it("searches process, PID and both endpoints case-insensitively with combined terms", () => {
    const rows = [connection({ remoteAddress: "2001:db8::5", processName: "Node" })];
    for (const query of ["NODE", "42", "192.168.1.2:51000", "[2001:db8::5]:443", "node 443"]) {
      expect(filterConnections(rows, query, false)).toEqual(rows);
    }
    expect(filterConnections(rows, "node 9999", false)).toEqual([]);
    expect(filterConnections([connection({ pid: null, processName: null })], "node", false)).toEqual([]);
  });

  it("retains uppercase TCP states, unknown owners and legitimate PID zero", () => {
    const rows = [
      connection({ id: "closing", state: "FIN_WAIT_1", processName: null, pid: null }),
      connection({ id: "kernel", state: "SYN_RECEIVED", processName: null, pid: 0 }),
      connection(),
    ];
    const result = parseConnectionSnapshot(snapshot(rows));
    expect(result.connections[0].state).toBe("ESTABLISHED");
    expect(result.connections).toContainEqual(rows[0]);
    expect(result.connections).toContainEqual(rows[1]);
  });

  it("bounds retained rows and reports malformed or duplicate entries as partial", () => {
    const rows = Array.from({ length: CONNECTION_LIMIT + 20 }, (_, index) => connection({ id: String(index) }));
    const bounded = parseConnectionSnapshot(snapshot(rows));
    expect(bounded.connections).toHaveLength(CONNECTION_LIMIT);
    expect(bounded.total).toBe(CONNECTION_LIMIT + 20);
    expect(bounded.truncated).toBe(true);
    const malformed = parseConnectionSnapshot({ ...snapshot(), connections: [connection(), connection(), { ...connection(), id: "bad", remotePort: 99999 }] });
    expect(malformed.connections).toHaveLength(1);
    expect(malformed.partial).toBe(true);
  });

  it("rejects invalid timestamps and malformed envelopes rather than pretending empty", () => {
    for (const sampledAt of [NaN, Infinity, -1, 9e15]) {
      expect(() => parseConnectionSnapshot({ ...snapshot(), sampledAt })).toThrow();
    }
    expect(() => parseConnectionSnapshot({ connections: [] })).toThrow();
  });
});

describe("connection snapshot lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("waits for visibility and spaces requests after completion without overlap", async () => {
    const pending = deferred<unknown>();
    const read = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(async () => snapshot());
    const monitor = createConnectionMonitor(read);
    const owner = monitor.attach(vi.fn(), () => true);
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS * 2);
    expect(read).not.toHaveBeenCalled();
    owner.setVisible(true);
    owner.refresh();
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    owner.dispose();
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a hidden generation after showing again and schedules no hidden work", async () => {
    const pending = deferred<unknown>();
    const read = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(async () => snapshot());
    const change = vi.fn<(state: ConnectionMonitorState) => void>();
    const owner = createConnectionMonitor(read).attach(change, () => true);
    owner.setVisible(true);
    owner.setVisible(false);
    await vi.advanceTimersByTimeAsync(CONNECTION_STALE_MS * 3);
    expect(vi.getTimerCount()).toBe(0);
    owner.setVisible(true);
    pending.resolve(snapshot([connection({ id: "obsolete" })]));
    await vi.advanceTimersByTimeAsync(0);
    expect(change.mock.lastCall?.[0].snapshot).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS);
    expect(change.mock.lastCall?.[0].snapshot?.connections[0].id).toBe("42/tcp");
    owner.dispose();
  });

  it("shares one in-flight read across remounts without retaining old observers", async () => {
    const pending = deferred<unknown>();
    const read = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(async () => snapshot());
    const monitor = createConnectionMonitor(read);
    const original = vi.fn();
    const first = monitor.attach(original, () => true);
    first.setVisible(true);
    first.dispose();
    original.mockClear();
    const replacement = vi.fn<(state: ConnectionMonitorState) => void>();
    const second = monitor.attach(replacement, () => true);
    second.setVisible(true);
    second.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(original).not.toHaveBeenCalled();
    expect(replacement.mock.lastCall?.[0].snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(replacement.mock.lastCall?.[0].snapshot).not.toBeNull();
    second.dispose();
  });

  it("rechecks actual presentation before queued work and acceptance", async () => {
    let visible = true;
    const pending = deferred<unknown>();
    const read = vi.fn(() => pending.promise);
    const change = vi.fn<(state: ConnectionMonitorState) => void>();
    const owner = createConnectionMonitor(read).attach(change, () => visible);
    owner.setVisible(true);
    visible = false;
    pending.resolve(snapshot());
    await vi.advanceTimersByTimeAsync(CONNECTION_STALE_MS * 2);
    expect(change.mock.lastCall?.[0].snapshot).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    owner.dispose();
  });

  it("keeps failed refresh data stale, stops automatic retries, and allows Retry", async () => {
    const read = vi.fn().mockImplementationOnce(async () => snapshot()).mockRejectedValueOnce(new Error("Access unavailable")).mockImplementation(async () => snapshot());
    const change = vi.fn<(state: ConnectionMonitorState) => void>();
    const owner = createConnectionMonitor(read).attach(change, () => true);
    owner.setVisible(true);
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS);
    expect(change.mock.lastCall?.[0]).toMatchObject({ busy: false, stale: true, error: "Access unavailable" });
    expect(change.mock.lastCall?.[0].snapshot).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CONNECTION_STALE_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
    owner.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(change.mock.lastCall?.[0]).toMatchObject({ busy: false, stale: false, error: "" });
    owner.dispose();
  });

  it("marks old data stale while a request hangs without starting more requests", async () => {
    const pending = deferred<unknown>();
    const read = vi.fn().mockImplementationOnce(async () => snapshot()).mockImplementation(() => pending.promise);
    const change = vi.fn<(state: ConnectionMonitorState) => void>();
    const owner = createConnectionMonitor(read).attach(change, () => true);
    owner.setVisible(true);
    await vi.advanceTimersByTimeAsync(CONNECTION_STALE_MS);
    expect(change.mock.lastCall?.[0]).toMatchObject({ busy: true, stale: true });
    expect(read).toHaveBeenCalledTimes(2);
    owner.dispose();
    pending.resolve(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
