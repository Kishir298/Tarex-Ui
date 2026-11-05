import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { TerminalStack } from "@/modules/terminal/TerminalStack";

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (state: unknown) => unknown) => select({ terminalSuggestions: true, customTerminalPrompts: true }),
}));
vi.mock("@/modules/terminal/PaneTreeView", () => ({
  PaneTreeView: ({ node, blocks }: { node: { id: number }; blocks: boolean }) => createElement("span", { "data-leaf": node.id, "data-blocks": String(blocks) }),
}));

describe("terminal presentation mode", () => {
  it("keeps ordinary and private terminals plain when suggestions are enabled, and only decorates explicit Blocks tabs", () => {
    const tabs: Tab[] = [
      { id: 1, kind: "terminal", title: "shell", spaceId: "default", paneTree: { kind: "leaf", id: 10 }, activeLeafId: 10 },
      { id: 2, kind: "terminal", title: "blocks", blocks: true, spaceId: "default", paneTree: { kind: "leaf", id: 20 }, activeLeafId: 20 },
      { id: 3, kind: "terminal", title: "private", private: true, spaceId: "default", paneTree: { kind: "leaf", id: 30 }, activeLeafId: 30 },
      { id: 4, kind: "terminal", title: "saved", cold: true, blocks: true, spaceId: "default", paneTree: { kind: "leaf", id: 40 }, activeLeafId: 40 },
    ];
    const html = renderToStaticMarkup(createElement(TerminalStack, {
      tabs, activeId: 1, registerHandle: vi.fn(), onSearchReady: vi.fn(), onCwd: vi.fn(), onExit: vi.fn(), onFocusLeaf: vi.fn(),
    }));
    expect(html).toContain('data-leaf="10" data-blocks="false"');
    expect(html).toContain('data-leaf="20" data-blocks="true"');
    expect(html).toContain('data-leaf="30" data-blocks="false"');
    expect(html).not.toContain('data-leaf="40"');
  });
});
