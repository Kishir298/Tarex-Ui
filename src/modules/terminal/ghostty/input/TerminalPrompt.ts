import type { GhosttyTerminalEvent } from "@terax/ghostty-core/protocol";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";

export type PromptLine = {
  text: string;
  line: number;
  column: number;
  row: number;
  atEnd: boolean;
};

const UNKNOWN_DRAFT = "\ufffc";
const MAX_DRAFT_CELLS = 8192;

/** Observes shell markers and the model, never predicts readline edits. */
export class TerminalPrompt {
  private marker: number | null = null;
  private active = false;
  private continuation = false;
  private dirty = false;
  private awaitingEcho = false;
  private beforeInput: PromptLine | null = null;
  private revision = 0;
  private cached: PromptLine | null = null;
  private cachedEpoch = -1;
  private cachedModelRevision = -1;
  private cachedOrigin = -1;

  get epoch(): number { return this.revision; }

  handle(event: GhosttyTerminalEvent): void {
    switch (event.type) {
      case "prompt-start":
        this.active = false;
        break;
      case "prompt-end":
        this.marker = event.marker ?? null;
        this.active = !this.continuation;
        this.awaitingEcho = false;
        this.beforeInput = null;
        break;
      case "prompt-continuation":
        this.continuation = true;
        this.active = false;
        this.dirty = true;
        break;
      case "end-of-input":
      case "end-of-command":
      case "screen-cleared":
      case "overflow":
        this.reset();
        break;
    }
    this.revision++;
  }

  input(model?: GhosttyTerminalModelApi): void {
    if (!this.awaitingEcho) this.beforeInput = model ? this.read(model) : null;
    this.dirty = true;
    this.awaitingEcho = true;
    this.revision++;
  }

  submitted(): void {
    this.active = false;
    this.revision++;
  }

  output(): void {
    this.revision++;
  }

  read(model: GhosttyTerminalModelApi): PromptLine | null {
    const line = this.readLine(model);
    if (this.awaitingEcho) {
      if (!this.active || (line && this.beforeInput &&
          (line.text !== this.beforeInput.text || line.column !== this.beforeInput.column || line.line !== this.beforeInput.line))) {
        this.awaitingEcho = false;
        this.beforeInput = null;
      }
    }
    return this.awaitingEcho ? null : line;
  }

  private readLine(model: GhosttyTerminalModelApi): PromptLine | null {
    const anchor = this.anchor(model);
    if (!this.active || !anchor || this.continuation ||
        model.isDisposed?.() || model.modes().alternateScreen ||
        model.modes().mouseTracking) return null;
    const line = model.bufferCursorLine?.();
    const cursor = model.cursor();
    if (line !== anchor.line || cursor.x < anchor.column ||
        model.cols > MAX_DRAFT_CELLS) return null;
    const origin = model.viewportOriginLine();
    const row = line - origin;
    if (row < 0 || row >= model.rows) return null;
    const modelRevision = model.revision();
    if (this.cachedEpoch === this.revision && this.cachedModelRevision === modelRevision &&
        this.cachedOrigin === origin) return this.cached;
    const cells = model.renderCells();
    let end = cursor.x;
    for (let col = anchor.column; col < model.cols; col++) {
      const index = row * model.cols + col;
      if (cells.codepoint(index)) end = Math.max(end, col + Math.max(1, cells.width(index)));
    }
    let text = "";
    for (let col = anchor.column; col < Math.min(model.cols, end); col++) {
      const index = row * model.cols + col;
      if (cells.width(index) === 0) continue;
      const codepoint = cells.codepoint(index);
      text += cells.graphemeLength(index) > 0 ? model.grapheme(row, col) :
        codepoint ? String.fromCodePoint(codepoint) : " ";
    }
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) return null;
    this.cachedEpoch = this.revision;
    this.cachedModelRevision = modelRevision;
    this.cachedOrigin = origin;
    this.cached = {
      text, line, column: cursor.x,
      row,
      atEnd: cursor.x === end && cursor.visible && cursor.x < model.cols - 1,
    };
    return this.cached;
  }

  draft(model: GhosttyTerminalModelApi): string {
    if (!this.awaitingEcho && this.cached && this.cachedEpoch === this.revision &&
        this.cachedModelRevision === model.revision()) return this.cached.text;
    const anchor = this.active && this.anchor(model);
    if (anchor && model.readTextRange && !model.modes().alternateScreen) {
      const text = model.readTextRange(anchor.line, anchor.line, anchor.column, model.cols - 1);
      if (text) return text;
    }
    return this.dirty || (this.active && !anchor) ? UNKNOWN_DRAFT : "";
  }

  isEmpty(model: GhosttyTerminalModelApi): boolean {
    const line = this.read(model);
    return !!line && line.atEnd && line.text === "" && !this.awaitingEcho;
  }

  reset(): void {
    this.marker = null;
    this.beforeInput = null;
    this.cached = null;
    this.active = this.continuation = this.dirty = this.awaitingEcho = false;
    this.revision++;
  }

  private anchor(model: GhosttyTerminalModelApi): { line: number; column: number } | null {
    if (this.marker === null || model.isDisposed?.()) return null;
    const line = model.semanticMarkerLine?.(this.marker);
    const column = model.semanticMarkerColumn?.(this.marker);
    return line == null || column == null ? null : { line, column };
  }
}

export function singleLineCommand(text: string): boolean {
  return text.trim().length > 0 && text.length <= 8192 &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text);
}

export async function insertPromptDraft(
  text: string,
  ready: () => boolean,
  foreground: () => Promise<boolean>,
  insert: (text: string) => boolean,
): Promise<void> {
  if (!singleLineCommand(text)) throw new Error("Choose a single-line command without control characters.");
  if (!ready()) throw new Error("The terminal needs an empty shell prompt.");
  const busy = await foreground();
  if (busy !== false || !ready()) throw new Error("The terminal changed or is busy. Its input was preserved.");
  if (!insert(text)) throw new Error("The terminal could not accept the command draft.");
}
