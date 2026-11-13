import { OsIcon } from "@/app/components/OsIcon";
import { homeRelativePath } from "@/lib/homeRelativePath";
import {
  Folder01Icon,
  Home01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function CustomPrompt({
  cwd,
  home,
  os,
}: {
  cwd: string | null;
  home: string | null;
  os: string | null;
}) {
  const relative = cwd ? homeRelativePath(cwd, home) : "…";
  const path = relative === "~/" ? "~" : relative;
  const inHome = path === "~" || path.startsWith("~/");
  const knownOs = os === "macOS" || os === "Windows" || os === "Linux";
  return (
    <span
      className="tarex-shell-prompt"
      role="img"
      aria-label={`${os ?? "System"} terminal prompt, ${path}`}
      data-os={os ?? "unknown"}
      title={cwd ?? "Waiting for shell directory"}
    >
      <span className="tarex-prompt-os" aria-hidden="true">
        {knownOs ? (
          <OsIcon os={os} />
        ) : (
          <HugeiconsIcon icon={TerminalIcon} size={14} />
        )}
      </span>
      <span className="tarex-prompt-path" aria-hidden="true">
        <HugeiconsIcon icon={inHome ? Home01Icon : Folder01Icon} size={14} />
        <span>{path}</span>
      </span>
    </span>
  );
}
