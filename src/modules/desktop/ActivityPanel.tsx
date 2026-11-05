import "@/styles/desktop-activity.css";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

const ActivitySessions = lazy(() => import("@/modules/desktop/ActivitySessions").then((module) => ({ default: module.ActivitySessions })));
const ActivityJobs = lazy(() => import("@/modules/desktop/ActivityJobs").then((module) => ({ default: module.ActivityJobs })));

export type ActivityPanelProps = {
  tabs: Tab[];
  activeTabId: number;
  activeLeafId: number | null;
  onActivate: (tabId: number, leafId: number) => void;
  onOpenAi: () => void;
  onClose: () => void;
  onGit: (() => void) | null;
  onPreview: () => void;
};

export function ActivityPanel(props: ActivityPanelProps) {
  const close = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState("sessions");
  useEffect(() => { close.current?.focus(); }, []);

  return (
    <section
      id="terex-activity-panel"
      className="terex-activity-panel"
      aria-label="Activity panel"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header className="terex-activity-header">
        <div>
          <h2>ACTIVITY</h2>
          <p>Your sessions and background work</p>
        </div>
        <button ref={close} type="button" onClick={props.onClose} aria-label="Close Activity" title="Close Activity (Esc)">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <Tabs value={view} onValueChange={setView} className="terex-activity-tabs">
        <TabsList aria-label="Activity views" className="terex-activity-tablist">
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions" className="terex-activity-body">
          <Suspense fallback={<p className="terex-activity-loading" role="status">Loading sessions…</p>}>
            <ActivitySessions tabs={props.tabs} activeTabId={props.activeTabId} activeLeafId={props.activeLeafId} onActivate={props.onActivate} onOpenAi={props.onOpenAi} />
          </Suspense>
        </TabsContent>
        <TabsContent value="jobs" className="terex-activity-body">
          <Suspense fallback={<p className="terex-activity-loading" role="status">Loading background jobs…</p>}>
            <ActivityJobs />
          </Suspense>
        </TabsContent>
      </Tabs>
      <footer className="terex-activity-tools">
        <span>WORKSPACE TOOLS</span>
        <nav aria-label="Activity workspace tools">
          <button type="button" disabled={!props.onGit} onClick={() => props.onGit?.()}>Git changes</button>
          <button type="button" onClick={props.onPreview}>Web preview</button>
          <button type="button" onClick={props.onOpenAi}>AI agent</button>
        </nav>
      </footer>
    </section>
  );
}
