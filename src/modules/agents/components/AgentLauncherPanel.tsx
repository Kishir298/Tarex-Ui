import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { AGENT_LAUNCHERS, type AgentInstanceCount, type AgentLaunchRequest, validateAgentLaunchCommand } from "@/modules/agents/lib/launcher";
import { useAgentLaunchDefaults } from "@/modules/agents/lib/useAgentLaunchDefaults";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { ArrowLeft01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

type Props = { onBack: () => void; onLaunch: (request: AgentLaunchRequest) => void };
const INSTANCE_COUNTS: AgentInstanceCount[] = [1, 2, 3, 4];

export function AgentLauncherPanel({ onBack, onLaunch }: Props) {
  const commands = usePreferencesStore((state) => state.agentLaunchCommands);
  const { selection, select, saving, error, hydrated } = useAgentLaunchDefaults();
  const { agent: agentId, instances } = selection;
  const validation = validateAgentLaunchCommand(commands[agentId]);

  return (
    <form className="animate-in fade-in-0 slide-in-from-right-2 duration-150" onSubmit={(event) => {
      event.preventDefault();
      if (hydrated && !saving && validation.ok) onLaunch({ ...selection, command: validation.command });
    }}>
      <div className="flex h-10 items-center gap-2 px-1">
        <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to new tab menu">
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={1.75} />
        </Button>
        <div><div className="text-[13px] font-medium">Launch agents</div><div className="text-[10px] text-muted-foreground">Your agent and pane count are remembered</div></div>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1 border-t border-border/60 pt-1.5">
        {AGENT_LAUNCHERS.map((agent) => (
          <button key={agent.id} type="button" disabled={!hydrated || saving} aria-pressed={agent.id === agentId} onClick={() => void select({ ...selection, agent: agent.id })}
            className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", agent.id === agentId ? "border-primary/35 bg-primary/10 text-foreground" : "border-transparent bg-muted/40 text-muted-foreground hover:bg-accent")}>
            <AgentIcon agent={agent.id} size={16} className="shrink-0" />
            <span>{agent.label}</span>
          </button>
        ))}
      </div>
      <fieldset className="mt-3">
        <legend className="mb-1.5 text-[11px] text-muted-foreground">Panes</legend>
        <div className="grid grid-cols-4 gap-1">
          {INSTANCE_COUNTS.map((count) => (
            <button key={count} type="button" disabled={!hydrated || saving} aria-label={`${count} ${count === 1 ? "instance" : "instances"}`} aria-pressed={instances === count} onClick={() => void select({ ...selection, instances: count })}
              className={cn("flex h-9 items-center justify-center gap-1.5 rounded-xl border text-xs focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", instances === count ? "border-primary/35 bg-primary/10" : "border-border/60 hover:bg-accent")}>
              <PaneGlyph count={count} />{count}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="my-3 rounded-lg border border-border/60 px-2.5 py-2">
        <div className="text-[10px] text-muted-foreground">Saved start command</div>
        <code className="mt-1 block break-all text-xs">{commands[agentId]}</code>
        <button type="button" className="mt-2 text-[11px] text-primary underline-offset-2 hover:underline" onClick={() => {
          void openSettingsWindow("agents").catch((failure) => toast.error(String(failure)));
        }}>Edit in Config → Agents</button>
      </div>
      {error && <p className="mb-2 text-xs text-destructive" role="alert">{error}</p>}
      {!validation.ok && <p className="mb-2 text-xs text-destructive" role="alert">{validation.error}</p>}
      <Button type="submit" size="sm" className="w-full" disabled={!hydrated || saving || !validation.ok}>
        <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={2} />
        {saving ? "Saving…" : `Launch ${instances} ${instances === 1 ? "agent" : "agents"}`}
      </Button>
    </form>
  );
}

function PaneGlyph({ count }: { count: AgentInstanceCount }) {
  return (
    <span aria-hidden="true" className={cn("grid size-3 gap-px rounded-[2px] border border-current/50 p-px", count === 1 ? "grid-cols-1" : "grid-cols-2", count > 2 && "grid-rows-2")}>
      {INSTANCE_COUNTS.slice(0, count).map((pane) => <span key={pane} className={cn("rounded-[1px] bg-current opacity-75", count === 3 && pane === 1 && "row-span-2")} />)}
    </span>
  );
}
