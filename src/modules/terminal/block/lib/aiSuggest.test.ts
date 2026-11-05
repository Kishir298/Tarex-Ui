import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prefs: { terminalSuggestions: true, customEndpoints: {} },
  chat: {
    selectedModelId: "compat-test",
    apiKeys: {}, customEndpointKeys: {},
    live: { isActiveTerminalPrivate: (): boolean => false },
  },
  build: vi.fn(), generate: vi.fn(),
}));
vi.mock("@/modules/settings/preferences", () => ({ usePreferencesStore: { getState: () => mocks.prefs } }));
vi.mock("@/modules/ai/store/chatStore", () => ({ useChatStore: { getState: () => mocks.chat } }));
vi.mock("@/modules/ai/config", () => ({ isCompatModelId: (id: string) => id.startsWith("compat-") }));
vi.mock("@/modules/ai/lib/agent", () => ({ buildConfiguredLanguageModel: mocks.build }));
vi.mock("ai", () => ({ generateText: mocks.generate }));

import { suggestCommand } from "@/modules/terminal/block/lib/aiSuggest";

beforeEach(() => {
  vi.useFakeTimers();
  mocks.build.mockReset().mockResolvedValue({});
  mocks.generate.mockReset().mockResolvedValue({ text: "git status" });
  mocks.prefs = { terminalSuggestions: true, customEndpoints: {} };
  mocks.chat = { selectedModelId: "compat-test", apiKeys: {}, customEndpointKeys: {}, live: { isActiveTerminalPrivate: () => false } };
});
afterEach(() => vi.useRealTimers());

describe("terminal AI privacy and stale guards", () => {
  it("does not resolve credentials or call providers on module load", () => {
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("excludes private terminals, disabled AI and sensitive command prefixes", async () => {
    mocks.chat.live.isActiveTerminalPrivate = () => true;
    expect(await suggestCommand("git", "/work")).toBeNull();
    mocks.chat.live.isActiveTerminalPrivate = () => false;
    mocks.prefs.terminalSuggestions = false;
    expect(await suggestCommand("git", "/work")).toBeNull();
    mocks.prefs.terminalSuggestions = true;
    expect(await suggestCommand("curl --token secret", "/work")).toBeNull();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("rejects a changed model before resolving credentials", async () => {
    const pending = suggestCommand("git", "/work");
    mocks.chat = { ...mocks.chat, selectedModelId: "compat-other" };
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(mocks.build).not.toHaveBeenCalled();
  });
  it("checks ownership again after asynchronous credential/model construction", async () => {
    let finish!: (model: object) => void;
    mocks.build.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let current = true;
    const pending = suggestCommand("git", "/work", undefined, () => current);
    await vi.runAllTimersAsync();
    expect(mocks.build).toHaveBeenCalledTimes(1);
    current = false; finish({});
    expect(await pending).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("clears the debounce on cancellation", async () => {
    const controller = new AbortController();
    const pending = suggestCommand("git", "/work", controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.build).not.toHaveBeenCalled();
  });
});
