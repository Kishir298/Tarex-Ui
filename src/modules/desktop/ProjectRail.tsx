import "@/styles/project-rail.css";
import type { DirEntry } from "@/modules/ai/lib/native";
import { parentPath } from "@/modules/desktop/model";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { repositoryContainsContext, type SourceControlSummary } from "@/modules/source-control/useSourceControl";
import type { GitDiffOpenInput } from "@/modules/tabs/lib/useTabs";
import { subscribeWindowPresentation, terminalWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import { useWorkspaceEnvStore, workspaceScopeKey } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

type Props = {
  path: string | null;
  git: SourceControlSummary;
  onOpenEntry: (entry: DirEntry, directory: string) => void;
  onBrowse: (path: string) => void;
  onOpenDiff: (input: GitDiffOpenInput) => void;
  onGit: (path: string) => void;
};

const ROW_LIMIT = 60;

export function ProjectRail(props: Props) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const scope = `${workspaceScopeKey(workspace)}\0${props.path ?? ""}`;
  const showHidden = usePreferencesStore((state) => state.showHidden);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<"files" | "changes">("files");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<{ scope: string; entries: DirEntry[]; pending: boolean; error: string }>({ scope: "", entries: [], pending: false, error: "" });
  const current = useRef(props);
  current.current = props;
  const matchesRepo = repositoryContainsContext(props.git.repo?.repoRoot ?? null, props.path);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 601px)");
    const update = () => setVisible(media.matches && terminalWindowPresentation().visible);
    media.addEventListener("change", update);
    const off = subscribeWindowPresentation(update);
    return () => { media.removeEventListener("change", update); off(); };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision is an explicit refresh token.
  useEffect(() => {
    if (!visible || !props.path) return;
    const path = props.path;
    let alive = true;
    setListing((old) => ({ scope, entries: old.scope === scope ? old.entries : [], pending: true, error: "" }));
    void invoke<DirEntry[]>("fs_read_dir", { path, showHidden, gitDecorations: false, workspace }).then(
      (entries) => { if (alive) setListing({ scope, entries, pending: false, error: "" }); },
      (error) => { if (alive) setListing({ scope, entries: [], pending: false, error: String(error) }); },
    );
    return () => { alive = false; };
  }, [props.path, workspace, scope, showHidden, visible, revision]);

  useEffect(() => {
    if (!visible || !props.path) return;
    const path = props.path;
    let alive = true;
    let watching = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stops: (() => void)[] = [];
    const removeWatch = () => invoke("fs_watch_remove", { paths: [path], workspace }).catch(() => {});
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (alive) setRevision((value) => value + 1); }, 250);
    };
    const onPath = (changed: string) => {
      const normalized = changed.replace(/\\/g, "/");
      if (normalized === path || parentPath(normalized) === path) refresh();
    };
    void (async () => {
      try {
        const off = await listen<{ paths: string[] }>("fs:changed", ({ payload }) => { for (const changed of payload.paths) onPath(changed); });
        if (!alive) { off(); return; }
        stops.push(off);
        const offWritten = await listen<{ path: string }>("fs:file-written", ({ payload }) => onPath(payload.path));
        if (!alive) { offWritten(); return; }
        stops.push(offWritten);
        await invoke("workspace_authorize", { path, workspace });
        if (!alive) return;
        await invoke("fs_watch_add", { paths: [path], workspace });
        watching = true;
        if (!alive) { watching = false; await removeWatch(); }
      } catch { /* Manual refresh remains available if watching is unavailable. */ }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      stops.forEach((stop) => { stop(); });
      if (watching) void removeWatch();
    };
  }, [props.path, workspace, visible]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Workspace changes invalidate the refresh even when the path is unchanged.
  useEffect(() => {
    if (!visible || view !== "changes" || !props.path) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try { await current.current.git.refresh({ remote: "never" }); }
      catch { /* The source-control hook exposes its error in the shared status. */ }
      finally { if (alive) timer = setTimeout(refresh, 5000); }
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [visible, view, props.path, workspace]);

  const term = query.trim().toLowerCase();
  const files = listing.scope === scope ? listing.entries.filter((entry) => entry.name.toLowerCase().includes(term)) : [];
  const changes = matchesRepo ? (props.git.status?.changedFiles ?? []).filter((entry) => entry.path.toLowerCase().includes(term)) : [];
  const pending = !!props.path && (listing.scope !== scope || listing.pending);
  const name = props.path?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || props.path || "No folder";

  return (
    <aside className="tarex-project-rail" aria-label="Project files and changes">
      <div className="tarex-rule"><span>PROJECT</span><span>WORKSPACE</span></div>
      <div className="tarex-project-heading">
        <strong title={props.path ?? undefined}>{name}</strong>
        <button type="button" disabled={!props.path} onClick={() => { if (props.path) props.onBrowse(props.path); }}>Open Files</button>
      </div>
      <p className="tarex-project-path" title={props.path ?? undefined}>{props.path ?? "Choose a workspace folder"}</p>
      <fieldset className="tarex-project-tabs" aria-label="Project view">
        <button type="button" aria-pressed={view === "files"} onClick={() => setView("files")}>Files</button>
        <button type="button" aria-pressed={view === "changes"} onClick={() => setView("changes")}>Changes{matchesRepo ? ` ${props.git.changedCount}` : ""}</button>
      </fieldset>
      <input type="search" aria-label="Filter project files" placeholder={view === "files" ? "Find a file…" : "Filter changes…"} value={query} maxLength={256} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
      {view === "changes" && matchesRepo && <p className="tarex-project-branch" title={props.git.status?.branch}>Branch / {props.git.status?.branch || "Detached HEAD"}</p>}
      <div className="tarex-project-list" aria-busy={view === "files" ? pending : props.git.isLoading}>
        {view === "files" ? (
          listing.scope === scope && listing.error ? <p className="tarex-project-message" role="alert">{listing.error}</p> : (
            <>
              <ul>{files.slice(0, ROW_LIMIT).map((entry) => <li key={entry.name}>
                <button type="button" title={entry.name} onClick={() => { if (props.path) props.onOpenEntry(entry, props.path); }}>
                  <span className="tarex-project-kind" aria-hidden="true">{entry.kind === "dir" ? "DIR" : entry.kind === "symlink" ? "LINK" : "FILE"}</span>
                  <span className="tarex-project-name">{entry.name}</span>
                </button>
              </li>)}</ul>
              {!files.length && <p className="tarex-project-message" role="status">{pending ? "Reading folder…" : term ? "No matching files" : "No files in this folder"}</p>}
              {files.length > ROW_LIMIT && <p className="tarex-project-message">{ROW_LIMIT} of {files.length} entries. Filter or open Files for the full list.</p>}
            </>
          )
        ) : props.git.localError ? <p className="tarex-project-message" role="alert">{props.git.localError}</p> : !matchesRepo ? (
          <div className="tarex-project-message"><p>No Git repository selected for this folder.</p><button type="button" disabled={!props.path} onClick={() => { if (props.path) props.onGit(props.path); }}>Open source control</button></div>
        ) : (
          <>
            <ul>{changes.slice(0, ROW_LIMIT).map((file) => <li key={file.path}>
              <button type="button" title={`${file.statusLabel}: ${file.path}`} onClick={() => props.onOpenDiff({ path: file.path, repoRoot: props.git.repo?.repoRoot ?? "", mode: file.unstaged ? "-" : "+", originalPath: file.originalPath })}>
                <span className="tarex-project-change" aria-hidden="true">{file.untracked ? "?" : file.unstaged ? file.worktreeStatus : file.indexStatus}</span>
                <span className="tarex-project-name">{file.path}</span>
                {file.staged && !file.unstaged && <span className="tarex-project-staged">Staged</span>}
              </button>
            </li>)}</ul>
            {!changes.length && <p className="tarex-project-message">{props.git.isLoading ? "Reading changes…" : term ? "No matching changes" : "Working tree clean"}</p>}
            {changes.length > ROW_LIMIT && <p className="tarex-project-message">Showing {ROW_LIMIT} of {changes.length} changes.</p>}
            {props.git.status?.truncated && <p className="tarex-project-message">Git returned a partial file list.</p>}
          </>
        )}
      </div>
      <footer className="tarex-project-footer">
        <span>{view === "files" ? "Click to open" : "Click to review diff"}</span>
        <button type="button" disabled={!visible || !props.path || (view === "files" ? pending : props.git.isLoading)} onClick={() => { setRevision((value) => value + 1); void props.git.refresh({ remote: "never" }); }}>Refresh</button>
      </footer>
    </aside>
  );
}
