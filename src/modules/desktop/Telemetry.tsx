// biome-ignore-all lint/suspicious/noArrayIndexKey: Hardware core indexes and fixed memory cells never reorder.
import { bytes, type SystemSnapshot } from "@/modules/desktop/model";
import { Processes } from "@/modules/desktop/Processes";
import { usePublicNetwork } from "@/modules/desktop/usePublicNetwork";
import { NetworkConnections } from "@/modules/desktop/NetworkConnections";
import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

type Sample = { cpu: number; received: number; transmitted: number; interface:string|null };

export function useTelemetry(enabled = true) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [error, setError] = useState("");
  const [revision,setRevision]=useState(0);
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let pending = false;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceDetails=revision>0;
    const sample = async () => {
      if (disposed || pending || !visible) return;
      pending = true;
      try {
        const next = await invoke<SystemSnapshot>("dashboard_snapshot",{forceDetails});
        forceDetails=false;
        if (!disposed && visible) {
          setSnapshot(next);
          setError("");
          const cpu =
            next.cpu.reduce((sum, value) => sum + value, 0) /
            Math.max(1, next.cpu.length);
          setHistory((previous) => [
            ...(previous[previous.length-1]?.interface===next.interface?previous.slice(-59):[]),
            { cpu, received: next.received, transmitted: next.transmitted,interface:next.interface },
          ]);
        }
      } catch (e) {
        if (!disposed && visible) setError(String(e));
      } finally {
        pending = false;
        if (!disposed && visible) timer = setTimeout(sample, 5000);
      }
    };
    const unsubscribe = subscribeWindowPresentation((state) => {
      visible = state.visible;
      clearTimeout(timer);
      if (visible) void sample();
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled,revision]);
  return { snapshot, history, error,refresh };
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const unsubscribe = subscribeWindowPresentation(({ visible }) => {
      clearInterval(timer);
      if (visible) {
        setNow(new Date());
        timer = setInterval(() => setNow(new Date()), 1000);
      }
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);
  return (
    <>
      <time className="terex-clock" dateTime={now.toISOString()}>
        {now.toLocaleTimeString("en-GB")}
      </time>
      <div className="terex-date">
        {now
          .toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "2-digit",
            weekday: "short",
          })
          .toUpperCase()}
      </div>
    </>
  );
}

function Chart({
  values,
  second,
  max = 100,
  label,
}: {
  values: number[];
  second?: number[];
  max?: number;
  label: string;
}) {
  const line = (samples: number[]) =>
    samples
      .map(
        (value, index) =>
          `${200 - (samples.length - 1 - index) * (200 / 59)},${58 - (Math.min(max, Math.max(0, value)) / Math.max(1, max)) * 52}`,
      )
      .join(" ");
  return (
    <svg
      className="terex-chart"
      viewBox="0 0 200 60"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <path
        className="terex-chart-grid"
        d="M0 0H200M0 15H200M0 30H200M0 45H200M0 59H200M0 0V60M40 0V60M80 0V60M120 0V60M160 0V60M200 0V60"
      />
      <polyline
        points={line(values)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        vectorEffect="non-scaling-stroke"
      />
      {second && (
        <polyline
          points={line(second)}
          fill="none"
          stroke="var(--terex-bright)"
          strokeWidth="1"
          opacity=".7"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export function SystemRail({
  snapshot: s,
  history,
  error,
  refresh,
}: ReturnType<typeof useTelemetry>) {
  const average = s
    ? s.cpu.reduce((a, b) => a + b, 0) / Math.max(1, s.cpu.length)
    : 0;
  const memory = s?.memoryTotal ? s.memoryUsed / s.memoryTotal : 0;
  const uptime = s
    ? `${Math.floor(s.uptime / 86400)}D ${String(Math.floor(s.uptime / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s.uptime / 60) % 60).padStart(2, "0")}`
    : "--";
  return (
    <aside className="terex-system-rail" aria-label="Live system monitor">
      <div className="terex-rule">
        <span>PANEL</span>
        <span>SYSTEM</span>
      </div>
      <Clock />
      <dl className="terex-machine-summary">
        <div>
          <dt>UPTIME</dt>
          <dd>{uptime}</dd>
        </div>
        <div>
          <dt>TYPE</dt>
          <dd>{s?.os ?? "--"}</dd>
        </div>
        <div>
          <dt>ARCH</dt>
          <dd>{s?.architecture ?? "--"}</dd>
        </div>
      </dl>
      <div className="terex-hardware">
        <span>HOST / KERNEL</span>
        <strong title={s?.hostname}>{s?.hostname ?? "CONNECTING"}</strong>
        <span>{s?.kernel ?? "NATIVE SYSTEM"}</span>
        <strong title={s?.cpuName}>{s?.cpuName ?? "--"}</strong>
      </div>
      <div className="terex-rule">
        <span>CPU USAGE</span>
        <span>{s ? `${average.toFixed(1)}%` : "--"}</span>
      </div>
      <div className="terex-graph-caption">
        <span>AVG. {s?.cpu.length ?? "--"} THREADS</span>
        <span>100%</span>
      </div>
      <Chart
        values={history.map((sample) => sample.cpu)}
        label={`CPU usage ${average.toFixed(1)} percent`}
      />
      <div className="terex-core-bars">
        {s?.cpu.map((value, index) => (
          <div
            key={`core-${index}`}
            title={`Core ${index + 1}: ${value.toFixed(1)}%`}
          >
            <i style={{ height: `${Math.max(2, value)}%` }} />
          </div>
        ))}
      </div>
      <dl className="terex-machine-summary">
        <div>
          <dt>CPU</dt>
          <dd>{s ? `${average.toFixed(0)}%` : "--"}</dd>
        </div>
        <div>
          <dt>CORES</dt>
          <dd>{s?.cpu.length ?? "--"}</dd>
        </div>
        <div>
          <dt>TASKS</dt>
          <dd>{s ? "TOP 5" : "--"}</dd>
        </div>
      </dl>
      <div className="terex-rule">
        <span>MEMORY</span>
        <span>
          {bytes(s?.memoryUsed)} / {bytes(s?.memoryTotal)}
        </span>
      </div>
      <div
        className="terex-memory-map"
        role="img"
        aria-label={`Memory ${(memory * 100).toFixed(0)} percent used`}
      >
        {Array.from({ length: 200 }, (_, index) => (
          <i
            key={`cell-${index}`}
            className={index < memory * 200 ? "used" : ""}
          />
        ))}
      </div>
      <div className="terex-rule">
        <span>SWAP</span>
        <span>
          {bytes(s?.swapUsed)} / {bytes(s?.swapTotal)}
        </span>
      </div>
      <div className="terex-meter">
        <i
          style={{
            width: `${s?.swapTotal ? (s.swapUsed / s.swapTotal) * 100 : 0}%`,
          }}
        />
      </div>
      <div className="terex-rule">
        <span>TOP PROCESSES</span>
        <span>CPU / MEM</span>
      </div>
      <Processes processes={s?.processes??[]} refresh={refresh}/>
      {error && (
        <p role="status" className="terex-error" title={error}>
          SYSTEM DATA UNAVAILABLE
        </p>
      )}
    </aside>
  );
}

export function NetworkRail({
  snapshot: s,
  history,
}: ReturnType<typeof useTelemetry>) {
  const {network,error}=usePublicNetwork(`${s?.interface??""}/${s?.address??""}`);
  const max = Math.max(
    1024,
    ...history.flatMap((sample) => [sample.received, sample.transmitted]),
  );
  return (
    <aside className="terex-network-rail" aria-label="Live network monitor">
      <div className="terex-rule">
        <span>PANEL</span>
        <span>NETWORK</span>
      </div>
      <div className="terex-rule">
        <span>NETWORK STATUS</span>
        <span>PUBLIC</span>
      </div>
      <dl className="terex-network-status">
        <div>
          <dt>STATE</dt>
          <dd>{s ? (s.address ? network ? "ONLINE" : "LINK UP" : "OFFLINE") : "--"}</dd>
        </div>
        <div>
          <dt>INTERFACE</dt>
          <dd>{s?.interface ?? "--"}</dd>
        </div>
        <div>
          <dt>PUBLIC IP</dt>
          <dd title={error}>{network?.ip ?? "--"}</dd>
        </div>
      </dl>
      <NetworkConnections />
      <div className="terex-rule">
        <span>NETWORK TRAFFIC</span>
        <span>{bytes(max)}/s</span>
      </div>
      <div className="terex-traffic-summary">
        <span>↓ {bytes(s?.received)}/s</span>
        <span>↑ {bytes(s?.transmitted)}/s</span>
      </div>
      <Chart
        values={history.map((sample) => sample.received)}
        second={history.map((sample) => sample.transmitted)}
        max={max}
        label="Network receive and transmit rates over the last five minutes"
      />
      <div className="terex-transfer-total">
        <span>RECEIVED {bytes(s?.totalReceived)}</span>
        <span>TRANSMITTED {bytes(s?.totalTransmitted)}</span>
      </div>
    </aside>
  );
}
