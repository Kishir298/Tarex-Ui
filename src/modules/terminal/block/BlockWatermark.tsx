import { cn } from "@/lib/utils";
import { useShortcutLabel } from "@/modules/shortcuts";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  blockWatermarkState,
  type WatermarkState,
} from "../lib/terminalSessionApi";

type Props = {
  leafId: number;
  subscribe: (cb: () => void) => () => void;
};

const NOOP_SUBSCRIBE = () => () => {};
const DEAD = (): WatermarkState => "dead";

// First-run hints over an untouched block terminal. Once the leaf runs a
// command the component unmounts for good and drops its subscription.
export function BlockWatermark({ leafId, subscribe }: Props) {
  const [gone, setGone] = useState(false);
  const state = useSyncExternalStore(
    gone ? NOOP_SUBSCRIBE : subscribe,
    gone ? DEAD : () => blockWatermarkState(leafId),
  );

  useEffect(() => {
    if (gone || state !== "dead") return;
    const t = setTimeout(() => setGone(true), 600);
    return () => clearTimeout(t);
  }, [state, gone]);

  if (gone) return null;

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-[5] flex select-none flex-col items-center justify-center gap-8",
        "transition-[opacity,transform] duration-500 ease-out",
        state === "visible"
          ? "translate-y-0 opacity-100"
          : "translate-y-2 opacity-0",
      )}
    >
      <div className="max-w-sm px-5 text-center">
        <strong className="text-xs tracking-[.16em] text-primary">COMMAND BLOCKS</strong>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Type in the terminal. Each command gets its own output group with an exit status, copy, and rerun controls.</p>
      </div>
      <div className="grid grid-cols-[auto_auto] items-center gap-x-5 gap-y-3 px-4 text-[12px]">
        <Hint label="Previous command block" shortcut="blocks.prev" />
        <Hint label="Next command block" shortcut="blocks.next" />
      </div>
    </div>
  );
}

function Hint(props: {
  label: string;
  keys?: string;
  shortcut?: Parameters<typeof useShortcutLabel>[0];
}) {
  return (
    <>
      <span className="justify-self-start text-muted-foreground/60">
        {props.label}
      </span>
      <span className="flex items-center gap-1 justify-self-end">
        {props.shortcut ? (
          <ShortcutKeys id={props.shortcut} />
        ) : (
          <Key>{props.keys}</Key>
        )}
      </span>
    </>
  );
}

function ShortcutKeys({ id }: { id: Parameters<typeof useShortcutLabel>[0] }) {
  const tokens = useShortcutLabel(id).split(" ");
  return (
    <>
      {tokens.map((t) => (
        <Key key={t}>{t}</Key>
      ))}
    </>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md border border-border/45 bg-muted/30 px-1.5 font-sans text-[11px] font-medium text-muted-foreground/80">
      {children}
    </kbd>
  );
}
