/**
 * agent-flow — Claude Mod
 *
 * A side pane that draws the session's agents as they run: the main loop and
 * its context window on top, then every subagent as a tree in spawn order.
 * Select an agent (click, or Tab and Enter) to see the context it was handed
 * (its prompt, or the parent's whole context for a fork), what it did with it
 * (steps, tool calls, how full its own window got) and the answer it handed
 * back up. Select the main loop for the /context breakdown of the session.
 *
 *   `/agent-flow` opens it · `/agent-flow clear` forgets finished agents ·
 *   `/agent-flow stop` closes it
 *
 * Beside the tree it watches the work: time and failures per tool and each
 * compaction. A Git section lists the repos
 * the session edited, ran git in or read, each with the branch it sits on (the
 * session's own folder marked (cwd)), re-read after git commands and each turn.
 *
 * It only observes: every hook passes its event on unchanged; the engine reads
 * are `$.agent.list()`, `$.session.usage()` and read-only git calls. The flow is
 * recorded from session start whether the pane is open or not.
 *
 * Needs Claude Code >= 2.1.287.
 *
 * Options (pluginConfigs["agent-flow@skills-dir"].options):
 *   columns: number      width asked for the docked pane (default 52)
 *   maxAgents: number    subagents kept, oldest finished dropped first (default 60)
 *   openOnStart: boolean open the pane when the session starts (default false)
 *   openOnAgent: boolean open the pane (without focus) when an Agent call spawns a subagent (default true)
 *   openOnBackground: boolean open the pane (without focus) when a shell command goes to the background (default true)
 *   skillButtons: string comma list of commands drawn as buttons; a press runs it as if typed
 *                        (default "commit,verify-code,checkpoint,handoff-status", "" for none)
 *   flowButtons: string  the main flow's commands, drawn numbered in their order on a row above;
 *                        a press puts `/name ` in the prompt box to finish and send, it does not run
 *                        (default "grill-with-docs,to-spec,to-tickets,implement,code-review,retro")
 */
import { atom, read, update } from 'claude-code'
import type { ContextCategory, EngineInterface, Register, SessionContextUsage, SessionCost, Timer } from 'claude-code'

import type { SavedFlow } from '../types'
import {
  MAIN,
  barColor,
  barRuns,
  completed,
  counts,
  createFlow,
  estimateTokens,
  excerpt,
  fit,
  fmtDuration,
  fmtTokens,
  laneSynced,
  parseLane,
  mainTurn,
  maxAgents,
  forgetFinished,
  loopId,
  paneColumns,
  DEFAULT_FLOW_BUTTONS,
  skillButtons,
  restarted,
  rows,
  isMore,
  spawned,
  stepped,
  synced,
  toolLabel,
  toolRan,
  trimmed,
  usedPercent,
  STATUS_MARK,
  shortLabel,
} from './flow.ts'
import type { Flow, FlowNode, Status } from './flow.ts'
import {
  clock,
  compacted,
  createWatch,
  restoredWatch,
  timed,
  topTools,
} from './watch.ts'
import type { Watch } from './watch.ts'
import { branchText, listed, restoredRepos, touched, touchedDirs } from './repos.ts'
import type { Repos } from './repos.ts'

const PANE = 'agent-flow'
const COMMAND = 'agent-flow'
const KEY = 'ag:'
const SKILL_KEY = 'sk:'
const FLOW_KEY = 'fl:'

let flow: Flow = createFlow()
let watch: Watch = createWatch()
let isOpen = false

let repos: Repos = {}
/** dir → its repo's toplevel, null outside any repo: one git spawn per folder, not per call */
const topOf = new Map<string, string | null>()
let sessionCwd: string | undefined
let percentLogged = false
/** Parents whose older done children are shown in full instead of one `N more done` line. */
let opened = new Set<string>()
const MORE_KEY = 'mo:'
/** Pets is the one section that folds: its legend is long and rarely read. Folded until opened. */
let petsOpen = false
const PETS_KEY = 'pets'
let homeDir: string | undefined

function resetWatch() {
  watch = createWatch()
  repos = {}
  topOf.clear()
}

// Dirs come from paths the session read or commands it ran, so a repo can be a stranger's: its
// .git/config must not pick a program for git to run, and a UNC path would reach out to a host.
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.sshCommand=', '-c', 'protocol.allow=never']
// two leading separators in any mix (`\\host`, `//host`, `/\host`, `\\?\UNC\`) name another machine
const remotePath = (dir: string) => /^[\\/]{2}/.test(dir.trim())

/** A repo's whole path, home shown as `~`: two worktrees or junctions can share a last folder name. */
function repoPath(top: string): string {
  const t = top.replace(/\\/g, '/')
  const h = homeDir?.replace(/\\/g, '/').replace(/\/+$/, '')
  return h && t.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${t.slice(h.length)}` : t
}

async function gitOut($: EngineInterface, args: string[]): Promise<string | undefined> {
  const r = await $.process.run(['git', ...SAFE_GIT, ...args], { timeoutMs: 5000 }).catch(() => undefined)
  return r && r.exitCode === 0 ? r.stdout.trim() : undefined
}

async function topLevel($: EngineInterface, dir: string): Promise<string | undefined> {
  if (remotePath(dir)) return undefined
  if (!topOf.has(dir)) {
    const top = await gitOut($, ['-C', dir, 'rev-parse', '--show-toplevel'])
    // a local dir can still resolve to a share (a junction, a mapped drive's worktree): check git's answer too
    topOf.set(dir, top && !remotePath(top) ? top : null)
    if (topOf.size > 200) topOf.delete(topOf.keys().next().value!)
  }
  return topOf.get(dir) ?? undefined
}

async function readBranch($: EngineInterface, top: string): Promise<boolean> {
  const r = repos[top]
  if (!r) return false
  const name = await gitOut($, ['-C', top, 'symbolic-ref', '--short', '-q', 'HEAD'])
  const branch = branchText(name, name ? undefined : await gitOut($, ['-C', top, 'rev-parse', '--short', 'HEAD']))
  // neither a branch nor a commit: the folder is no repo now (a worktree removed after its work)
  if (branch === undefined) {
    delete repos[top]
    topOf.forEach((t, dir) => t === top && topOf.delete(dir))
    return true
  }
  if (branch === r.branch) return false
  r.branch = branch
  return true
}

/** After a tool call: count it on the repos it worked in; a git command may have switched the branch. */
async function noteRepos($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<void> {
  const dirs = touchedDirs(tool, input, sessionCwd, homeDir)
  if (!dirs.length) return
  let changed = false
  for (const { dir, kind } of dirs) {
    const top = await topLevel($, dir)
    if (!top) continue
    const fresh = !repos[top]
    touched(repos, top, kind, Date.now())
    changed = true
    if (fresh || kind === 'git') await readBranch($, top)
  }
  if (changed) {
    await saveFlow($)
    if (isOpen) $.ui.invalidate('ui.render')
  }
}

/** The session's own folder is listed from the start, touched or not, with its branch. */
async function seedCwdRepo($: EngineInterface): Promise<void> {
  sessionCwd = await $.session.cwd().catch(() => undefined)
  homeDir = (await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined))
  if (!sessionCwd) return
  const top = await topLevel($, sessionCwd)
  if (!top) return
  repos[top] ??= { top, edit: 0, git: 0, read: 0, at: Date.now() }
  await readBranch($, top)
  if (isOpen) $.ui.invalidate('ui.render')
}

/** Branches move outside the tools too (the person's own terminal): re-read them once a turn. */
async function refreshBranches($: EngineInterface): Promise<void> {
  let changed = false
  for (const top of Object.keys(repos)) if (await readBranch($, top)) changed = true
  if (changed) {
    await saveFlow($)
    if (isOpen) $.ui.invalidate('ui.render')
  }
}

function loopName(loop: string): string {
  if (loop === MAIN) return 'main'
  const n = flow.nodes.get(loop)
  return n ? fit(`${n.type} ${n.description}`, 40) : `loop ${loop.slice(0, 8)}`
}

let selected: string | undefined
let breakdown: ContextCategory[] | undefined

const STATUS_COLOR: Record<Status, string> = { running: 'yellow', done: 'gray', failed: 'red', aborted: 'blue' }

// Pets: the species tells the model tier at a glance, the trailing marks tell the status.
const PET_TICK_MS = 400
let petFrame = 0
let petTimer: Timer | undefined
const SPECIES: [RegExp, string][] = [
  [/haiku/i, '🐹'],
  [/sonnet/i, '🐶'],
  [/opus/i, '🐼'],
  [/fable/i, '🦄'],
]
// Agents the engine knows but the flow never saw (spawned before this pane's state existed,
// or lost to a reload) still belong to the session's history: take them in from the list.
type Listed = { id: string; status: string; type: string; description: string; parentId?: string; name?: string }
// $.agent.list() keeps a finished agent for a while after it ends: without this, a
// cleared agent would come straight back the next time the list is adopted.
const forgotten = new Set<string>()
function forget(ids: readonly string[]) {
  for (const id of ids) forgotten.add(id)
}

function adopted(list: readonly Listed[], now: number): boolean {
  let added = false
  for (const info of list) {
    if (flow.nodes.has(info.id) || forgotten.has(info.id)) continue
    const tier = /haiku|sonnet|opus|fable/i.exec(`${info.name ?? ''} ${info.description}`)?.[0]
    const node = spawned(
      flow,
      {
        agentId: info.id,
        parentAgentId: info.parentId,
        description: info.description,
        subagentType: info.type,
        prompt: '(started before this pane kept its history)',
        fork: false,
        background: false,
        model: tier,
      },
      now,
    )
    node.status =
      info.status === 'running' ? 'running' : info.status === 'failed' ? 'failed' : info.status === 'killed' ? 'aborted' : 'done'
    added = true
  }
  return added
}

// Background shells live in the same map as agents; the prefix keeps their ids apart.
const shellId = (taskId: string) => `bg:${taskId}`

function shellEnded(taskId: string, status: string, now: number): boolean {
  const node = flow.nodes.get(shellId(taskId))
  if (!node || node.status !== 'running') return false
  node.status = status === 'completed' ? 'done' : status === 'killed' || status === 'stopped' ? 'aborted' : 'failed'
  node.durationMs = now - node.startedAt
  return true
}

function petOf(node: FlowNode): string {
  if (node.id === MAIN) return '🐱'
  if (node.type === 'shell') return '🐥'
  if (node.type === 'qwen') return '🐨'
  if (node.type === 'gate-run') return '🦉'
  return SPECIES.find(([re]) => node.model !== undefined && re.test(node.model))?.[1] ?? '🐰'
}
const LEGEND = [
  '🐱 main loop',
  '🐥 background shell',
  '🐨 qwen (lane-home)',
  '🦉 gate-runner',
  '🐹 haiku',
  '🐶 sonnet',
  '🐼 opus',
  '🦄 fable',
  '🐰 subagent, model not known',
]

// History: module variables start over on a hot reload, $.state does not, so the flow is
// kept there and read back when the session start it was saved under is still the current one.
const savedAtom = atom({ plugin: 'agent-flow', key: 'saved' } as const, null as SavedFlow)
let sessionStartedAt: number | undefined

// The dispatcher's qwen runs live outside this session: no hook sees them, so poll their pid files.
const LANE_POLL_MS = 20_000
// Git Bash is not on the Windows PATH; `bash` covers every other host.
const BASH = ['C:/Program Files/Git/bin/bash.exe', 'bash']
let laneTimer: Timer | undefined
let lanePolling = false

async function pollLane($: EngineInterface): Promise<{ changed: boolean; added: boolean }> {
  const none = { changed: false, added: false }
  if (lanePolling) return none
  lanePolling = true
  try {
    for (const bash of BASH) {
      const r = await $.process.run([bash, `${$.plugin.root}/hooks/lane-home.sh`], { timeoutMs: 10_000 }).catch(() => undefined)
      if (!r) continue
      return laneSynced(flow, parseLane(r.stdout), Date.now())
    }
    return none
  } finally {
    lanePolling = false
  }
}

// No focus: spawns happen mid-turn and the person may be typing the next prompt.
async function openQuietly($: EngineInterface, columns: number) {
  if (isOpen) return
  isOpen = true
  if (!flow.window) await adoptWindow($)
  await $.ui.open({ id: PANE, title: 'agents', columns }).catch(err => {
    isOpen = false
    $.ui.log(`agent-flow: pane not opened: ${err}`, { to: 'debug' })
  })
}
let justCleared = false

async function saveFlow($: EngineInterface) {
  if (sessionStartedAt === undefined) return
  const text = JSON.stringify({
    startedAt: sessionStartedAt,
    nodes: [...flow.nodes.values()],
    order: flow.order,
    turn: flow.turn,
    // without it a reload draws no bar until the next session.measure
    window: flow.window,
    watch,
    repos,
    opened: [...opened],
    petsOpen,
  })
  await update($, savedAtom, () => text).catch(() => undefined)
}

function restored(text: SavedFlow, startedAt: number): Flow | undefined {
  if (!text) return undefined
  try {
    const s = JSON.parse(text) as {
      startedAt?: unknown
      nodes?: unknown
      order?: unknown
      turn?: unknown
      window?: unknown
      watch?: unknown
      repos?: unknown
      opened?: unknown
      petsOpen?: unknown
    }
    if (s.startedAt !== startedAt || !Array.isArray(s.nodes) || !Array.isArray(s.order)) return undefined
    const nodes = new Map<string, FlowNode>()
    for (const n of s.nodes as FlowNode[]) if (n && typeof n.id === 'string') nodes.set(n.id, n)
    if (!nodes.has(MAIN)) return undefined
    watch = restoredWatch(s.watch)
    repos = restoredRepos(s.repos)
    petsOpen = s.petsOpen === true
    opened = new Set(Array.isArray(s.opened) ? s.opened.filter((k): k is string => typeof k === 'string') : [])
    const order = (s.order as unknown[]).filter((id): id is string => typeof id === 'string' && nodes.has(id))
    return {
      nodes,
      order,
      turn: typeof s.turn === 'number' ? s.turn : 0,
      window: typeof s.window === 'number' && s.window > 0 ? s.window : undefined,
    }
  } catch {
    return undefined
  }
}

// The big pet under the tree: plain ASCII so every row is exactly as wide as it looks.
const BIG_AWAKE = [
  ['            ', '   /\\_/\\    ', '  ( o.o )   ', '   > ^ <    ', '  /|   |\\   ', ' (_|   |_)~ '],
  ['            ', '   /\\_/\\    ', '  ( o.o )   ', '   > ^ <    ', '  /|   |\\   ', ' (_|   |_) ~'],
  ['            ', '   /\\_/\\    ', '  ( ^.^ )   ', '   > ^ <    ', '  /|   |\\   ', ' (_|   |_)~ '],
  ['            ', '   /\\_/\\    ', '  ( o.o )   ', '   > ^ <    ', '  /|   |\\   ', ' (_|   |_) ~'],
]
const BIG_ASLEEP = [
  ['        z   ', '   /\\_/\\    ', '  ( -.- )   ', '   > ^ <    ', '  (_____)~  ', '            '],
  ['       Z    ', '   /\\_/\\ z  ', '  ( -.- )   ', '   > ^ <    ', '  (_____)~  ', '            '],
  ['     Z   z  ', '   /\\_/\\    ', '  ( -.- )   ', '   > ^ <    ', '  (_____)~  ', '            '],
  ['   Z    Z   ', '   /\\_/\\    ', '  ( -.- )   ', '   > ^ <    ', '  (_____) ~ ', '            '],
]

function bigPet(width: number): { lines: string[] } {
  let busy = 0
  for (const n of flow.nodes.values()) if (n.status === 'running') busy += 1
  // a slower beat than the tree badges: one art frame every three ticks
  const beat = Math.floor(petFrame / 3) % 4
  const art = (busy ? BIG_AWAKE : BIG_ASLEEP)[beat] ?? []
  return { lines: art.map(l => centred(width, 12) + l) }
}
// Left padding that centres a block `chars` columns wide.
const centred = (width: number, chars: number) => ' '.repeat(Math.max(0, Math.floor((width - chars) / 2)))

// Same thresholds as the context-warn hook, so the line and the in-chat warning agree.
const WARN_AT = 120_000
const HARD_AT = 250_000

const shortTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const sessionAge = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

let contextLine: string | undefined

// session.measure fires only after a main-thread turn ends, so until then the pane has no window
// to draw the bar against; $.session.usage() already knows it.
async function adoptWindow($: EngineInterface) {
  const usage = await $.session.usage().catch(() => undefined)
  if (usage && usage.context.window > 0) flow.window = usage.context.window
}

function contextText(context: SessionContextUsage, cost: SessionCost | undefined, startedAt: number | undefined, now: number) {
  if (context.tokens === undefined) return undefined
  const mark = context.tokens >= HARD_AT ? '🔴' : context.tokens >= WARN_AT ? '🟡' : '🟢'
  const p = usedPercent(context.tokens, context.window) ?? context.percent
  const pct = p === undefined ? '' : ` ${p}%`
  const usd = cost ? ` · $${cost.usd.toFixed(2)}` : ''
  const ms = startedAt === undefined ? NaN : now - startedAt
  return `${mark} context ${shortTokens(context.tokens)}/${shortTokens(context.window)}${pct}${usd}${Number.isFinite(ms) ? ` · ${sessionAge(ms)}` : ''}`
}

// A mod gets one status slot: the context line always, agent counts only while the pane is open.
function statusText(): string | undefined {
  const parts: string[] = []
  if (contextLine) parts.push(contextLine)
  if (isOpen) {
    const c = counts(flow)
    const agents = [`${c.running} running`, `${c.done} done`]
    if (c.failed) agents.push(`${c.failed} failed`)
    if (c.stopped) agents.push(`${c.stopped} stopped`)
    parts.push(`agents ${agents.join(' · ')}`)
  }
  return parts.length ? parts.join(' │ ') : undefined
}

/** Tokens handed down to a node's children and handed back up by them. */
function exchanged(node: FlowNode): { down: number; up: number; kids: number } {
  let down = 0
  let up = 0
  let kids = 0
  for (const n of flow.nodes.values()) {
    if (n.parentId !== node.id) continue
    kids += 1
    down += n.fork ? (node.contextTokens ?? 0) : estimateTokens(n.prompt)
    up += estimateTokens(n.answer)
  }
  return { down, up, kids }
}

export const register: Register = (on, options) => {
  const columns = paneColumns(options.columns)
  const keep = maxAgents(options.maxAgents)
  const openOnStart = options.openOnStart === true
  const openOnAgent = options.openOnAgent !== false
  const openOnBackground = options.openOnBackground !== false
  const skills = skillButtons(options.skillButtons)
  const flowSkills = skillButtons(options.flowButtons, DEFAULT_FLOW_BUTTONS)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    flow = createFlow(Date.now())
    resetWatch()
    const usage = await $.session.usage().catch(() => undefined)
    sessionStartedAt = usage?.startedAt
    if (usage) contextLine = contextText(usage.context, usage.cost, usage.startedAt, await $.clock.now())
    $.ui.status(statusText())
    if (sessionStartedAt !== undefined) flow = restored(await read($, savedAtom), sessionStartedAt) ?? flow
    if (usage && usage.context.window > 0) flow.window = usage.context.window
    if (adopted(await $.agent.list().catch(() => []), Date.now())) await saveFlow($)
    void seedCwdRepo($)
    selected = undefined
    breakdown = undefined
    // Pets animate only while the pane is open; otherwise the tick is a no-op.
    // session.start fires again on /clear and resume; a second timer would double the ticks.
    petTimer?.cancel()
    petTimer = $.clock.every(PET_TICK_MS, () => {
      if (!isOpen) return
      petFrame += 1
      $.ui.invalidate('ui.render')
    })
    const lane = async () => {
      const r = await pollLane($)
      if (!r.changed) return
      trimmed(flow, keep)
      await saveFlow($)
      if (r.added && openOnBackground) await openQuietly($, columns)
      if (isOpen) {
        $.ui.status(statusText())
        $.ui.invalidate('ui.render')
      }
    }
    laneTimer?.cancel()
    laneTimer = $.clock.every(LANE_POLL_MS, lane)
    void lane()
    await $.command
      .register({
        name: COMMAND,
        description: 'Live tree of the session’s agents and the context passed between them (clear|stop)',
        argumentHint: '[clear|stop]',
        immediate: true,
      })
      .catch(err => $.ui.log(`agent-flow: /${COMMAND} not registered: ${err}`))
    $.ui.log(`agent-flow loaded: /${COMMAND} opens the pane`, { to: 'debug' })
    if (openOnStart) {
      isOpen = true
      await $.ui.open({ id: PANE, title: 'agents', columns }).catch(err => {
        isOpen = false
        $.ui.log(`agent-flow: pane not opened: ${err}`)
      })
      $.ui.status(statusText())
    }
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop' || arg === 'close') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      isOpen = false
      $.ui.status(statusText())
      return { text: 'agent-flow closed' }
    }
    if (arg === 'clear') {
      forget(forgetFinished(flow))
      await saveFlow($)
      selected = undefined
      if (isOpen) {
        $.ui.status(statusText())
        $.ui.invalidate('ui.render')
      }
      return { text: 'agent-flow: finished agents cleared' }
    }
    const listed = await $.agent.list().catch(() => [])
    synced(flow, listed)
    if (adopted(listed, Date.now())) await saveFlow($)
    if (!flow.window) await adoptWindow($)
    try {
      await $.ui.open({ id: PANE, title: 'agents', focus: true, columns })
    } catch (err) {
      isOpen = false
      return { text: `agent-flow: pane not opened: ${err}` }
    }
    isOpen = true
    $.ui.status(statusText())
    $.ui.invalidate('ui.render')
    const c = counts(flow)
    const hint = e.presentation.isFullscreen
      ? 'click an agent, or Tab and Enter'
      : 'drawn above the prompt; /tui fullscreen docks it beside the transcript'
    return { text: `${c.running + c.done + c.failed + c.stopped} agents so far · ${hint} · /${COMMAND} stop closes` }
  })

  // /clear fires no session.start, only this: the process stays, so the flow must drop what finished itself.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') return next(e)
    forget(restarted(flow, Date.now()))
    resetWatch()
    selected = undefined
    breakdown = undefined
    justCleared = true
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // Since Claude Code 2.1.299 a subagent's or teammate's turn starts here too (its prompt in `e.text`).
    // Subagents enter the flow through agent.spawn.
    if (e.agentId !== undefined) return next(e)
    // The saved flow is keyed by session start, which /clear moved: re-key it so a reload still finds it.
    if (justCleared) {
      justCleared = false
      const usage = await $.session.usage().catch(() => undefined)
      if (usage) sessionStartedAt = usage.startedAt
    }
    mainTurn(flow, e.text, Date.now())
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // the context handed down: the Agent call's prompt, known before the subagent runs
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      spawned(
        flow,
        {
          agentId: r.agentId,
          parentAgentId: e.parentAgentId,
          description: e.description,
          subagentType: e.subagentType,
          prompt: e.prompt,
          fork: e.fork,
          background: e.background,
          model: r.model,
          resumed: e.resume !== undefined,
        },
        Date.now(),
      )
      trimmed(flow, keep)
      await saveFlow($)
      if (openOnAgent) await openQuietly($, columns)
      if (isOpen) {
        $.ui.status(statusText())
        $.ui.invalidate('ui.render')
      }
    }
    return r
  })

  // each model request: how full that loop's window is now
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    stepped(flow, e.agentId, r.usage, Date.now())
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const use = { tool: e.tool, label: toolLabel(e.tool, e as unknown as Record<string, unknown>) }
    const start = Date.now()
    toolRan(flow, e.agentId, use, start)
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    const r = await next(e)
    const end = Date.now()
    const failed = r.deny !== undefined || r.isError === true
    Object.assign(use, { ms: end - start }, failed ? { isError: true } : {})
    timed(watch, e.tool, end - start, failed)
    const fields = e as unknown as Record<string, unknown>
    if (isOpen) $.ui.status(statusText())
    // after the result, never awaited: git spawns must not hold the tool's answer back
    if (!failed) void noteRepos($, e.tool, fields)
    // A shell sent to the background (asked for, or moved there by its timeout) joins the flow as a pet.
    const bgId = (r.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
    // Windows sessions run background commands through the PowerShell tool, not Bash.
    if ((e.tool === 'Bash' || e.tool === 'PowerShell') && typeof bgId === 'string') {
      const command = typeof fields.command === 'string' ? fields.command : ''
      const description = typeof fields.description === 'string' && fields.description ? fields.description : command
      spawned(
        flow,
        { agentId: shellId(bgId), parentAgentId: e.agentId, description, subagentType: 'shell', prompt: command, fork: false, background: true },
        Date.now(),
      )
      trimmed(flow, keep)
      await saveFlow($)
      if (openOnBackground) {
        await openQuietly($, columns)
        $.ui.status(statusText())
      }
    } else if (e.tool === 'TaskStop' && r.deny === undefined) {
      const id = typeof fields.task_id === 'string' ? fields.task_id : typeof fields.shell_id === 'string' ? fields.shell_id : ''
      if (shellEnded(id, 'killed', Date.now())) await saveFlow($)
    }
    if (isOpen) $.ui.invalidate('ui.render')
    return r
  })

  // A background shell's end comes back only as a task-notification prompt: read its ids and statuses.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      let changed = false
      for (const block of e.text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const status = /<status>(\w+)<\/status>/.exec(block[1] ?? '')?.[1]
        if (!status || status === 'running') continue
        for (const m of (block[1] ?? '').matchAll(/<task-id>([\w-]+)<\/task-id>/g)) {
          if (m[1] && shellEnded(m[1], status, Date.now())) changed = true
        }
      }
      if (changed) {
        await saveFlow($)
        if (isOpen) $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // precompute only prepares a summary for later; the compaction that installs it fires on its own
    if (e.trigger === 'precompute') return r
    compacted(watch, {
      at: Date.now(),
      loop: loopId(e.agentId),
      trigger: e.trigger,
      before: r.skip === undefined ? r.tokensBefore : undefined,
      after: r.skip === undefined ? r.tokensAfter : undefined,
      skip: r.skip,
    })
    await saveFlow($)
    if (isOpen) $.ui.invalidate('ui.render')
    return r
  })

  // the context handed back up: a subagent's final answer
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    completed(
      flow,
      e.agentId,
      { answer: e.answer, reason: e.reason, durationMs: e.durationMs, model: e.usage?.model },
      Date.now(),
    )
    if (!e.agentId) synced(flow, await $.agent.list().catch(() => []))
    await saveFlow($)
    if (!e.agentId) void refreshBranches($)
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    flow.window = e.context.window
    flow.percent = usedPercent(e.context.tokens, e.context.window) ?? e.context.percent
    // The engine's percent once disagreed with its own tokens/window: keep the raw pair to find out why.
    if (!percentLogged && e.context.percent !== undefined && flow.percent !== undefined &&
        Math.abs(e.context.percent - flow.percent) > 2) {
      percentLogged = true
      $.ui.log(
        `agent-flow: engine context percent ${e.context.percent}% vs tokens ${e.context.tokens}/${e.context.window} = ${flow.percent}%`,
        { to: 'debug' },
      )
    }
    const main = flow.nodes.get(MAIN)
    if (main && e.context.tokens !== undefined) main.contextTokens = e.context.tokens
    contextLine = contextText(e.context, e.cost, sessionStartedAt, await $.clock.now())
    $.ui.status(statusText())
    if (isOpen) $.ui.invalidate('ui.render')
    return r
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    const r = await next(e)
    isOpen = false
    $.ui.status(statusText())
    return r
  })

  on('ui.press', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || e.requestId !== PANE) return next(e)
    // The pets redraw the pane every tick, so a click can land on a handle the last draw
    // already replaced; the press is still read from e.element below.
    const r = await next(e).catch(() => ({ element: e.element }))
    const key = e.element
    // The flow's skills each need a topic or input after the name, so they go to the prompt box
    // for the person to finish and send; the draft already typed stays after the command.
    if (key.startsWith(FLOW_KEY)) {
      const command = `/${key.slice(FLOW_KEY.length)} `
      const draft = (await $.prompt.read()).text.replace(/^\/\S+\s*/, '')
      const filled = await $.prompt.fill({ text: command + draft, cursor: command.length }).catch(() => undefined)
      if (!filled?.isFilled) $.ui.toast(`${command.trim()}: the prompt box is not available right now`)
      return r
    }
    if (key.startsWith(SKILL_KEY)) {
      const command = key.slice(SKILL_KEY.length)
      // Not awaited: it resolves when the command's whole turn ends, and the press must answer now.
      // The engine queues it until the session is idle, as if typed.
      $.command.run({ command }).catch(err => $.ui.toast(`/${command} did not run: ${err}`, { timeoutMs: 8000 }))
      $.ui.toast(`▶ /${command}`)
      return r
    }
    if (key === 'close') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return r
    }
    if (key === PETS_KEY) {
      petsOpen = !petsOpen
      await saveFlow($)
      if (isOpen) $.ui.invalidate('ui.render')
      return r
    }
    if (key.startsWith(MORE_KEY)) {
      const parent = key.slice(MORE_KEY.length)
      if (!opened.delete(parent)) opened.add(parent)
      await saveFlow($)
      if (isOpen) $.ui.invalidate('ui.render')
      return r
    }
    if (key === 'clear') {
      forget(forgetFinished(flow))
      await saveFlow($)
      if (selected && !flow.nodes.has(selected)) selected = undefined
    } else if (key === 'refresh') {
      synced(flow, await $.agent.list().catch(() => []))
      await pollLane($)
    } else if (key.startsWith(KEY)) {
      const id = key.slice(KEY.length)
      selected = selected === id ? undefined : id
    }
    if (selected === MAIN && (key === 'refresh' || key === `${KEY}${MAIN}`)) {
      const usage = await $.session.usage({ breakdown: 'summary', columns }).catch(() => undefined)
      breakdown = usage?.context.breakdown?.categories
    }
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    // Being drawn means it is open: a hot reload or a resume resets isOpen while the engine keeps
    // the pane placed, and every redraw is gated on it, so the pane froze until a click redrew it.
    isOpen = true
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns - 1)
    const noop = () => {}
    const main = flow.nodes.get(MAIN)!
    const tree = rows(flow, opened)
    const c = counts(flow)
    const chosen = selected ? flow.nodes.get(selected) : undefined
    const pct = usedPercent(main.contextTokens, flow.window) ?? flow.percent
    const sectionHead = (name: string, title: string) => (
      <Text key={`sh:${name}`} color="cyan" bold>
        {fit(title, width)}
      </Text>
    )

    const agentRow = (node: FlowNode, prefix: string) => {
      const ctx = node.contextTokens !== undefined ? fmtTokens(node.contextTokens) : ''
      const tools = node.toolCount ? `${node.toolCount}⚒` : ''
      const right = [ctx, tools].filter(Boolean).join(' ')
      const room = width - prefix.length - 4 - (right ? right.length + 1 : 0)
      const name = node.id === MAIN ? 'main' : `${node.type}${node.fork ? ' (fork)' : ''}  ${node.description}`
      return (
        <Box key={`row:${node.id}`} flexDirection="row">
          {prefix ? <Text dimColor>{prefix}</Text> : null}
          <Text color={STATUS_COLOR[node.status]}>{`${STATUS_MARK[node.status]} ${petOf(node)} `}</Text>
          <Button
            key={`${KEY}${node.id}`}
            plain
            dimColor={selected !== node.id && (node.unlisted || node.status !== 'running')}
            label={fit(name, Math.max(4, room))}
            onPress={noop}
          />
          {right ? <Text color="magenta">{` ${right}`}</Text> : null}
        </Box>
      )
    }

    const header = (
      <Box key="head" flexDirection="column">
        <Text bold>{fit(`Session · turn ${flow.turn}`, width)}</Text>
        <Text>
          <Text color="cyan">{'context '}</Text>
          {`${fmtTokens(main.contextTokens)}${flow.window ? `/${fmtTokens(flow.window)}` : ''}`}
          {pct !== undefined ? <Text dimColor>{` ${pct}%`}</Text> : null}
        </Text>
        {pct !== undefined ? (
          <Text>
            {barRuns(pct, Math.min(width, 40)).map((run, i) => (
              <Text key={`bar:${i}`} color={run.color ?? barColor(pct)}>
                {run.text}
              </Text>
            ))}
          </Text>
        ) : null}
        {flow.window && main.contextTokens !== undefined ? (
          <Text dimColor>{fit(`${fmtTokens(Math.max(0, flow.window - main.contextTokens))} remaining`, width)}</Text>
        ) : null}
      </Box>
    )

    // Workflow steps fill the prompt with the command; there is no record of which step is current.
    const actions = skills.filter(name => !flowSkills.includes(name))
    const buttons = (
      <Box key="buttons" flexDirection="column">
        {flowSkills.length ? (
          <Box key="wf" marginTop={1} flexDirection="column">
            {sectionHead('wf', 'Workflow')}
            <Box key="flow-skills" flexDirection="row" flexWrap="wrap" columnGap={1}>
              {flowSkills.map(name => (
                <Button key={`${FLOW_KEY}${name}`} plain label={shortLabel(name)} onPress={noop} />
              ))}
            </Box>
          </Box>
        ) : null}
        {actions.length ? (
          <Box key="ac" marginTop={1} flexDirection="column">
            {sectionHead('ac', 'Actions')}
            <Box key="skills" flexDirection="row" flexWrap="wrap" columnGap={1}>
              {actions.flatMap((name, i) => [
                ...(i ? [<Text key={`ss:${i}`} dimColor>{'·'}</Text>] : []),
                <Button key={`${SKILL_KEY}${name}`} plain label={shortLabel(name)} onPress={noop} />,
              ])}
            </Box>
          </Box>
        ) : null}
      </Box>
    )

    const detail = chosen ? (
      <Box key="detail" flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
        {chosen.id === MAIN ? mainDetail(chosen) : agentDetail(chosen)}
      </Box>
    ) : null

    function mainDetail(node: FlowNode) {
      const w = width - 4
      const x = exchanged(node)
      const used = (breakdown ?? []).filter(cat => cat.kind === 'used' && cat.tokens > 0)
      used.sort((a, b) => b.tokens - a.tokens)
      return [
        <Text key="t" bold>{fit(`main loop · ${node.steps} requests · ${node.model ?? ''}`, w)}</Text>,
        <Text key="x" dimColor>
          {fit(`${x.kids} subagents · ↓ ${fmtTokens(x.down)} handed down · ↑ ${fmtTokens(x.up)} back`, w)}
        </Text>,
        <Text key="ch" color="cyan" bold>{'context by category'}</Text>,
        ...(used.length
          ? used.slice(0, 8).map((cat, i) => (
              <Text key={`cat:${i}`}>
                {fit(cat.name, w - 8).padEnd(Math.max(1, w - 8))}
                <Text color="magenta">{fmtTokens(cat.tokens).padStart(7)}</Text>
              </Text>
            ))
          : [<Text key="nb" dimColor>{'press refresh to read the breakdown'}</Text>]),
        <Text key="th" color="cyan" bold>{'tools by time (session)'}</Text>,
        ...(Object.keys(watch.stats).length
          ? topTools(watch, 8).map((s, i) => (
              <Text key={`ts:${i}`}>
                {fit(s.tool, 14).padEnd(14)}
                <Text dimColor>{`${String(s.calls).padStart(4)}× avg ${fmtDuration(Math.round(s.totalMs / s.calls)).padStart(6)} max ${fmtDuration(s.maxMs).padStart(6)}`}</Text>
                {s.fails ? <Text color="red">{` ${s.fails} failed`}</Text> : null}
              </Text>
            ))
          : [<Text key="tn" dimColor>{'no tool calls yet'}</Text>]),
      ]
    }

    function agentDetail(node: FlowNode) {
      const w = width - 4
      const parent = node.parentId === MAIN ? 'main' : flow.nodes.get(node.parentId ?? '')?.type ?? 'parent'
      const parentCtx = flow.nodes.get(node.parentId ?? MAIN)?.contextTokens
      const meta = [node.model, node.status, fmtDuration(node.durationMs), node.background ? 'background' : '']
      const out = [
        <Text key="t" bold>{fit(`${petOf(node)} ${node.type}  ${node.description}`, w)}</Text>,
        <Text key="m" dimColor>{fit(meta.filter(Boolean).join(' · '), w)}</Text>,
        <Text key="in" color="cyan" bold>
          {fit(
            node.fork
              ? `↓ in from ${parent}: its whole context (~${fmtTokens(parentCtx)}) + ${fmtTokens(estimateTokens(node.prompt))}`
              : node.unlisted
                ? '↓ in: not seen (a loop no Agent call announced)'
                : `↓ in from ${parent}: prompt ${fmtTokens(estimateTokens(node.prompt))} tok`,
            w,
          )}
        </Text>,
        ...excerpt(node.prompt, 4, w - 2).map((l, i) => <Text key={`p:${i}`} dimColor>{`  ${l}`}</Text>),
        <Text key="w" color="yellow" bold>
          {fit(
            `⚙ ${node.steps} requests · ctx ${fmtTokens(node.contextTokens)} (peak ${fmtTokens(node.peakContext)}) · out ${fmtTokens(node.outputTokens)}`,
            w,
          )}
        </Text>,
        ...node.tools.slice(-5).map((u, i) => (
          <Text key={`u:${i}`} color={u.isError ? 'red' : undefined} dimColor={!u.isError}>
            {fit(`  ${u.ms !== undefined ? `${fmtDuration(u.ms)} ` : ''}${u.tool} ${u.label}`, w)}
          </Text>
        )),
        node.toolCount > 5 ? <Text key="more" dimColor>{`  … ${node.toolCount} tool calls in all`}</Text> : null,
        <Text key="o" color="green" bold>
          {fit(
            node.answer !== undefined
              ? `↑ out to ${parent}: answer ${fmtTokens(estimateTokens(node.answer))} tok`
              : `↑ out to ${parent}: still working`,
            w,
          )}
        </Text>,
        ...(node.answer ? excerpt(node.answer, 4, w - 2) : []).map((l, i) => (
          <Text key={`a:${i}`} dimColor>{`  ${l}`}</Text>
        )),
      ]
      const kids = exchanged(node)
      if (kids.kids) {
        out.push(
          <Text key="k" dimColor>
            {fit(`${kids.kids} subagents · ↓ ${fmtTokens(kids.down)} · ↑ ${fmtTokens(kids.up)}`, w)}
          </Text>,
        )
      }
      return out
    }

    const watchBlock = (
      <Box key="watch" marginTop={1} flexDirection="column">
        {watch.compacts.length ? sectionHead('compacts', `Compactions · ${watch.compacts.length}`) : null}
        {watch.compacts.slice(-2).map((c, i) => (
          <Text key={`cp:${i}`} dimColor>
            {fit(
              `${clock(c.at)} ${c.trigger} ${loopName(c.loop)} ${c.skip !== undefined ? `skipped: ${c.skip}` : `${fmtTokens(c.before)} → ${fmtTokens(c.after)}`}`,
              width,
            )}
          </Text>
        ))}
      </Box>
    )

    const touchedRepos = listed(repos)
    const cwdTop = sessionCwd ? topOf.get(sessionCwd) ?? undefined : undefined
    const gitBlock = (
      <Box key="git" marginTop={1} flexDirection="column">
        {sectionHead('git', `Git · ${touchedRepos.length} repo${touchedRepos.length === 1 ? '' : 's'}`)}
        {touchedRepos.map(r => {
          const used = [r.edit ? `${r.edit}✎` : '', r.git ? `${r.git} git` : '', r.read ? `${r.read} read` : '']
            .filter(Boolean)
            .join(' ')
          const name = `${repoPath(r.top)}${r.top === cwdTop ? ' (cwd)' : ''}`
          return (
            <Box key={`repo:${r.top}`} flexDirection="column">
              <Text>
                <Text color={r.edit ? 'yellow' : undefined} dimColor={!r.edit && !r.git}>{fit(name, width)}</Text>
                {used ? <Text dimColor>{fit(`  ${used}`, Math.max(0, width - name.length))}</Text> : null}
              </Text>
              <Text>
                <Text dimColor>{'  └─'}</Text>
                <Text color="green">{fit(` ⎇ ${r.branch ?? '…'}`, Math.max(4, width - 4))}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    const big = bigPet(width)
    // Docked, the pane is taller than the tree: fill it so the legend sits on the last rows.
    const fill = e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined
    return (
      <Box flexDirection="column" minHeight={fill}>
        {header}
        <Box key="ag-head" marginTop={1}>
          {/* each count in its status colour, so a failure reads red in the header too */}
          <Text bold wrap="truncate-end">
            <Text color="cyan">{'Agents '}</Text>
            <Text color={STATUS_COLOR.running}>{`${c.running} running`}</Text>
            <Text color={STATUS_COLOR.done}>{` · ${c.done} done`}</Text>
            {c.failed ? <Text color={STATUS_COLOR.failed}>{` · ${c.failed} failed`}</Text> : null}
            {c.stopped ? <Text color={STATUS_COLOR.aborted}>{` · ${c.stopped} stopped`}</Text> : null}
          </Text>
        </Box>
        {agentRow(main, '')}
        {tree.map(r =>
          isMore(r) ? (
            <Box key={`more:${r.more}`} flexDirection="row">
              <Text dimColor>{r.prefix}</Text>
              <Button
                key={`${MORE_KEY}${r.more}`}
                plain
                dimColor
                label={fit(r.open ? ' show fewer shells' : ` ${r.hidden} more shells done`, Math.max(4, width - r.prefix.length))}
                onPress={noop}
              />
            </Box>
          ) : (
            agentRow(r.node, r.prefix)
          ),
        )}
        {detail}
        {touchedRepos.length ? gitBlock : null}
        {watch.compacts.length ? watchBlock : null}
        {/* docked, the free rows split above and below the mascot so it sits mid-pane */}
        <Box key="spacer-top" flexGrow={1} />
        <Box key="big" marginTop={1} flexDirection="column">
          {big.lines.map((l, i) => (
            <Text key={`big:${i}`} color={c.running ? 'yellow' : 'cyan'}>
              {l}
            </Text>
          ))}
        </Box>
        <Box key="spacer" flexGrow={1} />
        {buttons}
        <Box key="legend" marginTop={1} flexDirection="column">
          <Box key="pets-head" flexDirection="row">
            <Button key={PETS_KEY} plain label={fit(`${petsOpen ? '▾' : '▸'} Pets · ${LEGEND.length}`, width)} onPress={noop} />
          </Box>
          {(petsOpen ? LEGEND : []).map((l, i) => (
            <Text key={`lg:${i}`} dimColor>
              {fit(l, width)}
            </Text>
          ))}
          {petsOpen ? (
            <Text>
              <Text color={STATUS_COLOR.running}>{'running '}</Text>
              <Text color={STATUS_COLOR.done}>{'done '}</Text>
              <Text color={STATUS_COLOR.failed}>{'failed '}</Text>
              <Text color={STATUS_COLOR.aborted}>{'stopped'}</Text>
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  })
}
