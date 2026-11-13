import type { DirEntry } from "@/modules/ai/lib/native";
import { bytes, joinPath, parentPath } from "@/modules/desktop/model";
import {
  listenFsChanged,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import {
  subscribeWindowPresentation,
  terminalWindowPresentation,
} from "@/modules/terminal/ghostty/windowPresentation";
import { useWorkspaceEnvStore, currentWorkspaceEnv } from "@/modules/workspace";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { toast } from "sonner";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

function useDirectory(
  path: string | null,
  hidden: boolean,
  revision: number,
  enabled: boolean,
) {
  const workspace = useWorkspaceEnvStore((s) => s.env);
  const [result, setResult] = useState<{
    path: string | null;
    entries: DirEntry[];
    error: string;
    pending: boolean;
  }>({ path: null, entries: [], error: "", pending: false });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision explicitly invalidates a directory listing.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    if (!path) {
      setResult({ path, entries: [], error: "", pending: false });
      return;
    }
    setResult((previous) => ({
      path,
      entries: previous.path === path ? previous.entries : [],
      error: "",
      pending: true,
    }));
    void invoke<DirEntry[]>("fs_read_dir", {
      path,
      showHidden: hidden,
      gitDecorations: false,
      workspace,
    }).then(
      (entries) => {
        if (alive) setResult({ path, entries, error: "", pending: false });
      },
      (error) => {
        if (alive)
          setResult({
            path,
            entries: [],
            error: String(error),
            pending: false,
          });
      },
    );
    return () => {
      alive = false;
    };
  }, [path, hidden, workspace, revision, enabled]);
  return result;
}

export function useDesktopFiles(
  cwd: string | null,
  onOpenFile: (path: string) => void,
  scopeKey: string,
  onNavigate: (path: string) => Promise<void>,
  enabled = true,
) {
  const [path, setPath] = useState<string | null>(cwd);
  const [hidden, setHidden] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState("");
  const [actionError, setActionError] = useState("");
  const navigation = useRef(0);
  const [presented, setPresented] = useState(
    () => terminalWindowPresentation().visible,
  );
  useEffect(() => {
    if (!enabled) return;
    return subscribeWindowPresentation((state) => setPresented(state.visible));
  }, [enabled]);
  const active = enabled && presented;
  const workspace = useWorkspaceEnvStore((s) => s.env);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing workspace must discard the previous workspace's navigation.
  useEffect(() => {
    navigation.current++;
    setPath(cwd);
    setSelection("");
    setActionError("");
  }, [cwd, workspace, scopeKey]);
  const current = useDirectory(path, hidden, revision, active);
  const parent = useDirectory(
    path ? parentPath(path) : null,
    hidden,
    revision,
    active,
  );
  const selected =
    current.entries.find((entry) => entry.name === selection) ??
    current.entries[0];
  const preview = useDirectory(
    path && selected?.kind === "dir" ? joinPath(path, selected.name) : null,
    hidden,
    revision,
    active,
  );
  useEffect(() => {
    if (!path || !active) return;
    let disposed = false;
    let watching = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void listenFsChanged((paths) => {
      if (
        !paths.some(
          (changed) => changed === path || parentPath(changed) === path,
        )
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(reload, 120);
    })
      .then(async (off) => {
        if (disposed) off();
        else {
          unlisten = off;
          await invoke("workspace_authorize", { path, workspace });
          if (!disposed) {
            watchAdd([path]);
            watching = true;
          }
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
      if (watching) watchRemove([path]);
    };
  }, [path, reload, workspace, active]);
  const sync = (next = path) => {
    if (!next) return;
    const request = ++navigation.current;
    setActionError("");
    void onNavigate(next).catch((error) => {
      if (request === navigation.current) setActionError(String(error));
    });
  };
  const navigate = (next: string) => {
    setActionError("");
    setSelection("");
    setPath(next);
    sync(next);
  };
  async function open(entry: DirEntry, directory = path) {
    if (!directory) return;
    const target = joinPath(directory, entry.name);
    try {
      setActionError("");
      if (entry.kind === "dir") navigate(target);
      else if (entry.kind === "symlink") {
        const canonical = await invoke<string>("fs_canonicalize", {
          path: target,
          workspace,
        });
        const stat = await invoke<{ kind: string }>("fs_stat", {
          path: canonical,
          workspace,
        });
        if (stat.kind === "dir") navigate(canonical);
        else onOpenFile(canonical);
      } else onOpenFile(target);
    } catch (error) {
      setActionError(String(error));
    }
  }
  return {
    path,
    current,
    parent,
    preview,
    selected,
    hidden,
    toggleHidden: () => setHidden(!hidden),
    select: setSelection,
    navigate,
    open,
    reload,
    sync: () => sync(),
    error: actionError || current.error,
  };
}

export type DesktopFiles = ReturnType<typeof useDesktopFiles>;

function FileGlyph({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
      {kind === "dir" ? (
        <path d="M2 7a2 2 0 0 1 2-2h8l3 3h13a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
      ) : kind === "symlink" ? (
        <path d="M12 10H9a6 6 0 0 0 0 12h6v-3H9a3 3 0 0 1 0-6h3zm8 0h3a6 6 0 0 1 0 12h-6v-3h6a3 3 0 0 0 0-6h-3zm-10 5h12v3H10z" />
      ) : (
        <path d="M7 3h12l7 7v19H7zm12 2v7h6z" />
      )}
    </svg>
  );
}

function FileColumn({
  entries,
  base,
  side,
  children,
}: {
  entries: DirEntry[];
  base: string | null;
  side: string;
  children: (
    entry: DirEntry,
    index: number,
    moveFocus: (index: number) => void,
  ) => ReactNode;
}) {
  "use no memo";
  const scroll = useRef<HTMLFieldSetElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const virtualizer = useVirtualizer<HTMLFieldSetElement, HTMLDivElement>({
    count: entries.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 20,
    overscan: 8,
    getItemKey: (index) => `${base}/${entries[index].name}`,
  });
  const completeFocus = () => {
    const index = pendingFocus.current;
    if (index === null) return;
    const button = scroll.current?.querySelector<HTMLButtonElement>(
      `[data-index="${index}"] button`,
    );
    if (button) {
      pendingFocus.current = null;
      button.focus();
    }
  };
  useLayoutEffect(completeFocus);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new directory must reset its scroll position.
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [base]);
  const moveFocus = (index: number) => {
    const next = Math.max(0, Math.min(entries.length - 1, index));
    pendingFocus.current = next;
    virtualizer.scrollToIndex(next, { align: "auto" });
    completeFocus();
  };
  return (
    <fieldset
      ref={scroll}
      className={`tarex-file-column tarex-file-column-${side}`}
      aria-label={`${side} directory`}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
            }}
          >
            {children(entries[row.index], row.index, moveFocus)}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export function Commander({ files }: { files: DesktopFiles }) {
  const { path, current, parent, selected, preview } = files;
  const [address, setAddress] = useState(path ?? "");
  useEffect(() => setAddress(path ?? ""), [path]);
  const openAddress = async () => {
    try {
      let target=address.trim();
      if (!target) return;
      if (target === "~" || target.startsWith("~/")) target=joinPath(await homeDir(),target.slice(2));
      else if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(target)) target=joinPath(path??"/",target);
      target=await invoke<string>("fs_canonicalize",{path:target,workspace:currentWorkspaceEnv()});
      const stat=await invoke<{kind:"file"|"dir"|"symlink";size:number;mtime:number}>("fs_stat",{path:target,workspace:currentWorkspaceEnv()});
      if(stat.kind==="dir") files.navigate(target);
      else void files.open({name:target.split(/[\\/]/).pop()??target,...stat,gitignored:false},parentPath(target));
    }catch(e){toast.error(String(e));}
  };
  const [highlight, setHighlight] = useState<{
    base: string | null;
    name: string;
  } | null>(null);
  function column(
    entries: DirEntry[],
    base: string | null,
    side: "parent" | "current" | "preview",
  ) {
    return (
      <FileColumn entries={entries} base={base} side={side}>
        {(entry, index, moveFocus) => (
          <button
            type="button"
            key={entry.name}
            data-file-path={joinPath(base ?? "/",entry.name)}
            data-file-base={base ?? "/"}
            data-file-name={entry.name}
            data-file-kind={entry.kind}
            aria-pressed={side === "current" && entry.name === selected?.name}
            className={`tarex-file-row ${(side === "current" && entry.name === selected?.name) || (highlight?.base === base && highlight?.name === entry.name) || (side === "parent" && path && joinPath(base ?? "/", entry.name) === path.replace(/\/$/, "")) ? "selected" : ""} ${entry.kind === "dir" ? "is-directory" : ""}`}
            onFocus={() => {
              if (side === "current") files.select(entry.name);
            }}
            onClick={() => {
              if (side === "current") files.select(entry.name);
              else setHighlight({ base, name: entry.name });
            }}
            onDoubleClick={() => void files.open(entry, base)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "ArrowRight") {
                event.preventDefault();
                void files.open(entry, base);
              }
              if (event.key === "ArrowLeft" && path) {
                event.preventDefault();
                files.navigate(parentPath(path));
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveFocus(index + 1);
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                moveFocus(index - 1);
              }
              if (event.key === "Home") {event.preventDefault();moveFocus(0);}
              if (event.key === "End") {event.preventDefault();moveFocus(entries.length-1);}
              if (event.key === "PageDown") {event.preventDefault();moveFocus(index+20);}
              if (event.key === "PageUp") {event.preventDefault();moveFocus(index-20);}
            }}
          >
            <span className="tarex-file-mark">
              {entry.kind === "dir"
                ? "▪"
                : entry.kind === "symlink"
                  ? "↗"
                  : "·"}
            </span>
            <span className="tarex-file-name">{entry.name}</span>
            <span className="tarex-file-size">
              {entry.kind === "dir" ? "/" : bytes(entry.size)}
            </span>
          </button>
        )}
      </FileColumn>
    );
  }
  return (
    <div className="tarex-commander">
      <div className="tarex-pathline">
        <span className="tarex-path-user">LOCAL</span>
        <input aria-label="Directory path" value={address} onChange={e=>setAddress(e.target.value)} onFocus={e=>e.target.select()} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void openAddress();}if(e.key==="Escape")setAddress(path??"");}} />
        <button
          type="button"
          onClick={files.reload}
          aria-label="Refresh directory"
        >
          ↻
        </button>
      </div>
      {files.error && (
        <div role="alert" className="tarex-error">
          {files.error}
        </div>
      )}
      <div className="tarex-columns">
        {column(parent.entries, path ? parentPath(path) : null, "parent")}
        {column(current.entries, path, "current")}
        {selected?.kind === "dir" ? (
          column(
            preview.entries,
            path ? joinPath(path, selected.name) : null,
            "preview",
          )
        ) : (
          <div className="tarex-file-detail">
            {selected ? (
              <>
                <FileGlyph kind={selected.kind} />
                <strong>{selected.name}</strong>
                <span>
                  {bytes(selected.size)} / {selected.kind.toUpperCase()}
                </span>
                <span>{new Date(selected.mtime).toLocaleString()}</span>
                <button type="button" onClick={() => void files.open(selected)}>
                  OPEN IN EDITOR ↗
                </button>
              </>
            ) : (
              <span>
                {current.pending ? "READING DIRECTORY" : "EMPTY DIRECTORY"}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="tarex-file-footer">
        <span>
          {selected?.kind ?? "directory"} {selected?.name ?? "/"}
        </span>
        <span>
          {current.entries.length} entries /{" "}
          {current.pending ? "READING" : "LIVE"}
        </span>
      </div>
    </div>
  );
}

export function FileActions({
  files,
  onTerminal,
  onAttach,
  terminalActive,
}: {
  files: DesktopFiles;
  onTerminal: (path: string) => void;
  onAttach: (path: string) => void;
  terminalActive: boolean;
}) {
  return (
    <div
      className="tarex-file-actions"
      role="toolbar"
      aria-label="File actions"
    >
      <button
        type="button"
        aria-pressed={files.hidden}
        onClick={files.toggleHidden}
      >
        Show hidden
      </button>
      <button
        type="button"
        disabled={!files.path || parentPath(files.path) === files.path}
        onClick={() => {
          if (files.path) files.navigate(parentPath(files.path));
        }}
      >
        Go up
      </button>
      <button
        type="button"
        disabled={!terminalActive || !files.path}
        onClick={files.sync}
      >
        Sync terminal
      </button>
      <button type="button" onClick={files.reload}>
        REFRESH
      </button>
      <button
        type="button"
        disabled={!files.path}
        onClick={() => {
          if (files.path) onTerminal(files.path);
        }}
      >
        TERMINAL HERE
      </button>
      <button
        type="button"
        disabled={
          !files.path || !files.selected || files.selected.kind === "dir"
        }
        onClick={() => {
          if (files.path && files.selected)
            onAttach(joinPath(files.path, files.selected.name));
        }}
      >
        ATTACH TO AI
      </button>
    </div>
  );
}
