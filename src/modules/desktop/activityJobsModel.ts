export const JOB_LOG_LIMIT = 64 * 1024;
export const JOB_POLL_MS = 2500;

export type BackgroundJob = {
  handle: number;
  command: string;
  cwd: string | null;
  started_at_ms: number;
  exited: boolean;
  exit_code: number | null;
};

export type JobLogReply = {
  bytes: string;
  next_offset: number;
  dropped: number;
  exited: boolean;
  exit_code: number | null;
};

type EscapeState =
  | "text"
  | "escape"
  | "intermediate"
  | "csi"
  | "string"
  | "stringEscape";

export class JobLogTail {
  text = "";
  offset = 0;
  truncated = false;
  private escape: EscapeState = "text";
  private pendingCr = false;
  private readonly encoder = new TextEncoder();

  append(reply: JobLogReply): void {
    const gap =
      reply.dropped > this.offset ||
      reply.next_offset - this.offset > JOB_LOG_LIMIT;
    if (gap) {
      this.escape = "text";
      this.pendingCr = false;
      this.text = "";
      this.truncated = true;
    }
    this.offset = reply.next_offset;
    if (!reply.bytes) return;
    const plain: string[] = [];
    for (const char of reply.bytes) {
      const code = char.charCodeAt(0);
      if (code === 0x18 || code === 0x1a) {
        this.escape = "text";
        continue;
      }
      if (this.escape === "string" || this.escape === "stringEscape") {
        if (
          code === 0x07 ||
          code === 0x9c ||
          (this.escape === "stringEscape" && char === "\\")
        ) {
          this.escape = "text";
        } else {
          this.escape = code === 0x1b ? "stringEscape" : "string";
        }
        continue;
      }
      if (code === 0x1b) {
        this.escape = "escape";
        continue;
      }
      if (this.escape === "escape") {
        if (char === "[") this.escape = "csi";
        else if ("]PX^_".includes(char)) this.escape = "string";
        else
          this.escape = code >= 0x20 && code <= 0x2f ? "intermediate" : "text";
        continue;
      }
      if (this.escape === "intermediate") {
        if (code < 0x20 || code > 0x2f) this.escape = "text";
        continue;
      }
      if (this.escape === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.escape = "text";
        continue;
      }
      if (code === 0x9b) {
        this.escape = "csi";
        continue;
      }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.escape = "string";
        continue;
      }
      if (char === "\r") {
        plain.push("\n");
        this.pendingCr = true;
        continue;
      }
      if (char === "\n") {
        if (!this.pendingCr) plain.push(char);
        this.pendingCr = false;
        continue;
      }
      if (char === "\t" || (code >= 0x20 && (code < 0x7f || code > 0x9f))) {
        plain.push(char);
        this.pendingCr = false;
      }
    }
    const combined = this.text + plain.join("");
    // Bound both encoded output and the UTF-16 text retained by React.
    let start = Math.max(0, combined.length - JOB_LOG_LIMIT / 2);
    const encoded = this.encoder.encode(combined.slice(start));
    if (encoded.length > JOB_LOG_LIMIT) {
      let byteStart = encoded.length - JOB_LOG_LIMIT;
      while ((encoded[byteStart] & 0xc0) === 0x80) byteStart++;
      this.text = new TextDecoder().decode(encoded.subarray(byteStart));
      this.truncated = true;
    } else {
      if (
        start > 0 &&
        combined.charCodeAt(start) >= 0xdc00 &&
        combined.charCodeAt(start) <= 0xdfff
      )
        start++;
      this.text = combined.slice(start);
    }
    if (start > 0) this.truncated = true;
  }
}

export function jobStatus(job: Pick<BackgroundJob, "exited" | "exit_code">) {
  return !job.exited
    ? "running"
    : job.exit_code !== null && job.exit_code !== 0
      ? "failed"
      : "exited";
}

export function jobError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

// One lane survives body remounts because native IPC requests cannot be aborted.
let requestLane: Promise<unknown> = Promise.resolve();

export function queueJobRequest<T>(
  isCurrent: () => boolean,
  request: () => Promise<T>,
): Promise<T | undefined> {
  const next = requestLane.then(() => (isCurrent() ? request() : undefined));
  requestLane = next.catch(() => undefined);
  return next;
}

export function createJobPoller(
  sample: (isCurrent: () => boolean) => Promise<void>,
  isPresented: () => boolean,
) {
  let disposed = false;
  let visible = false;
  let pending = false;
  let requested = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !disposed && visible && isPresented();
  const run = async () => {
    clearTimeout(timer);
    if (!active() || pending) return;
    pending = true;
    requested = false;
    const current = revision;
    try {
      await sample(() => active() && current === revision);
    } finally {
      pending = false;
      if (active()) timer = setTimeout(run, requested ? 0 : JOB_POLL_MS);
    }
  };
  return {
    refresh() {
      if (!active()) return;
      requested = true;
      void run();
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      revision++;
      clearTimeout(timer);
      if (visible) {
        requested = true;
        void run();
      }
    },
    dispose() {
      disposed = true;
      revision++;
      clearTimeout(timer);
    },
  };
}
