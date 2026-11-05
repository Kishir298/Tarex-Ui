import { readFile } from "node:fs/promises";
import { TeraxGhostty } from "@terax/ghostty-core/adapted";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AdaptedGhosttyTerminalModel } from "@/modules/terminal/ghostty/AdaptedGhosttyTerminalModel";
import { TerminalPrompt, insertPromptDraft } from "@/modules/terminal/ghostty/input/TerminalPrompt";
import { encodeTerminalPaste } from "@/modules/terminal/ghostty/input/terminalInputEncoding";

describe.each(["ghostty-vt", "ghostty-vt-scalar"])("raw shell prompt (%s)", (artifact) => {
  let core: TeraxGhostty;
  beforeAll(async () => {
    const bytes = await readFile(new URL(`../../../../../packages/ghostty-core/adapted/${artifact}.wasm`, import.meta.url));
    core = await TeraxGhostty.loadBytes(Uint8Array.from(bytes).buffer);
  });
  function create() {
    const prompt = new TerminalPrompt();
    const model = new AdaptedGhosttyTerminalModel(core, {
      backend: "ghostty-webgpu", cols: 40, rows: 8,
      onEvent: (event) => prompt.handle(event),
    });
    model.enableSemanticMarkers(true);
    const write = (text: string) => { model.write(new TextEncoder().encode(text)); prompt.output(); };
    return { prompt, model, write };
  }

  it("captures OSC B before echoed input in the same parse", () => {
    const { model, prompt, write } = create();
    try {
      write("\x1b]133;A\x07$ \x1b]133;B\x07git");
      expect(prompt.read(model)?.text).toBe("git");
      expect(prompt.isEmpty(model)).toBe(false);
    } finally { model.dispose(); }
  });

  it("preserves a restored draft after clear and prompt redraw in one parse", () => {
    const { model, prompt, write } = create();
    try {
      write("\x1b]133;A\x07$ \x1b]133;B\x07");
      prompt.input(model);
      write("git status");
      write("\x1b[2J\x1b[H\x1b]133;A\x07$ \x1b]133;B\x07git status");
      expect(prompt.read(model)?.text).toBe("git status");
      expect(prompt.isEmpty(model)).toBe(false);
    } finally { model.dispose(); }
  });

  it("refuses insertion and ghosts when an older core supplies no prompt pin", () => {
    const { model, prompt, write } = create();
    try {
      model.enableSemanticMarkers(false);
      write("\x1b]133;A\x07$ \x1b]133;B\x07git");
      expect(prompt.read(model)).toBeNull();
      expect(prompt.isEmpty(model)).toBe(false);
      expect(prompt.draft(model)).not.toBe("");
    } finally { model.dispose(); }
  });

  it("tracks hidden echo and restored drafts without rebuilding presentation buffers", () => {
    const { model, prompt, write } = create();
    try {
      write("\x1b]133;A\x07$ \x1b]133;B\x07");
      prompt.input(model);
      model.releasePresentationResources();
      const render = vi.spyOn(model, "renderCells");
      const cursor = vi.spyOn(model, "cursor");
      write("git");
      expect(prompt.draft(model)).toBe("git");
      write("\x1b[2J\x1b[H\x1b]133;A\x07$ \x1b]133;B\x07git status");
      expect(prompt.draft(model)).toBe("git status");
      expect(render).not.toHaveBeenCalled();
      expect(cursor).not.toHaveBeenCalled();
      expect(model.diagnostics().bridgeCellCapacity).toBe(0);
      expect(model.diagnostics().bridgeRowCapacity).toBe(0);
      expect(prompt.read(model)?.text).toBe("git status");
      expect(prompt.isEmpty(model)).toBe(false);
    } finally { model.dispose(); }
  });

  it("extracts only echoed input after OSC B, with native Unicode cell geometry", () => {
    const { model, prompt, write } = create();
    try {
      write("\x1b]133;A\x07\x1b[32mwork $ \x1b[0m\x1b]133;B\x07");
      expect(prompt.isEmpty(model)).toBe(true);
      prompt.input(model);
      expect(prompt.draft(model)).not.toBe("");
      write("echo 日本");
      expect(prompt.read(model)).toMatchObject({ text: "echo 日本", column: 16, atEnd: true });
      write("\x1b[D");
      expect(prompt.read(model)?.atEnd).toBe(false);
      expect(prompt.draft(model)).toBe("echo 日本");
      write("\x1b[C");
      expect(prompt.read(model)?.atEnd).toBe(true);
    } finally { model.dispose(); }
  });

  it("does not infer a prompt from ordinary output or mistake a title for input echo", () => {
    const { model, prompt, write } = create();
    try {
      write("fake $ ");
      expect(prompt.read(model)).toBeNull();
      write("\r\x1b[2K\x1b]133;A\x07$ \x1b]133;B\x07");
      prompt.input(model);
      write("\x1b]2;new title\x07");
      expect(prompt.isEmpty(model)).toBe(false);
      expect(prompt.draft(model)).not.toBe("");
      write("git");
      expect(prompt.read(model)?.text).toBe("git");
    } finally { model.dispose(); }
  });

  it("hides the ghost when the cursor moves left into trailing spaces", () => {
    const { model, prompt, write } = create();
    try {
      write("\x1b]133;A\x07$ \x1b]133;B\x07");
      prompt.input(model);
      write("git  ");
      expect(prompt.read(model)?.atEnd).toBe(true);
      write("\x1b[D");
      expect(prompt.read(model)?.atEnd).toBe(false);
      expect(prompt.draft(model)).toBe("git  ");
    } finally { model.dispose(); }
  });

  it("keeps multiline and alternate-screen input out of completion and retains a native pin through resize", () => {
    const { model, prompt, write } = create();
    try {
      write("\x1b]133;A\x07$ \x1b]133;B\x07");
      prompt.input(model);
      write("echo hello\r\ncontinued");
      expect(prompt.read(model)).toBeNull();
      expect(prompt.draft(model)).not.toBe("");
      write("\x1b]133;C\x07\x1b[?1049h");
      expect(prompt.read(model)).toBeNull();
      write("\x1b[?1049l\x1b]133;D;0\x07\r\n\x1b]133;A\x07$ \x1b]133;B\x07");
      expect(prompt.isEmpty(model)).toBe(true);
      model.resize(50, 8);
      expect(prompt.isEmpty(model)).toBe(true);
    } finally { model.dispose(); }
  });

  it("does not expose a continuation as an empty prompt", () => {
    const { model, prompt, write } = create();
    try {
      write("\x1b]133;A\x07$ \x1b]133;B\x07");
      prompt.input(model);
      write("echo '\r\n\x1b]133;A;k=s\x07> \x1b]133;B\x07");
      expect(prompt.isEmpty(model)).toBe(false);
    } finally { model.dispose(); }
  });
});

describe("command dock insertion", () => {
  it("inserts one bracketed paste without Enter or clearing input", async () => {
    const insert = vi.fn((text: string) => { expect(encodeTerminalPaste(text, true)).toBe("\x1b[200~git status\x1b[201~"); return true; });
    await insertPromptDraft("git status", () => true, async () => false, insert);
    expect(insert).toHaveBeenCalledExactlyOnceWith("git status");
  });
  it.each(["one\ntwo", "one\rtwo", "one\ttwo", "one\x1b[D", "\x00", "one\x7f", "one\u2028two", " "])("rejects unsafe command %j before native calls", async (text) => {
    const foreground = vi.fn(), insert = vi.fn();
    await expect(insertPromptDraft(text, () => true, foreground, insert)).rejects.toThrow();
    expect(foreground).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it("rechecks ownership, generation and typed input after the native await", async () => {
    let ready = true;
    const insert = vi.fn();
    await expect(insertPromptDraft("git status", () => ready, async () => { ready = false; return false; }, insert)).rejects.toThrow("preserved");
    expect(insert).not.toHaveBeenCalled();
  });
  it("fails closed on foreground activity and IPC errors", async () => {
    const insert = vi.fn();
    await expect(insertPromptDraft("git status", () => true, async () => true, insert)).rejects.toThrow();
    await expect(insertPromptDraft("git status", () => true, async () => { throw new Error("closed"); }, insert)).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
