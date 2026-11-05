import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type PublicNetwork = { ip: string; city: string; region: string; country: string; latitude: number; longitude: number };

export function usePublicNetwork(route: string) {
  const [network, setNetwork] = useState<PublicNetwork | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed network route invalidates the native lookup cache.
  useEffect(() => {
    let alive = true;
    let visible = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!alive || !visible || pending) return;
      pending = true;
      try {
        const next = await invoke<PublicNetwork>("public_network");
        if (alive) { setNetwork(next); setError(""); }
      } catch (reason) {
        if (alive) { setNetwork(null); setError(String(reason)); }
      } finally {
        pending = false;
        if (alive && visible) timer = setTimeout(refresh, 600_000);
      }
    };
    const unsubscribe = subscribeWindowPresentation((state) => {
      visible = state.visible;
      clearTimeout(timer);
      if (visible) void refresh();
    });
    return () => { alive = false; clearTimeout(timer); unsubscribe(); };
  }, [route]);
  return { network, error };
}
