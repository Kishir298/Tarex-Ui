export interface SystemSnapshot {
  hostname: string;
  os: string;
  kernel: string;
  architecture: string;
  uptime: number;
  cpuName: string;
  cpu: number[];
  memoryUsed: number;
  memoryTotal: number;
  swapUsed: number;
  swapTotal: number;
  processes: { pid: number; name: string; cpu: number; memory: number; started: number }[];
  disks: { mount: string; total: number; available: number }[];
}

export function bytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  const units = ["B", "K", "M", "G", "T"];
  const index = Math.min(
    4,
    Math.max(0, Math.floor(Math.log2(Math.max(1, value)) / 10)),
  );
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}

export function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`;
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent || "/";
}

export function joinPath(path: string, name: string): string {
  return `${path.replace(/[\\/]+$/, "")}/${name}`;
}

export function validEntryName(name: string): string {
  if (!name.trim() || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error("Enter a name without path separators or control characters.");
  return name;
}

export function relativePath(from: string, to: string): string {
  const a = from.replace(/\\/g,"/").split("/").filter(Boolean);
  const b = to.replace(/\\/g,"/").split("/").filter(Boolean);
  if (/^[A-Za-z]:$/.test(a[0] ?? "") && a[0].toLowerCase() !== b[0]?.toLowerCase()) return to;
  let common=0;
  while(common<a.length&&common<b.length&&a[common]===b[common])common++;
  return [...a.slice(common).map(()=>".."),...b.slice(common)].join("/")||".";
}

const SPECIAL_KEYS: Record<string, string> = {
  ESC: "\x1b",
  TAB: "\t",
  BACK: "\x7f",
  ENTER: "\r",
  SPACE: " ",
  LEFT: "\x1b[D",
  RIGHT: "\x1b[C",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
};

export function keySequence(
  key: string,
  shift: boolean,
  ctrl: boolean,
  alt: boolean,
  caps = false,
): string {
  if (SPECIAL_KEYS[key] !== undefined) return SPECIAL_KEYS[key];
  if (key.length !== 1) return "";
  let value = key;
  if (ctrl && /^[a-z[\]\\^_]$/i.test(key))
    value = String.fromCharCode(key.toUpperCase().charCodeAt(0) & 31);
  else if (/^[a-z]$/i.test(key))
    value = shift !== caps ? key.toUpperCase() : key.toLowerCase();
  else if (shift) {
    const normal = "`1234567890-=[]\\;',./";
    const shifted = '~!@#$%^&*()_+{}|:"<>?';
    const index = normal.indexOf(key);
    if (index !== -1) value = shifted[index];
  }
  return alt ? `\x1b${value}` : value;
}
