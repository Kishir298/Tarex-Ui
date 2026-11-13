import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";

const CHECK_EVENT = "tarex:updater:check";
const LAST_CHECK = "tarex:updater:last-check";
const INTERVAL = 30 * 60 * 1000;

export type UpdaterStatus =
  | { kind: "idle" | "checking" | "uptodate" | "manual" | "installing" }
  | {
      kind: "downloading";
      version: string;
      downloaded: number;
      contentLength: number | null;
    }
  | { kind: "ready"; version: string; body?: string }
  | { kind: "error"; message: string };

export async function requestUpdateCheck(): Promise<void> {
  await emitTo("main", CHECK_EVENT);
  const main = await Window.getByLabel("main");
  await main?.show();
  await main?.setFocus();
}

export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const update = useRef<Update | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const supported = useRef<Promise<boolean> | null>(null);

  const runCheck = useCallback(
    async ({ manual = false }: { manual?: boolean } = {}) => {
      if (manual) setOpen(true);
      if (busy.current) return;
      if (update.current) {
        if (manual)
          setStatus({
            kind: "ready",
            version: update.current.version,
            body: update.current.body,
          });
        return;
      }
      if (!manual) {
        try {
          const elapsed = Date.now() - Number(localStorage.getItem(LAST_CHECK));
          if (elapsed >= 0 && elapsed < INTERVAL) return;
        } catch {
          /* Storage may be disabled. */
        }
      }
      busy.current = true;
      setStatus({ kind: "checking" });
      try {
        supported.current ??= invoke<boolean>("updater_supported");
        if (!(await supported.current)) {
          if (alive.current) setStatus({ kind: "manual" });
          return;
        }
        try {
          localStorage.setItem(LAST_CHECK, String(Date.now()));
        } catch {
          /* Checking does not require storage. */
        }
        const candidate = await check({ timeout: 20_000 });
        if (!alive.current) {
          await candidate?.close();
          return;
        }
        if (!candidate) {
          setStatus({ kind: "uptodate" });
          return;
        }
        update.current = candidate;
        let downloaded = 0,
          total: number | null = null,
          lastProgress = 0;
        setStatus({
          kind: "downloading",
          version: candidate.version,
          downloaded,
          contentLength: total,
        });
        await candidate.download(
          (event) => {
            if (event.event === "Started")
              total = event.data.contentLength ?? null;
            if (event.event === "Progress")
              downloaded += event.data.chunkLength;
            if (alive.current && Date.now() - lastProgress >= 100) {
              lastProgress = Date.now();
              setStatus({
                kind: "downloading",
                version: candidate.version,
                downloaded,
                contentLength: total,
              });
            }
          },
          { timeout: 300_000 },
        );
        // download() resolves only after native signature and signed-version verification.
        if (alive.current) {
          setStatus({
            kind: "ready",
            version: candidate.version,
            body: candidate.body,
          });
          if (!manual)
            toast.info(`Tarex UI ${candidate.version} is ready`, {
              duration: 15000,
              action: { label: "Review update", onClick: () => setOpen(true) },
            });
        }
      } catch (error) {
        await update.current?.close().catch(() => {});
        update.current = null;
        supported.current = null;
        if (alive.current) setStatus({ kind: "error", message: String(error) });
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  const install = useCallback(
    async (beforeInstall: () => Promise<void>) => {
      if (status.kind !== "ready" || !update.current || busy.current) return;
      busy.current = true;
      try {
        await beforeInstall();
        if (!alive.current) return;
        setStatus({ kind: "installing" });
        await update.current.install();
        await relaunch();
      } catch (error) {
        if (alive.current) setStatus({ kind: "error", message: String(error) });
      } finally {
        busy.current = false;
      }
    },
    [status.kind],
  );

  useEffect(() => {
    alive.current = true;
    const pending = listen(CHECK_EVENT, () => void runCheck({ manual: true }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    const tick = async () => {
      await runCheck();
      if (alive.current && visible) timer = setTimeout(tick, INTERVAL);
    };
    const off =
      !import.meta.env.DEV && isTauri()
        ? subscribeWindowPresentation((state) => {
            visible = state.visible;
            clearTimeout(timer);
            if (visible) timer = setTimeout(tick, 10_000);
          })
        : () => {};
    return () => {
      alive.current = false;
      off();
      clearTimeout(timer);
      void pending.then((unlisten) => unlisten());
      void update.current?.close().catch(() => {});
    };
  }, [runCheck]);

  return {
    status,
    open,
    check: runCheck,
    install,
    dismiss: () => setOpen(false),
  };
}
