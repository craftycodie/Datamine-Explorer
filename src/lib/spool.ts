// How long spools stay in the temp folder. The Rust side (src-tauri/src/spool.rs) does the same for
// the desktop app; this is for the browser's OPFS.
export const SPOOL_AGE_MAXIMUM_MS = 7 * 24 * 60 * 60 * 1000;
export const SPOOL_KEEP = 5;

// The name a saved session is offered under: the spool's name, marked as a datamine log.
export function savedName(name: string): string {
  return name.startsWith("datamine_") ? name : `datamine_${name}`;
}

// A spool: its text file's name (the sidecar is `<name>.json`), when it was written last and the
// server it is from, when its sidecar says.
export interface SpoolGroup {
  name: string;
  modifiedMs: number;
  server?: string;
}

// The names to delete. A spool goes when it is older than a week, or when it is not among the
// newest few; the newest of each server stays however many servers there are, since the next
// connection to it carries on there. A spool a running explorer is writing is never listed.
export function spoolCleanupPlan(groups: readonly SpoolGroup[], nowMs: number, running: ReadonlySet<string> = new Set()): string[] {
  const idle = groups.filter((group) => !running.has(group.name)).sort((a, b) => b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name));
  const newest = new Set(idle.slice(0, SPOOL_KEEP).map((group) => group.name));
  const servers = new Set<string>();
  for (const group of idle) {
    if (group.server !== undefined && !servers.has(group.server)) {
      servers.add(group.server);
      newest.add(group.name);
    }
  }
  return idle.filter((group) => nowMs - group.modifiedMs > SPOOL_AGE_MAXIMUM_MS || !newest.has(group.name)).map((group) => group.name);
}
