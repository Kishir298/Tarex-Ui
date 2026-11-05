import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { AGENT_LAUNCHERS, type AgentInstanceCount, type AgentLauncherId, validateAgentLaunchCommand } from "@/modules/agents/lib/launcher";
import { useAgentLaunchDefaults } from "@/modules/agents/lib/useAgentLaunchDefaults";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentLaunchCommands } from "@/modules/settings/store";
import { useEffect, useRef, useState } from "react";

export function TerminalAgentsSettings() {
  const commands = usePreferencesStore((state) => state.agentLaunchCommands);
  const { selection, select, hydrated, saving, error } = useAgentLaunchDefaults();
  return (
    <section className="flex flex-col gap-3" aria-label="Terminal agent settings">
      <div>
        <h2 className="text-sm font-medium">Terminal agents</h2>
        <p className="mt-1 text-xs text-muted-foreground">Set commands here once. The launch menu remembers your agent and pane count across restarts.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs">Default terminal agent
          <select aria-label="Default terminal agent" className="h-9 rounded-md border border-input bg-background px-2" value={selection.agent} disabled={!hydrated || saving} onChange={(event) => void select({ ...selection, agent: event.target.value as AgentLauncherId })}>
            {AGENT_LAUNCHERS.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Default panes
          <select aria-label="Default agent panes" className="h-9 rounded-md border border-input bg-background px-2" value={selection.instances} disabled={!hydrated || saving} onChange={(event) => void select({ ...selection, instances: Number(event.target.value) as AgentInstanceCount })}>
            {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} {count === 1 ? "pane" : "panes"}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-col gap-2">
        {AGENT_LAUNCHERS.map((agent) => <LaunchCommandEditor key={agent.id} agent={agent} command={commands[agent.id]} disabled={!hydrated} />)}
      </div>
    </section>
  );
}

function LaunchCommandEditor({ agent, command, disabled }: {
  agent: (typeof AGENT_LAUNCHERS)[number]; command: string; disabled: boolean;
}) {
  const [draft, setDraft] = useState(command);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const previous = useRef(command);
  const pending = useRef(false);
  useEffect(() => {
    const old = previous.current;
    previous.current = command;
    setDraft((value) => value === old ? command : value);
  }, [command]);
  const validation = validateAgentLaunchCommand(draft);
  const dirty = draft !== command;
  const save = async (value = draft) => {
    const valid = validateAgentLaunchCommand(value);
    if (disabled || pending.current || !valid.ok) return;
    if (valid.command === command) { setDraft(valid.command); return; }
    pending.current = true;
    setState("saving");
    setError("");
    try {
      await setAgentLaunchCommands({ ...usePreferencesStore.getState().agentLaunchCommands, [agent.id]: valid.command });
      setDraft(valid.command);
      setState("saved");
    } catch (failure) {
      setError(`Could not save: ${String(failure)}`);
      setState("idle");
    } finally { pending.current = false; }
  };
  return (
    <form className="rounded-lg border border-border/60 bg-card/40 p-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor={`agent-command-${agent.id}`} className="mb-2 flex items-center gap-2 text-xs font-medium"><AgentIcon agent={agent.id} size={15} />{agent.label} start command</label>
      <div className="flex gap-2">
        <Input id={`agent-command-${agent.id}`} value={draft} disabled={disabled || state === "saving"} aria-invalid={!validation.ok} onChange={(event) => { setDraft(event.target.value); setState("idle"); setError(""); }} onBlur={() => { if (dirty && validation.ok) void save(); }} spellCheck={false} autoCapitalize="off" autoCorrect="off" className="h-8 min-w-0 font-mono text-xs" />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || !dirty || !validation.ok || state === "saving"}>Save</Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled || command === agent.defaultCommand || state === "saving"} onClick={() => void save(agent.defaultCommand)}>Reset</Button>
      </div>
      <p role={error || !validation.ok ? "alert" : "status"} className={`mt-1 min-h-4 text-[11px] ${error || !validation.ok ? "text-destructive" : "text-muted-foreground"}`}>
        {error || (!validation.ok ? validation.error : state === "saving" ? "Saving…" : dirty ? "Unsaved changes" : state === "saved" ? "Saved" : "Aliases and flags supported. Saved when you leave the field.")}
      </p>
    </form>
  );
}
