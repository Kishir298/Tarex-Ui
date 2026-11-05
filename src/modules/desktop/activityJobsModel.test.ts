import {
  createJobPoller,
  JOB_LOG_LIMIT,
  JOB_POLL_MS,
  type JobLogReply,
  JobLogTail,
  jobStatus,
  queueJobRequest,
} from "@/modules/desktop/activityJobsModel";
import { afterEach, describe, expect, it, vi } from "vitest";

const reply = (
  bytes: string,
  next_offset: number,
  dropped = 0,
): JobLogReply => ({
  bytes,
  next_offset,
  dropped,
  exited: false,
  exit_code: null,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("background job text tail", () => {
  it("strips split CSI, OSC, DCS and C1 sequences while leaving HTML inert text", () => {
    const tail = new JobLogTail();
    tail.append(reply("a\x1b[3", 5));
    tail.append(reply("1mb\x1b[0m\x1b]8;;https://example.com\x1b", 45));
    tail.append(reply("\\link\x1b]8;;\x07\x1bPprivate", 68));
    tail.append(reply("\x1b\\\u009b32m<c>\u009dsecret\u009c\x00\x7f", 99));
    expect(tail.text).toBe("ablink<c>");
  });

  it("normalizes split carriage returns and drops terminal controls", () => {
    const tail = new JobLogTail();
    tail.append(reply("10%\r", 4));
    tail.append(reply("\n20%\r30%\tready\x08\x07", 25));
    expect(tail.text).toBe("10%\n20%\n30%\tready");
  });

  it("retains no unbounded escape payload and resets parser after missed bytes", () => {
    const tail = new JobLogTail();
    tail.append(reply(`\x1b]${"x".repeat(JOB_LOG_LIMIT)}`, JOB_LOG_LIMIT));
    expect(tail.text).toBe("");
    tail.append(reply("fresh", JOB_LOG_LIMIT * 3, JOB_LOG_LIMIT + 1));
    expect(tail.text).toBe("fresh");
    expect(tail.truncated).toBe(true);
  });

  it("bounds retained UTF-16 and UTF-8 memory without cutting surrogate pairs", () => {
    const tail = new JobLogTail();
    const chunk = "abc\u{1f600}界".repeat(9000);
    tail.append(reply(chunk, JOB_LOG_LIMIT));
    expect(tail.text.length * 2).toBeLessThanOrEqual(JOB_LOG_LIMIT);
    expect(new TextEncoder().encode(tail.text).length).toBeLessThanOrEqual(
      JOB_LOG_LIMIT,
    );
    expect(tail.text).not.toContain("�");
    expect(chunk.endsWith(tail.text)).toBe(true);
    expect(tail.truncated).toBe(true);
    tail.append(reply("last", JOB_LOG_LIMIT + 4));
    expect(tail.text.endsWith("last")).toBe(true);
    expect(tail.offset).toBe(JOB_LOG_LIMIT + 4);
  });

  it("does not label an unknown exit as a successful exit", () => {
    expect(jobStatus({ exited: false, exit_code: null })).toBe("running");
    expect(jobStatus({ exited: true, exit_code: 0 })).toBe("exited");
    expect(jobStatus({ exited: true, exit_code: null })).toBe("exited");
    expect(jobStatus({ exited: true, exit_code: 42 })).toBe("failed");
  });
});

describe("background job request lifecycle", () => {
  it("starts only when presented, waits between completions and never overlaps", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const sample = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const poller = createJobPoller(sample, () => true);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2);
    expect(sample).not.toHaveBeenCalled();
    poller.setVisible(true);
    poller.refresh();
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2);
    expect(sample).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sample).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS - 1);
    expect(sample).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sample).toHaveBeenCalledTimes(3);
    poller.dispose();
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2);
    expect(sample).toHaveBeenCalledTimes(3);
  });

  it("rejects results from a hidden generation even after showing again", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    let current = () => false;
    const sample = vi.fn(async (isCurrent: () => boolean) => {
      current = isCurrent;
      await first.promise;
    });
    const poller = createJobPoller(sample, () => true);
    poller.setVisible(true);
    expect(current()).toBe(true);
    poller.setVisible(false);
    expect(current()).toBe(false);
    poller.setVisible(true);
    expect(current()).toBe(false);
    expect(sample).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sample).toHaveBeenCalledTimes(2);
    poller.setVisible(false);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3);
    expect(sample).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("checks current DOM presentation before starting scheduled work", async () => {
    vi.useFakeTimers();
    let visible = true;
    const sample = vi.fn().mockResolvedValue(undefined);
    const poller = createJobPoller(sample, () => visible);
    poller.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    visible = false;
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(sample).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it("serializes native calls across owners and skips stale queued selections", async () => {
    const first = deferred<number>();
    let selected = 1;
    const one = vi.fn(() => first.promise);
    const stale = vi.fn(async () => 2);
    const next = vi.fn(async () => 3);
    const firstRequest = queueJobRequest(() => true, one);
    const staleRequest = queueJobRequest(() => selected === 1, stale);
    const nextRequest = queueJobRequest(() => selected === 2, next);
    await Promise.resolve();
    expect(one).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    selected = 2;
    first.resolve(1);
    expect(await firstRequest).toBe(1);
    expect(await staleRequest).toBeUndefined();
    expect(await nextRequest).toBe(3);
    expect(stale).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("recovers the shared native lane after a rejected request", async () => {
    await expect(
      queueJobRequest(
        () => true,
        async () => {
          throw new Error("gone");
        },
      ),
    ).rejects.toThrow("gone");
    await expect(
      queueJobRequest(
        () => true,
        async () => 4,
      ),
    ).resolves.toBe(4);
  });
});
