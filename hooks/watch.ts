// What the flow watches beside the tree: how long each tool takes and compactions.
// Plain data, no engine calls, like flow.ts.

export type ToolStat = { calls: number; fails: number; totalMs: number; maxMs: number }

export type CompactEntry = { at: number; loop: string; trigger: string; before?: number; after?: number; skip?: string }

export type Watch = {
  stats: Record<string, ToolStat>
  compacts: CompactEntry[]
}

export const KEEP_COMPACTS = 20

export function createWatch(): Watch {
  return { stats: {}, compacts: [] }
}

const capped = <T>(list: T[], item: T, max: number) => {
  list.push(item)
  if (list.length > max) list.splice(0, list.length - max)
}

export function timed(w: Watch, tool: string, ms: number, failed: boolean): void {
  const s = (w.stats[tool] ??= { calls: 0, fails: 0, totalMs: 0, maxMs: 0 })
  s.calls += 1
  if (failed) s.fails += 1
  s.totalMs += ms
  s.maxMs = Math.max(s.maxMs, ms)
}

/** Tools by the time they took in all, slowest first. */
export function topTools(w: Watch, n: number): (ToolStat & { tool: string })[] {
  return Object.entries(w.stats)
    .map(([tool, s]) => ({ tool, ...s }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, n)
}

export function compacted(w: Watch, entry: CompactEntry): void {
  capped(w.compacts, entry, KEEP_COMPACTS)
}

// ---- saved form -------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a saved Watch back, dropping whatever is not the shape it was saved in. */
export function restoredWatch(v: unknown): Watch {
  const w = createWatch()
  if (!isObj(v)) return w
  if (isObj(v.stats)) {
    for (const [tool, s] of Object.entries(v.stats)) {
      if (!isObj(s)) continue
      const num = (k: string) => (typeof s[k] === 'number' ? s[k] : 0)
      w.stats[tool] = { calls: num('calls'), fails: num('fails'), totalMs: num('totalMs'), maxMs: num('maxMs') }
    }
  }
  const list = <T>(x: unknown, ok: (e: Record<string, unknown>) => boolean): T[] =>
    Array.isArray(x) ? x.filter((e): e is T => isObj(e) && typeof e.at === 'number' && ok(e)) : []
  w.compacts = list<CompactEntry>(v.compacts, e => typeof e.trigger === 'string')
  return w
}

export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
