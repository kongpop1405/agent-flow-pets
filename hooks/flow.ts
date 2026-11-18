// The agent flow as plain data: the main loop, the subagents it spawned, and
// what context crossed between them. No engine calls here, so the tests drive
// it directly and the pane only reads it.

export const MAIN = 'main'

export type Status = 'running' | 'done' | 'failed' | 'aborted'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type ToolUse = { tool: string; label: string; isError?: boolean; ms?: number }

export type FlowNode = {
  /** the loop's agent id; `main` for the main loop */
  id: string
  /** the loop that spawned it; undefined on main */
  parentId?: string
  /** agent type (`Explore`, `general-purpose`, `fork`, ...) */
  type: string
  /** the Agent call's short description */
  description: string
  model?: string
  status: Status
  /** inherits the parent's whole context instead of starting from a prompt */
  fork: boolean
  background: boolean
  /** context handed down: the prompt it was given */
  prompt: string
  /** context handed back up: its final answer */
  answer?: string
  /** input tokens of its latest request: how full its window is now */
  contextTokens?: number
  peakContext?: number
  outputTokens: number
  steps: number
  toolCount: number
  /** the most recent tool calls, newest last */
  tools: ToolUse[]
  startedAt: number
  durationMs?: number
  /** a teammate between turns: drawn as done, but kept by trimming until it ends */
  idle?: boolean
  /** the main-loop turn it was spawned in (1-based) */
  turn: number
  /** a loop the flow saw work but no spawn for (a workflow's agent, an engine fork) */
  unlisted?: boolean
}

export type Flow = {
  nodes: Map<string, FlowNode>
  /** spawn order, main first */
  order: string[]
  turn: number
  /** the main loop's window, from session.measure */
  window?: number
  percent?: number
}

export const KEEP_TOOLS = 8

export function createFlow(now = 0): Flow {
  const main: FlowNode = {
    id: MAIN,
    type: 'main',
    description: 'main loop',
    status: 'done',
    fork: false,
    background: false,
    prompt: '',
    outputTokens: 0,
    steps: 0,
    toolCount: 0,
    tools: [],
    startedAt: now,
    turn: 0,
  }
  return { nodes: new Map([[MAIN, main]]), order: [MAIN], turn: 0 }
}

export const loopId = (agentId: string | undefined) => agentId ?? MAIN

/** Rough tokens of a text: 4 characters each, as the engine's own estimates count. */
export function estimateTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/** What a request was answered over: uncached, cache-written and cache-read input together. */
export function contextOf(usage: Usage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

export function mainTurn(flow: Flow, text: string, now: number): void {
  const main = flow.nodes.get(MAIN)!
  flow.turn += 1
  main.turn = flow.turn
  main.status = 'running'
  main.startedAt = now
  main.durationMs = undefined
  // a continuation carries no typed prompt: keep the one before
  if (text) main.prompt = text
}

export type SpawnFacts = {
  agentId: string
  parentAgentId?: string
  description: string
  subagentType: string
  prompt: string
  fork: boolean
  background: boolean
  model?: string
  /** A resumed subagent or a teammate back from disk (2.1.299): same node, its prompt is a message. */
  resumed?: boolean
}

export function spawned(flow: Flow, s: SpawnFacts, now: number): FlowNode {
  const known = flow.nodes.get(s.agentId)
  const parentId =
    s.resumed && known ? known.parentId : s.parentAgentId && flow.nodes.has(s.parentAgentId) ? s.parentAgentId : MAIN
  const node: FlowNode = {
    ...(known ?? {
      outputTokens: 0,
      steps: 0,
      toolCount: 0,
      tools: [],
      startedAt: now,
    }),
    id: s.agentId,
    parentId,
    type: s.subagentType,
    description: s.description,
    model: s.model ?? known?.model,
    status: s.resumed ? 'running' : (known?.status ?? 'running'),
    // a resumed node is working again: its last answer and duration are no longer current
    ...(s.resumed ? { answer: undefined, durationMs: undefined, idle: undefined } : {}),
    fork: s.fork,
    background: s.background,
    // a resume's prompt is the message that woke it, not its task: keep the task
    // (a node trimmed or never seen keeps only the message, marked as one)
    prompt: s.resumed ? (known ? known.prompt : `(resumed) ${s.prompt}`) : s.prompt,
    turn: flow.turn,
    unlisted: false,
  }
  flow.nodes.set(s.agentId, node)
  if (!known) flow.order.push(s.agentId)
  return node
}

/** The node an event's loop maps to, made on the spot for a loop no spawn announced. */
export function nodeFor(flow: Flow, agentId: string | undefined, now: number): FlowNode {
  const id = loopId(agentId)
  const known = flow.nodes.get(id)
  if (known) return known
  const node: FlowNode = {
    id,
    parentId: MAIN,
    type: 'loop',
    description: `loop ${id.slice(0, 8)}`,
    status: 'running',
    fork: false,
    background: false,
    prompt: '',
    outputTokens: 0,
    steps: 0,
    toolCount: 0,
    tools: [],
    startedAt: now,
    turn: flow.turn,
    unlisted: true,
  }
  flow.nodes.set(id, node)
  flow.order.push(id)
  return node
}

export function stepped(flow: Flow, agentId: string | undefined, usage: Usage | null, now: number): void {
  const node = nodeFor(flow, agentId, now)
  node.steps += 1
  if (node.id !== MAIN && node.status !== 'running') node.status = 'running'
  node.idle = undefined
  if (!usage) return
  const ctx = contextOf(usage)
  node.contextTokens = ctx
  node.peakContext = Math.max(node.peakContext ?? 0, ctx)
  node.outputTokens += usage.output_tokens
}

export function toolRan(flow: Flow, agentId: string | undefined, use: ToolUse, now: number): void {
  const node = nodeFor(flow, agentId, now)
  node.toolCount += 1
  node.tools.push(use)
  if (node.tools.length > KEEP_TOOLS) node.tools.splice(0, node.tools.length - KEEP_TOOLS)
}

export type CompleteFacts = {
  answer: string
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  durationMs: number
  model?: string
}

export function completed(flow: Flow, agentId: string | undefined, c: CompleteFacts, now: number): void {
  const node = nodeFor(flow, agentId, now)
  node.status = c.reason === 'answer' ? 'done' : c.reason === 'aborted' ? 'aborted' : 'failed'
  node.answer = c.answer
  node.durationMs = c.durationMs
  if (c.model) node.model = c.model
}

/** Folds `$.agent.list()` statuses in: a background agent killed outside our view, a name. */
export function synced(flow: Flow, list: readonly { id: string; status: string; type: string; description: string }[]): void {
  for (const info of list) {
    const node = flow.nodes.get(info.id)
    if (!node) continue
    if (node.unlisted) {
      node.unlisted = false
      node.type = info.type
      node.description = info.description
    }
    if (node.status === 'running') {
      if (info.status === 'completed') node.status = 'done'
      else if (info.status === 'failed') node.status = 'failed'
      else if (info.status === 'killed') node.status = 'aborted'
      // a teammate between turns: its turn is done; the next step it takes marks it running again
      else if (info.status === 'idle') {
        node.status = 'done'
        node.idle = true
      }
    }
  }
}

// Runs outside this session (the lane-home dispatcher's qwen sessions, the gate-runner) as
// `hooks/lane-home.sh` reports them; they share the node map, the prefix keeps ids apart.
export type LaneRun = { id: string; type: 'qwen' | 'gate-run'; kind: string; startedAt: number; title: string }
export type LaneReport = { alive: LaneRun[]; exits: Map<string, number> }

// One node per try: a retry under the old id would overwrite the failed try the user wants to look back at.
export const laneId = (issue: string, attempt: string) => `lane:${issue}:${attempt}`
const LANE_SETTLE_MS = 90_000

export function parseLane(text: string): LaneReport {
  const alive: LaneRun[] = []
  const exits = new Map<string, number>()
  for (const line of text.split('\n')) {
    const [tag, a = '', b = '', c = '', d = '', ...rest] = line.replace(/\r$/, '').split('\t')
    if (tag === 'A' && /^\d+$/.test(a) && /^\d+$/.test(d)) {
      const nth = d === '1' ? '' : ` ครั้งที่ ${d}`
      alive.push({ id: laneId(a, d), type: 'qwen', kind: b, startedAt: Number(c) * 1000 || 0, title: `#${a}${nth} ${rest.join(' ')}`.trim() })
    } else if (tag === 'E' && /^\d+$/.test(a) && /^\d+$/.test(b) && /^\d+$/.test(c)) {
      exits.set(laneId(a, b), Number(c))
    } else if (tag === 'G' && /^\d+$/.test(a)) {
      alive.push({ id: 'lane:gate-runner', type: 'gate-run', kind: 'gate-run', startedAt: Number(b) * 1000 || 0, title: [c, ...rest].join(' ').trim() || 'gate-runner' })
    }
  }
  return { alive, exits }
}

/** Folds a lane report in: new runs join under main, runs whose pid is gone end. Returns whether anything changed and whether a run is new. */
export function laneSynced(flow: Flow, report: LaneReport, now: number): { changed: boolean; added: boolean } {
  let changed = false
  let added = false
  const seen = new Set<string>()
  for (const run of report.alive) {
    seen.add(run.id)
    const known = flow.nodes.get(run.id)
    if (known && known.status === 'running') continue
    const node = spawned(
      flow,
      { agentId: run.id, description: run.title, subagentType: run.type, prompt: `${run.type} · ${run.kind}`, fork: false, background: true, model: run.type === 'qwen' ? 'qwen' : undefined },
      now,
    )
    node.status = 'running'
    node.startedAt = run.startedAt || now
    node.durationMs = undefined
    changed = true
    added = true
  }
  for (const node of flow.nodes.values()) {
    if (!node.id.startsWith('lane:') || seen.has(node.id)) continue
    const exit = report.exits.get(node.id)
    // The pid file can go a poll before the dispatcher logs its end line, and an older run's
    // end line may be what we read then: settle a just-ended run again once the newer line lands.
    const justEnded = node.status !== 'running' && node.durationMs !== undefined && now - (node.startedAt + node.durationMs) < LANE_SETTLE_MS
    if (justEnded) {
      const settled = exit === undefined || exit === 0 ? 'done' : 'failed'
      if (exit !== undefined && (settled !== node.status || node.answer !== `exit ${exit}`)) {
        node.status = settled
        node.answer = `exit ${exit}`
        changed = true
      }
      continue
    }
    if (node.status !== 'running') continue
    node.status = exit === undefined || exit === 0 ? 'done' : 'failed'
    node.durationMs = now - node.startedAt
    if (exit !== undefined) node.answer = `exit ${exit}`
    changed = true
  }
  return { changed, added }
}

/** Drops the oldest finished subagents past `max`, and their subtrees with them. */
export function trimmed(flow: Flow, max: number): void {
  const subs = flow.order.filter(id => id !== MAIN)
  let over = subs.length - max
  for (const id of subs) {
    if (over <= 0) break
    if (!flow.nodes.has(id)) continue
    const branch = subtree(flow, id)
    if (branch.some(x => flow.nodes.get(x)?.status === 'running' || flow.nodes.get(x)?.idle)) continue
    for (const gone of branch) {
      flow.nodes.delete(gone)
      flow.order = flow.order.filter(x => x !== gone)
      over -= 1
    }
  }
}

/** Drops every finished branch, keeps what still runs; answers the ids it dropped. */
export function forgetFinished(flow: Flow): string[] {
  const before = [...flow.nodes.keys()]
  trimmed(flow, 0)
  return before.filter(id => !flow.nodes.has(id))
}

/** A /clear: the conversation starts over, so the main loop's turn count and prompt do too. */
export function restarted(flow: Flow, now: number): string[] {
  const gone = forgetFinished(flow)
  const main = flow.nodes.get(MAIN)!
  flow.turn = 0
  Object.assign(main, { turn: 0, prompt: '', steps: 0, toolCount: 0, tools: [], outputTokens: 0, startedAt: now })
  main.answer = undefined
  main.durationMs = undefined
  main.peakContext = undefined
  // still-running agents now belong to turn 0 of the fresh conversation
  for (const n of flow.nodes.values()) if (n.id !== MAIN) n.turn = 0
  return gone
}

export function children(flow: Flow, id: string): FlowNode[] {
  return flow.order.map(x => flow.nodes.get(x)!).filter(n => n && n.parentId === id)
}

export function subtree(flow: Flow, id: string): string[] {
  return [id, ...children(flow, id).flatMap(c => subtree(flow, c.id))]
}

export type Row = { node: FlowNode; depth: number; prefix: string }
/** The line that stands for a parent's older done shells: `hidden` folded away, or 0 once opened. */
export type MoreRow = { more: string; hidden: number; open: boolean; depth: number; prefix: string }

const RANK: Record<Status, number> = { running: 0, failed: 1, aborted: 2, done: 3 }

/** A node ranks as the most urgent status in its subtree, so a done parent never hides a running or failed child. */
function rankOf(flow: Flow, node: FlowNode): number {
  let best = RANK[node.status]
  for (const id of subtree(flow, node.id)) {
    const n = flow.nodes.get(id)
    if (n) best = Math.min(best, RANK[n.status])
  }
  return best
}

/** Siblings running → failed → stopped → done; done newest first, so the ones kept are the latest. */
export function sortedSiblings(flow: Flow, kids: FlowNode[]): FlowNode[] {
  const ranked = kids.map((node, i) => ({ node, i, rank: rankOf(flow, node) }))
  ranked.sort((a, b) => a.rank - b.rank || (a.rank === RANK.done ? b.i - a.i : a.i - b.i))
  return ranked.map(r => r.node)
}

export const KEEP_DONE = 3

/**
 * The tree depth first with its box-drawing prefix. Each parent shows its latest `keepDone` done
 * background shells and folds the older ones into one line, unless its id is in `opened`;
 * done agents always show.
 */
export function rows(flow: Flow, opened: ReadonlySet<string> = new Set(), keepDone = KEEP_DONE): Array<Row | MoreRow> {
  const out: Array<Row | MoreRow> = []
  const walk = (id: string, depth: number, lead: string) => {
    const sorted = sortedSiblings(flow, children(flow, id))
    const shells = sorted.filter(n => n.type === 'shell' && rankOf(flow, n) === RANK.done)
    const folded = new Set(shells.slice(keepDone))
    const extra = folded.size
    const open = opened.has(id)
    const shown = extra && !open ? sorted.filter(n => !folded.has(n)) : sorted
    const tail = extra ? 1 : 0
    shown.forEach((kid, i) => {
      const last = i === shown.length - 1 && !tail
      out.push({ node: kid, depth, prefix: `${lead}${last ? '└─' : '├─'}` })
      walk(kid.id, depth + 1, `${lead}${last ? '  ' : '│ '}`)
    })
    if (extra) out.push({ more: id, hidden: open ? 0 : extra, open, depth, prefix: `${lead}└─` })
  }
  walk(MAIN, 1, '')
  return out
}

export const isMore = (r: Row | MoreRow): r is MoreRow => 'more' in r

/** Agents by status; stopped stays apart from failed, as the row marks tell them apart. */
export function counts(flow: Flow): { running: number; done: number; failed: number; stopped: number } {
  let running = 0
  let done = 0
  let failed = 0
  let stopped = 0
  for (const n of flow.nodes.values()) {
    if (n.id === MAIN) continue
    if (n.status === 'running') running += 1
    else if (n.status === 'done') done += 1
    else if (n.status === 'aborted') stopped += 1
    else failed += 1
  }
  return { running, done, failed, stopped }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** One line saying what a tool call touched: the command, the path, the pattern. */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const pick =
    str(input.description) && tool === 'Agent'
      ? str(input.description)
      : str(input.command) ||
        str(input.file_path) ||
        str(input.path) ||
        str(input.pattern) ||
        str(input.url) ||
        str(input.query) ||
        str(input.prompt) ||
        str(input.description)
  return pick.replace(/\s+/g, ' ').trim()
}

export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '–'
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

/** `████░░░░` for a percentage, `width` cells. */
/**
 * Tokens over window as a whole percentage, from the same pair the pane prints beside it:
 * the engine's own `percent` once read 36% next to 85.1k/1.0M.
 */
export function usedPercent(tokens: number | undefined, window: number | undefined): number | undefined {
  if (tokens === undefined || !window) return undefined
  return Math.min(100, Math.round((tokens / window) * 100))
}

// green → yellow → orange → red; a fixed step at 60/80 jumps, a blend shows the climb
const BAR_STOPS: Array<[number, [number, number, number]]> = [
  [0, [34, 197, 94]],
  [50, [234, 179, 8]],
  [75, [249, 115, 22]],
  [100, [239, 68, 68]],
]

/** Hex color for a usage percentage, blended between the stops above. */
export function barColor(percent: number): string {
  const p = Math.min(100, Math.max(0, percent))
  let i = 0
  while (i < BAR_STOPS.length - 2 && p > BAR_STOPS[i + 1]![0]) i += 1
  const [p0, c0] = BAR_STOPS[i]!
  const [p1, c1] = BAR_STOPS[i + 1]!
  const t = (p - p0) / (p1 - p0)
  return '#' + c0.map((v, k) => Math.round(v + (c1[k]! - v) * t).toString(16).padStart(2, '0')).join('')
}

/**
 * The bar as coloured runs: each filled cell takes the colour of the percentage it stands at, so the
 * fill shows the climb from green instead of one flat colour; the empty rest comes last with no colour.
 */
export function barRuns(percent: number | undefined, width: number): Array<{ text: string; color?: string }> {
  const w = Math.max(1, Math.floor(width))
  const p = Math.min(100, Math.max(0, percent ?? 0))
  const full = Math.round((p / 100) * w)
  const runs: Array<{ text: string; color?: string }> = []
  for (let i = 0; i < full; i++) {
    const color = barColor(((i + 0.5) / w) * 100)
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.text += '█'
    else runs.push({ text: '█', color })
  }
  if (w > full) runs.push({ text: '░'.repeat(w - full) })
  return runs
}

export function bar(percent: number | undefined, width: number): string {
  const w = Math.max(1, Math.floor(width))
  const p = Math.min(100, Math.max(0, percent ?? 0))
  const full = Math.round((p / 100) * w)
  return '█'.repeat(full) + '░'.repeat(w - full)
}

/** Cuts `text` to `width` cells with an ellipsis; never below 1. */
export function fit(text: string, width: number): string {
  const w = Math.max(1, Math.floor(width))
  const chars = Array.from(text)
  if (chars.length <= w) return text
  return chars.slice(0, Math.max(0, w - 1)).join('') + '…'
}

/** The first `lines` non-empty lines of `text`, each fitted to `width`; `…` when cut. */
export function excerpt(text: string, lines: number, width: number): string[] {
  const all = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '')
  const shown = all.slice(0, lines).map(l => fit(l, width))
  if (all.length > lines) shown.push(fit(`… ${all.length - lines} more lines`, width))
  return shown
}

export const STATUS_MARK: Record<Status, string> = { running: '◐', done: '●', failed: '✗', aborted: '○' }

export function paneColumns(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 52
  return Math.min(120, Math.max(32, n))
}

export const DEFAULT_SKILL_BUTTONS = ['commit', 'verify-code', 'checkpoint', 'handoff-status']
/** A button's shown name: the command without the words every reader already knows from the row. */
export function shortLabel(name: string): string {
  const short = name.replace(/^(to|code)-/, '').replace(/-(with-docs|code|status)$/, '')
  return short || name
}
export const DEFAULT_FLOW_BUTTONS = ['grill-with-docs', 'to-spec', 'to-tickets', 'implement', 'code-review', 'retro']

/** Command names for the pane's buttons, from a comma list; no slash, nothing a command name cannot be. */
export function skillButtons(value: unknown, fallback: string[] = DEFAULT_SKILL_BUTTONS): string[] {
  if (typeof value !== 'string') return fallback
  return value
    .split(',')
    .map(s => s.trim().replace(/^\//, ''))
    .filter(s => /^[\w:.-]+$/.test(s))
    .slice(0, 12)
}

export function maxAgents(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 60
  return Math.min(500, Math.max(1, n))
}
