import { useEffect, useRef, useState } from "react";
import type { AgentLaunchDefaults } from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentLaunchDefaults } from "@/modules/settings/store";

export function useAgentLaunchDefaults() {
  const stored = usePreferencesStore((state) => state.agentLaunchDefaults);
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const [selection, setSelection] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  useEffect(() => setSelection(stored), [stored]);

  const select = async (next: AgentLaunchDefaults) => {
    if (!hydrated || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    setSelection(next);
    try {
      await setAgentLaunchDefaults(next);
    } catch (failure) {
      setSelection(usePreferencesStore.getState().agentLaunchDefaults);
      setError(`Could not save launch defaults: ${String(failure)}`);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return { selection, select, saving, error, hydrated };
}
