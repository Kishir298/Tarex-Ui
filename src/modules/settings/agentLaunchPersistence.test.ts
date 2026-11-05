import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  listeners: new Set<(key: string, value: unknown) => void>(),
  save: vi.fn(async () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@/lib/appData", () => ({ appDataFile: (name: string) => name }));
vi.mock("@tauri-apps/api/event", () => ({ emit: fixture.emit, listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async entries() { return [...fixture.values]; }
    async set(key: string, value: unknown) { fixture.values.set(key, value); for (const notify of fixture.listeners) notify(key, value); }
    save = fixture.save;
    async onChange(notify: (key: string, value: unknown) => void) { fixture.listeners.add(notify); return () => fixture.listeners.delete(notify); }
  },
}));

beforeEach(() => { fixture.values.clear(); fixture.listeners.clear(); fixture.save.mockClear(); fixture.emit.mockClear(); vi.resetModules(); });

describe("saved terminal agent setup", () => {
  it("survives a fresh store/window initialization and announces changes to the other window", async () => {
    const first = await import("@/modules/settings/store");
    const changed = vi.fn();
    const stop = await first.onPreferencesChange(changed);
    await first.setAgentLaunchDefaults({ agent: "opencode", instances: 3 });
    await first.setAgentLaunchCommands({ ...first.DEFAULT_PREFERENCES.agentLaunchCommands, opencode: "opencode --continue" });
    expect(changed).toHaveBeenCalledWith("agentLaunchDefaults", { agent: "opencode", instances: 3 });
    expect(fixture.emit).toHaveBeenCalledWith("terax://prefs-changed", { key: "agentLaunchDefaults", value: { agent: "opencode", instances: 3 } });
    stop();
    vi.resetModules();
    const second = await import("@/modules/settings/store");
    const restored = await second.loadPreferences();
    expect(restored.agentLaunchDefaults).toEqual({ agent: "opencode", instances: 3 });
    expect(restored.agentLaunchCommands.opencode).toBe("opencode --continue");
    expect(restored.agentLaunchCommands.claude).toBe("claude");
  });

  it("propagates storage failure instead of broadcasting a successful save", async () => {
    const store = await import("@/modules/settings/store");
    fixture.save.mockRejectedValueOnce(new Error("Disk full"));
    await expect(store.setAgentLaunchDefaults({ agent: "codex", instances: 1 })).rejects.toThrow("Disk full");
    expect(fixture.emit).not.toHaveBeenCalled();
  });
});
