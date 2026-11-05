export type SuggestionSnapshot = {
  prefix: string;
  cwd: string | null;
  epoch: number;
  configuration: unknown;
};

type Options = {
  snapshot: () => SuggestionSnapshot | null;
  history: (prefix: string) => Promise<string | null>;
  ai: (prefix: string, cwd: string | null, signal: AbortSignal, current: () => boolean) => Promise<string | null>;
  show: (suffix: string) => void;
  insert: (suffix: string) => boolean;
};

export function suggestionSuffix(prefix: string, command: string | null): string {
  if (!command || !prefix || !command.startsWith(prefix) || command.length > 2000) return "";
  const suffix = command.slice(prefix.length);
  // Each supported ghost glyph occupies exactly one terminal cell.
  return suffix && /^[\x20-\x7e]+$/.test(suffix) ? suffix : "";
}

export class InlineSuggestion {
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private captured: SuggestionSnapshot | null = null;
  private suffix = "";
  private dismissed: SuggestionSnapshot | null = null;
  private disposed = false;

  constructor(private readonly options: Options) {}

  refresh(): void {
    if (this.disposed) return;
    const next = this.options.snapshot();
    if (sameSnapshot(next, this.captured)) return;
    this.cancel();
    this.captured = next;
    if (!next || sameSnapshot(next, this.dismissed)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fetch(next);
    }, 100);
  }

  invalidate(): void {
    this.cancel();
    this.captured = null;
  }

  keyDown(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing">): boolean {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
    if (!sameSnapshot(this.captured, this.options.snapshot())) {
      this.invalidate();
      return false;
    }
    if (event.key === "Escape" && (this.suffix || this.request || this.timer)) {
      this.dismissed = this.captured;
      this.cancel();
      return true;
    }
    if (event.key !== "ArrowRight" || !this.suffix) return false;
    const suffix = this.suffix;
    this.cancel();
    return this.options.insert(suffix);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private async fetch(snapshot: SuggestionSnapshot): Promise<void> {
    const controller = new AbortController();
    this.request = controller;
    const current = () => !this.disposed && !controller.signal.aborted &&
      sameSnapshot(snapshot, this.options.snapshot());
    try {
      const history = await this.options.history(snapshot.prefix);
      if (!current()) return;
      let suffix = suggestionSuffix(snapshot.prefix, history);
      if (!suffix) {
        const command = await this.options.ai(snapshot.prefix, snapshot.cwd, controller.signal, current);
        if (!current()) return;
        suffix = suggestionSuffix(snapshot.prefix, command);
      }
      this.suffix = suffix;
      this.options.show(suffix);
    } catch {
      // Completion is optional; native shell input remains available on failure.
    } finally {
      if (this.request === controller) this.request = null;
    }
  }

  private cancel(): void {
    this.request?.abort();
    this.request = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.suffix = "";
    this.options.show("");
  }
}

function sameSnapshot(a: SuggestionSnapshot | null, b: SuggestionSnapshot | null): boolean {
  return a === b || (!!a && !!b && a.prefix === b.prefix && a.cwd === b.cwd &&
    a.epoch === b.epoch && a.configuration === b.configuration);
}
