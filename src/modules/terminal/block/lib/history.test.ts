import { expect, it, vi } from "vitest";
import { historyRecord } from "@/modules/terminal/block/lib/history";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("never persists a private terminal command", () => {
  historyRecord("private command", true);
  expect(invoke).not.toHaveBeenCalled();
  historyRecord("git status", false);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("history_record", { command: "git status" });
});
