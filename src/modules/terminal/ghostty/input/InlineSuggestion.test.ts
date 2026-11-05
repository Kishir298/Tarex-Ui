import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineSuggestion, suggestionSuffix, type SuggestionSnapshot } from "@/modules/terminal/ghostty/input/InlineSuggestion";

afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  let snapshot: SuggestionSnapshot | null = { prefix: "git", cwd: "/work", epoch: 1, configuration: {} };
  const history = vi.fn<() => Promise<string | null>>().mockResolvedValue("git status");
  const ai = vi.fn<(...args: unknown[]) => Promise<string | null>>().mockResolvedValue("git diff");
  const show = vi.fn(), insert = vi.fn(() => true);
  const suggestion = new InlineSuggestion({ snapshot: () => snapshot, history, ai, show, insert });
  return { suggestion, history, ai, show, insert, setSnapshot: (next: SuggestionSnapshot | null) => { snapshot = next; } };
}
const key = (key: string) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false });

describe("inline terminal suggestion", () => {
  it("prefers history, accepts only with right arrow, and leaves Tab to the shell", async () => {
    const { suggestion, ai, show, insert } = setup();
    suggestion.refresh();
    await vi.runAllTimersAsync();
    expect(show).toHaveBeenLastCalledWith(" status");
    expect(ai).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(suggestion.keyDown(key("Tab"))).toBe(false);
    expect(suggestion.keyDown(key("ArrowRight"))).toBe(true);
    expect(insert).toHaveBeenCalledExactlyOnceWith(" status");
    suggestion.dispose();
  });
  it("dismisses without transmitting Escape or refreshing the same input", async () => {
    const { suggestion, history, insert, show } = setup();
    suggestion.refresh(); await vi.runAllTimersAsync();
    expect(suggestion.keyDown(key("Escape"))).toBe(true);
    suggestion.refresh(); await vi.runAllTimersAsync();
    expect(history).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenLastCalledWith("");
    expect(insert).not.toHaveBeenCalled();
    suggestion.dispose();
  });
  it("never fetches on private, hidden, composing, selected or non-prompt snapshots", async () => {
    const { suggestion, setSnapshot, history, ai } = setup();
    setSnapshot(null);
    suggestion.refresh(); await vi.runAllTimersAsync();
    expect(history).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
    suggestion.dispose();
  });
  it("discards delayed history before any AI work when ownership changes", async () => {
    const { suggestion, setSnapshot, history, ai, show } = setup();
    let finish!: (result: string | null) => void;
    history.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    suggestion.refresh(); await vi.advanceTimersByTimeAsync(100);
    setSnapshot(null); suggestion.refresh(); finish(null);
    await vi.runAllTimersAsync();
    expect(ai).not.toHaveBeenCalled(); expect(show).toHaveBeenLastCalledWith("");
    suggestion.dispose();
  });
  it("aborts stale AI and cannot accept a result from a previous model/cwd/input", async () => {
    const { suggestion, history, ai, setSnapshot, show, insert } = setup();
    history.mockResolvedValue(null);
    let finish!: (result: string | null) => void;
    ai.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    suggestion.refresh(); await vi.advanceTimersByTimeAsync(100);
    const signal = ai.mock.calls[0][2] as AbortSignal;
    setSnapshot({ prefix: "git", cwd: "/other", epoch: 2, configuration: {} });
    suggestion.refresh();
    expect(signal.aborted).toBe(true);
    finish("git stale"); await Promise.resolve(); await Promise.resolve();
    expect(show).toHaveBeenLastCalledWith("");
    expect(suggestion.keyDown(key("ArrowRight"))).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    suggestion.dispose();
  });
  it("bounds and validates the displayed suffix", () => {
    expect(suggestionSuffix("git", "git status")).toBe(" status");
    for (const value of ["npm install", "git\nrm", "git\x1b[D", `git${"x".repeat(2000)}`, "git"]) expect(suggestionSuffix("git", value)).toBe("");
  });
});
