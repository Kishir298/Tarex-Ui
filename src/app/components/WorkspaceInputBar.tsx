import { homeRelativePath } from "@/lib/homeRelativePath";
import { AiInputBarConnect } from "@/modules/ai";
import { Chip } from "@/modules/ai/components/Chip";
import { ChipsRow } from "@/modules/ai/components/ChipsRow";
import { useComposer } from "@/modules/ai/lib/composer";
import {
  AiContentGenerator02Icon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useGitBranch } from "./useGitBranch";

const AiComposerInput = lazy(() =>
  import("@/modules/ai/components/AiComposerInput").then((m) => ({
    default: m.AiComposerInput,
  })),
);

type Props = {
  terminalBusy: boolean;
  isTerminalTab: boolean;
  cwd: string | null;
  home: string | null;
  hasComposer: boolean;
  panelOpen: boolean;
  keysLoaded: boolean;
  onConnect: () => void;
};

export function WorkspaceInputBar({
  terminalBusy,
  isTerminalTab,
  cwd,
  home,
  hasComposer,
  panelOpen,
  keysLoaded,
  onConnect,
}: Props) {
  const c = useComposer();
  const open = keysLoaded && panelOpen;
  const [loaded, setLoaded] = useState(false);
  const [promptNonce, setPromptNonce] = useState(0);
  const wasBusy = useRef(terminalBusy);

  useEffect(() => {
    if (wasBusy.current && !terminalBusy) setPromptNonce((n) => n + 1);
    wasBusy.current = terminalBusy;
  }, [terminalBusy]);
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);

  const branch = useGitBranch(open && isTerminalTab ? cwd : null, promptNonce);
  if (!loaded && !open) return null;

  return (
    <section
      data-ai-input-bar
      data-state={open ? "open" : "closed"}
      className="tarex-reveal"
      aria-label="AI agent composer"
      aria-hidden={!open}
      inert={!open}
    >
      <div>
        {!hasComposer ? (
          <AiInputBarConnect onAdd={onConnect} />
        ) : (
          <div className="shrink-0 border-t border-border/60 bg-foreground/[0.02] px-3 py-2">
            <div className="flex flex-col gap-2 px-1 py-1">
              <ChipsRow
                leading={
                  <>
                    <Chip tone="violet" icon={AiContentGenerator02Icon}>
                      AI AGENT
                    </Chip>
                    {cwd && (
                      <Chip tone="blue" icon={Folder01Icon} title={cwd}>
                        {homeRelativePath(cwd, home)}
                      </Chip>
                    )}
                    {branch && (
                      <Chip tone="violet" icon={GitBranchIcon} title={`Branch: ${branch}`}>
                        {branch}
                      </Chip>
                    )}
                  </>
                }
                files={c.files}
                onRemoveFile={c.removeFile}
                snippets={c.pickedSnippets}
                onRemoveSnippet={(id) => {
                  const snippet = c.pickedSnippets.find((s) => s.id === id);
                  c.removeSnippet(id);
                  if (!snippet) return;
                  const re = new RegExp(`(^|\\s)#${snippet.handle}\\b ?`);
                  c.setValue((v) => v.replace(re, (_match, lead: string) => lead));
                }}
                commands={c.pickedCommands}
                onRemoveCommand={c.removeCommand}
              />
              <Suspense fallback={null}>
                <AiComposerInput focusWhenReady={open} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
