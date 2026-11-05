import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { suggestCommand } from "@/modules/terminal/block/lib/aiSuggest";
import { historySuggest } from "@/modules/terminal/block/lib/history";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import type { TerminalFontMetrics } from "@/modules/terminal/ghostty/gpu/terminalVisuals";
import { bindTerminalWindowFocus, terminalWindowFocused } from "@/modules/terminal/ghostty/renderScheduling";
import { subscribeWindowPresentation, terminalWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import { InlineSuggestion } from "@/modules/terminal/ghostty/input/InlineSuggestion";
import type { TerminalPrompt } from "@/modules/terminal/ghostty/input/TerminalPrompt";

type Options = {
  model: GhosttyTerminalModelApi;
  prompt: TerminalPrompt;
  input: HTMLTextAreaElement;
  target: HTMLElement;
  metrics: () => TerminalFontMetrics;
  available: () => boolean;
  cwd: () => string | null;
  insert: (text: string) => boolean;
};

const SVG_NS = "http://www.w3.org/2000/svg";

export class TerminalInlineCompletion {
  private readonly ghost = document.createElementNS(SVG_NS, "svg");
  private readonly completion: InlineSuggestion;
  private readonly cleanup: (() => void)[] = [];
  private composing = false;
  private suffix = "";
  private configuration = {};
  private renderKey = "";

  constructor(private readonly options: Options) {
    this.ghost.setAttribute("aria-hidden", "true");
    this.ghost.setAttribute("data-terminal-ghost", "");
    this.ghost.style.cssText = "position:absolute;display:none;pointer-events:none;user-select:none;overflow:hidden;color:var(--muted-foreground);opacity:.72;z-index:2;";
    options.target.append(this.ghost);
    options.input.setAttribute("aria-description", "Right arrow accepts the inline suggestion. Escape dismisses it. Tab uses shell completion.");
    this.completion = new InlineSuggestion({
      snapshot: () => {
        if (!options.available() || this.composing || document.activeElement !== options.input ||
            !terminalWindowFocused() || !terminalWindowPresentation().visible ||
            options.model.trackedSelection?.() || options.model.scrollPosition().offset !== 0) return null;
        const line = options.prompt.read(options.model);
        if (!line?.atEnd || !line.text.trim() || line.text.length > 2000 ||
            line.row < 0 || line.row >= options.model.rows) return null;
        return { prefix: line.text, cwd: options.cwd(), epoch: options.prompt.epoch, configuration: this.configuration };
      },
      history: historySuggest,
      ai: suggestCommand,
      insert: options.insert,
      show: (suffix) => { this.suffix = suffix; this.render(); },
    });
    this.listen(options.input, "focus", this.refresh);
    this.listen(options.input, "blur", this.invalidate);
    this.listen(options.input, "compositionstart", () => { this.composing = true; this.invalidate(); });
    this.listen(options.input, "compositionend", () => { this.composing = false; });
    this.listen(options.target, "pointerdown", this.invalidate);
    this.cleanup.push(bindTerminalWindowFocus(this.refresh));
    this.cleanup.push(subscribeWindowPresentation(this.refresh));
    this.cleanup.push(usePreferencesStore.subscribe((next, previous) => {
      if (next.terminalSuggestions !== previous.terminalSuggestions || next.customEndpoints !== previous.customEndpoints) this.reconfigure();
    }));
    this.cleanup.push(useChatStore.subscribe((next, previous) => {
      if (next.selectedModelId !== previous.selectedModelId || next.customEndpointKeys !== previous.customEndpointKeys) this.reconfigure();
    }));
  }

  readonly refresh = (): void => { this.completion.refresh(); this.render(); };
  readonly invalidate = (): void => { this.completion.invalidate(); };
  keyDown(event: KeyboardEvent): boolean { return this.completion.keyDown(event); }

  dispose(): void {
    this.completion.dispose();
    for (const cleanup of this.cleanup) cleanup();
    this.ghost.remove();
  }

  private reconfigure(): void {
    this.configuration = {};
    this.refresh();
  }

  private listen(target: HTMLElement, type: string, handler: () => void): void {
    target.addEventListener(type, handler);
    this.cleanup.push(() => target.removeEventListener(type, handler));
  }

  private render(): void {
    const line = this.suffix ? this.options.prompt.read(this.options.model) : null;
    if (!line?.atEnd || !this.suffix) {
      this.ghost.style.display = "none";
      this.renderKey = "";
      return;
    }
    const metrics = this.options.metrics();
    const { font, cellWidth, cellHeight, baseline } = metrics;
    const suffix = this.suffix.slice(0, this.options.model.cols - line.column);
    const key = [suffix, line.column, line.row, cellWidth, cellHeight, baseline, font.family, font.size, font.weight].join("|");
    if (this.renderKey === key) return;
    this.renderKey = key;
    this.ghost.style.display = "block";
    this.ghost.style.left = `${line.column * cellWidth}px`;
    this.ghost.style.top = `${line.row * cellHeight}px`;
    this.ghost.setAttribute("width", String(suffix.length * cellWidth));
    this.ghost.setAttribute("height", String(cellHeight));
    this.ghost.setAttribute("font-family", font.family);
    this.ghost.setAttribute("font-size", String(font.size));
    this.ghost.setAttribute("font-weight", font.weight);
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("fill", "currentColor");
    text.style.whiteSpace = "pre";
    text.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
    text.setAttribute("y", String(baseline));
    text.setAttribute("x", Array.from(suffix, (_, index) => index * cellWidth).join(" "));
    text.textContent = suffix;
    this.ghost.replaceChildren(text);
  }
}
