import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuCheckboxItem } from "@/components/ui/context-menu";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { DesktopFiles } from "@/modules/desktop/Files";
import { joinPath, parentPath, relativePath, validEntryName } from "@/modules/desktop/model";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { writeTerminalClipboard } from "@/modules/terminal/lib/terminalClipboard";
import { IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

type Target = { path: string; base: string; name: string; kind: string };
export type FileMenuActions = {
  onTerminal: (path: string) => void;
  onSourceControl: (path: string) => void;
  onHistory: (path: string) => void;
  onAttach: (path: string) => void;
  onDeleted: (paths: string[]) => void;
};

export function FilesMenu({ files, actions, children }: { files: DesktopFiles; actions: FileMenuActions; children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [creating, setCreating] = useState<{ base: string; kind: "file" | "dir" } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const directory = target?.kind === "dir" ? target.path : target?.base ?? files.path;
  const run = (action: () => void | Promise<void>) => { void Promise.resolve().then(action).catch(e => toast.error(String(e))); };
  const create = async () => {
    if (!creating || busy) return;
    try {
      setError(""); setBusy(true);
      const path = joinPath(creating.base, validEntryName(name));
      await invoke(creating.kind === "dir" ? "fs_create_dir" : "fs_create_file", { path, workspace: currentWorkspaceEnv() });
      files.reload();
      if (creating.kind === "file") await files.open({ name, kind: "file", size: 0, mtime: Date.now(), gitignored: false }, creating.base);
      setCreating(null);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    try {
      setError(""); setBusy(true);
      const result = await invoke<{ deleted: string[]; failed: number }>("fs_delete_batch", { paths: [deleting.path], root: deleting.base, workspace: currentWorkspaceEnv() });
      if (result.failed || result.deleted.length !== 1) throw new Error("The item could not be deleted. Check permissions and open files.");
      actions.onDeleted(result.deleted);
      if (files.path === deleting.path || files.path?.startsWith(`${deleting.path}/`)) files.navigate(deleting.base);
      files.reload(); setDeleting(null);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <>
    <ContextMenu><ContextMenuTrigger asChild className="select-auto">
      <div className="tarex-files-content" onKeyDownCapture={e => {
        if ((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="l") {e.preventDefault();e.currentTarget.querySelector<HTMLInputElement>('input[aria-label="Directory path"]')?.focus();}
        const row=(e.target as HTMLElement).closest<HTMLElement>('[data-file-path]');
        if (!row) return;
        const item={path:row.dataset.filePath??"",base:row.dataset.fileBase??"",name:row.dataset.fileName??"",kind:row.dataset.fileKind??"file"};
        if(e.key==="Delete"){e.preventDefault();setError("");setDeleting(item);}
        if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==="c"){e.preventDefault();run(()=>writeTerminalClipboard(item.path));}
      }} onContextMenuCapture={e => {
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-file-path]");
        setTarget(row ? { path: row.dataset.filePath ?? "", base: row.dataset.fileBase ?? "", name: row.dataset.fileName ?? "", kind: row.dataset.fileKind ?? "file" } : null);
      }}>{children}</div>
    </ContextMenuTrigger><ContextMenuContent className="rounded-sm border border-border text-xs">
      <ContextMenuItem disabled={!directory} onSelect={() => { if (directory) actions.onTerminal(directory); }}>Open in Terminal</ContextMenuItem>
      <ContextMenuItem disabled={!directory} onSelect={() => { if (directory) actions.onSourceControl(directory); }}>Open in Source Control</ContextMenuItem>
      <ContextMenuItem disabled={!directory} onSelect={() => { if (directory) actions.onHistory(directory); }}>Open Git History</ContextMenuItem>
      <ContextMenuItem disabled={!target && !files.path} onSelect={() => run(() => revealItemInDir(target?.path ?? files.path ?? ""))}>Reveal in {IS_MAC ? "Finder" : IS_WINDOWS ? "Explorer" : "File Manager"}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!directory} onSelect={() => { if (directory) {setName("");setError("");setCreating({base:directory,kind:"file"});} }}>New File</ContextMenuItem>
      <ContextMenuItem disabled={!directory} onSelect={() => { if (directory) {setName("");setError("");setCreating({base:directory,kind:"dir"});} }}>New Folder</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!target && !files.path} onSelect={() => run(() => writeTerminalClipboard(target?.path ?? files.path ?? ""))}>Copy Path</ContextMenuItem>
      <ContextMenuItem disabled={!target || !files.path} onSelect={() => run(() => writeTerminalClipboard(relativePath(files.path ?? "", target?.path ?? "")))}>Copy Relative Path</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!target || target.kind === "dir"} onSelect={() => { if (target) actions.onAttach(target.path); }}>Attach to Agent</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuCheckboxItem checked={files.hidden} onCheckedChange={files.toggleHidden}>Show hidden</ContextMenuCheckboxItem>
      <ContextMenuItem disabled={!files.path || parentPath(files.path) === files.path} onSelect={() => {if(files.path)files.navigate(parentPath(files.path));}}>Go up</ContextMenuItem>
      <ContextMenuItem onSelect={files.sync}>Sync terminal</ContextMenuItem>
      <ContextMenuItem onSelect={files.reload}>Refresh</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" disabled={!target || target.path === "/" || /^[A-Za-z]:\/?$/.test(target.path)} onSelect={() => {setError("");setDeleting(target);}}>Delete</ContextMenuItem>
    </ContextMenuContent></ContextMenu>
    <AlertDialog open={!!deleting} onOpenChange={open => {if(!open&&!busy)setDeleting(null);}}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle><AlertDialogDescription>This permanently deletes {deleting?.path}{deleting?.kind === "dir" ? " and its contents" : ""}.</AlertDialogDescription></AlertDialogHeader>
      {error && <p role="alert">{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={e => {e.preventDefault();void remove();}}>{busy ? "Deleting…" : "Delete"}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    <Dialog open={!!creating} onOpenChange={open => {if(!open&&!busy)setCreating(null);}}><DialogContent><DialogHeader><DialogTitle>New {creating?.kind === "dir" ? "folder" : "file"}</DialogTitle></DialogHeader>
      <form onSubmit={e => {e.preventDefault();void create();}} className="flex flex-col gap-3"><label htmlFor="new-file-name">Name</label><Input id="new-file-name" value={name} onChange={e=>setName(e.target.value)} autoFocus disabled={busy}/>{error&&<p role="alert">{error}</p>}<Button type="submit" disabled={busy||!name.trim()}>{busy?"Creating…":"Create"}</Button></form>
    </DialogContent></Dialog>
  </>;
}
