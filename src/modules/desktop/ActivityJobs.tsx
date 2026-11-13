import { native } from "@/modules/ai/lib/native";
import {
  type BackgroundJob,
  createJobPoller,
  JOB_LOG_LIMIT,
  JobLogTail,
  jobError,
  jobStatus,
  queueJobRequest,
} from "@/modules/desktop/activityJobsModel";
import {
  subscribeWindowPresentation,
  terminalWindowPresentation,
} from "@/modules/terminal/ghostty/windowPresentation";
import "@/styles/activity-jobs.css";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

type Selection = { handle: number; tail: JobLogTail };
type Output = {
  handle: number;
  text: string;
  truncated: boolean;
  loaded: boolean;
  error: string;
};

export function ActivityJobs() {
  const outputId = useId();
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedHandle, setSelectedHandle] = useState<number | null>(null);
  const [output, setOutput] = useState<Output | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);
  const [stopError, setStopError] = useState<{
    handle: number;
    message: string;
  } | null>(null);
  const [presented, setPresented] = useState(
    () => terminalWindowPresentation().visible,
  );
  const [following, setFollowing] = useState(true);
  const selection = useRef<Selection | null>(null);
  const controller = useRef<ReturnType<typeof createJobPoller> | null>(null);
  const mounted = useRef(false);
  const stopPending = useRef(false);
  const scroll = useRef<HTMLElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const sample = async (isCurrent: () => boolean) => {
      setBusy(true);
      try {
        try {
          const list = await queueJobRequest(isCurrent, native.shellBgList);
          if (!list || !isCurrent()) return;
          list.sort(
            (a, b) =>
              Number(a.exited) - Number(b.exited) ||
              b.started_at_ms - a.started_at_ms ||
              b.handle - a.handle,
          );
          setJobs(list);
          setLoaded(true);
          setError("");
          if (!list.some((job) => job.handle === selection.current?.handle)) {
            const first = list[0];
            selection.current = first
              ? { handle: first.handle, tail: new JobLogTail() }
              : null;
            setSelectedHandle(first?.handle ?? null);
            setOutput(null);
            atBottom.current = true;
            setFollowing(true);
          }
        } catch (failure) {
          if (isCurrent()) setError(jobError(failure));
        }
        const target = selection.current;
        if (!target || !isCurrent()) return;
        const isSelectionCurrent = () =>
          isCurrent() && selection.current === target;
        try {
          const reply = await queueJobRequest(isSelectionCurrent, () =>
            native.shellBgLogs(
              target.handle,
              target.tail.offset,
              JOB_LOG_LIMIT,
            ),
          );
          if (!reply || !isSelectionCurrent()) return;
          target.tail.append(reply);
          setOutput((previous) =>
            previous?.handle === target.handle &&
            previous.text === target.tail.text &&
            previous.truncated === target.tail.truncated &&
            previous.loaded &&
            !previous.error
              ? previous
              : {
                  handle: target.handle,
                  text: target.tail.text,
                  truncated: target.tail.truncated,
                  loaded: true,
                  error: "",
                },
          );
          setJobs((previous) =>
            previous.map((job) =>
              job.handle === target.handle &&
              (job.exited !== reply.exited || job.exit_code !== reply.exit_code)
                ? { ...job, exited: reply.exited, exit_code: reply.exit_code }
                : job,
            ),
          );
        } catch (failure) {
          if (isSelectionCurrent())
            setOutput({
              handle: target.handle,
              text: target.tail.text,
              truncated: target.tail.truncated,
              loaded: false,
              error: jobError(failure),
            });
        }
      } finally {
        if (mounted.current && controller.current === poller) setBusy(false);
      }
    };
    const poller = createJobPoller(
      sample,
      () => terminalWindowPresentation().visible,
    );
    controller.current = poller;
    const unsubscribe = subscribeWindowPresentation(({ visible }) => {
      setPresented(visible);
      poller.setVisible(visible);
    });
    return () => {
      mounted.current = false;
      controller.current = null;
      poller.dispose();
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => {
    if (output && presented && atBottom.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }, [output, presented]);

  const select = (handle: number) => {
    if (selection.current?.handle === handle) return;
    selection.current = { handle, tail: new JobLogTail() };
    setSelectedHandle(handle);
    setOutput(null);
    setStopError(null);
    atBottom.current = true;
    setFollowing(true);
    controller.current?.refresh();
  };

  const stop = async () => {
    const target = selection.current;
    const owner = controller.current;
    if (
      !target ||
      !owner ||
      stopPending.current ||
      !terminalWindowPresentation().visible
    )
      return;
    const isCurrent = () =>
      mounted.current &&
      controller.current === owner &&
      terminalWindowPresentation().visible;
    stopPending.current = true;
    setStopping(target.handle);
    setStopError(null);
    try {
      await queueJobRequest(
        () => isCurrent() && selection.current === target,
        () => native.shellBgKill(target.handle),
      );
      if (isCurrent()) owner.refresh();
    } catch (failure) {
      if (isCurrent())
        setStopError({ handle: target.handle, message: jobError(failure) });
    } finally {
      stopPending.current = false;
      if (mounted.current && controller.current === owner) setStopping(null);
    }
  };

  const selected = jobs.find((job) => job.handle === selectedHandle);
  const currentOutput = output?.handle === selectedHandle ? output : null;
  const runningCount = jobs.filter((job) => !job.exited).length;

  return (
    <section className="tarex-activity-jobs" aria-label="Agent background jobs">
      <p className="tarex-jobs-scope">
        Background jobs started by the AI agent
      </p>
      <div className="tarex-jobs-toolbar">
        <span role="status">
          {!presented
            ? "Updates paused"
            : loaded
              ? `${runningCount} running / ${jobs.length} total`
              : error
                ? "Jobs unavailable"
                : "Loading jobs…"}
        </span>
        <button
          type="button"
          disabled={busy || !presented}
          onClick={() => controller.current?.refresh()}
          aria-label="Refresh background jobs"
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && (
        <p className="tarex-jobs-error" role="alert">
          Could not refresh jobs. {error}
        </p>
      )}
      {loaded && jobs.length === 0 && (
        <div className="tarex-jobs-empty">
          <strong>No background jobs</strong>
          <p>
            When the AI agent starts a background command, its status and output
            appear here.
          </p>
        </div>
      )}
      {jobs.length > 0 && (
        <ul className="tarex-jobs-list" aria-label="Background commands">
          {jobs.map((job) => (
            <li key={job.handle}>
              <button
                type="button"
                className="tarex-job-row"
                aria-pressed={job.handle === selectedHandle}
                aria-controls={outputId}
                onClick={() => select(job.handle)}
              >
                <span className="tarex-job-identity">
                  <span>JOB {String(job.handle).padStart(2, "0")}</span>
                  <span
                    className="tarex-job-status"
                    data-state={jobStatus(job)}
                  >
                    {jobStatus(job)}
                    {job.exit_code !== null && job.exited
                      ? ` · ${job.exit_code}`
                      : ""}
                  </span>
                </span>
                <strong title={job.command}>{job.command}</strong>
                <span className="tarex-job-path" title={job.cwd ?? undefined}>
                  {job.cwd ?? "Inherited working directory"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <section
          id={outputId}
          className="tarex-job-detail"
          aria-label={`Output for job ${selected.handle}`}
        >
          <div className="tarex-job-detail-header">
            <h3>
              Output <span>/ {String(selected.handle).padStart(2, "0")}</span>
            </h3>
            {!selected.exited && (
              <button
                type="button"
                className="tarex-job-stop"
                onClick={() => void stop()}
                disabled={stopping !== null || !presented}
                aria-label={`Stop background job ${selected.handle}`}
              >
                {stopping === selected.handle ? "Stopping…" : "Stop"}
              </button>
            )}
          </div>
          <p className="tarex-job-started">
            Started {new Date(selected.started_at_ms).toLocaleString()}
          </p>
          <p className="tarex-job-command">{selected.command}</p>
          <p className="tarex-job-directory">
            {selected.cwd ?? "Inherited working directory"}
          </p>
          {stopError?.handle === selected.handle && (
            <p className="tarex-jobs-error" role="alert">
              Could not stop job. {stopError.message}
            </p>
          )}
          {currentOutput?.error && (
            <p className="tarex-jobs-error" role="alert">
              Could not read output. {currentOutput.error} Use Refresh to retry.
            </p>
          )}
          <section
            className="tarex-job-output"
            ref={scroll}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The log region needs keyboard scrolling.
            tabIndex={0}
            aria-label={`Plain text log for job ${selected.handle}`}
            aria-live="off"
            onScroll={(event) => {
              const element = event.currentTarget;
              const bottom =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <=
                12;
              atBottom.current = bottom;
              setFollowing(bottom);
            }}
          >
            {currentOutput?.text ? (
              <pre>{currentOutput.text}</pre>
            ) : (
              <p className="tarex-job-output-empty">
                {currentOutput?.error
                  ? "Output unavailable."
                  : !currentOutput?.loaded
                    ? "Loading output…"
                    : selected.exited
                      ? "No output captured."
                      : "Waiting for output…"}
              </p>
            )}
          </section>
          <div className="tarex-job-output-footer">
            <span>
              {currentOutput?.truncated
                ? "Earlier output omitted"
                : "Bounded text tail"}
            </span>
            <button
              type="button"
              disabled={following}
              onClick={() => {
                atBottom.current = true;
                setFollowing(true);
                if (scroll.current)
                  scroll.current.scrollTop = scroll.current.scrollHeight;
              }}
            >
              {following ? "Following" : "Jump to latest"}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
