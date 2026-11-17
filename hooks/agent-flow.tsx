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
 * It only observes: every hook passes its event on unchanged, and the only
 * engine reads are `$.agent.list()` and `$.session.usage()`. The flow is
 * recorded from session start whether the pane is open or not.
 *
 * Needs Claude Code >= 2.1.287.
 *
 * Options (pluginConfigs["agent-flow@skills-dir"].options):
 *   columns: number      width asked for the docked pane (default 52)
 *   maxAgents: number    subagents kept, oldest finished dropped first (default 60)
 *   openOnStart: boolean open the pane when the session starts (default false)
 *   openOnAgent: boolean open the pane (without focus) when an Agent call spawns a subagent (default true)
 */
import { atom, read, update } from 'claude-code'
import type { ContextCategory, EngineInterface, Register, SessionContextUsage, SessionCost, Timer } from 'claude-code'

import type { SavedFlow } from '../types'
import {
  MAIN,
  bar,
  completed,
  counts,
  createFlow,
  estimateTokens,
  excerpt,
  fit,
  fmtDuration,
  fmtTokens,
  mainTurn,
  maxAgents,
  paneColumns,
  rows,
  spawned,
  stepped,
  synced,
  toolLabel,
  toolRan,
  trimmed,
} from './flow.ts'
import type { Flow, FlowNode, Status } from './flow.ts'

const PANE = 'agent-flow'
const COMMAND = 'agent-flow'
const KEY = 'ag:'

let flow: Flow = createFlow()
let isOpen = false
let selected: string | undefined
let breakdown: ContextCategory[] | undefined

const STATUS_COLOR: Record<Status, string> = { running: 'yellow', done: 'green', failed: 'red', aborted: 'gray' }

// Pets: the species tells the model tier at a glance, the trailing marks tell the status.
const PET_TICK_MS = 400
let petFrame = 0
let petTimer: Timer | undefined
const SPECIES: [RegExp, string][] = [
  [/haiku/i, '🐹'],
  [/sonnet/i, '🐶'],
  [/opus/i, '🦊'],
  [/fable/i, '🐉'],
]
// Agents the engine knows but the flow never saw (spawned before this pane's state existed,
// or lost to a reload) still belong to the session's history: take them in from the list.
type Listed = { id: string; status: string; type: string; description: string; parentId?: string; name?: string }
function adopted(list: readonly Listed[], now: number): boolean {
  let added = false
  for (const info of list) {
    if (flow.nodes.has(info.id)) continue
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
  if (node.type === 'shell') return '🐢'
  return SPECIES.find(([re]) => node.model !== undefined && re.test(node.model))?.[1] ?? '🐰'
}
// Stopped, failed or finished: all asleep. The status colour and the detail still tell them apart.
const RESTING: Record<Status, string> = { running: '', done: '💤', failed: '💤', aborted: '💤' }

// History: module variables start over on a hot reload, $.state does not, so the flow is
// kept there and read back when the session start it was saved under is still the current one.
const savedAtom = atom({ plugin: 'agent-flow', key: 'saved' } as const, null as SavedFlow)
let sessionStartedAt: number | undefined

async function saveFlow($: EngineInterface) {
  if (sessionStartedAt === undefined) return
  const text = JSON.stringify({ startedAt: sessionStartedAt, nodes: [...flow.nodes.values()], order: flow.order, turn: flow.turn })
  await update($, savedAtom, () => text).catch(() => undefined)
}

function restored(text: SavedFlow, startedAt: number): Flow | undefined {
  if (!text) return undefined
  try {
    const s = JSON.parse(text) as { startedAt?: unknown; nodes?: unknown; order?: unknown; turn?: unknown }
    if (s.startedAt !== startedAt || !Array.isArray(s.nodes) || !Array.isArray(s.order)) return undefined
    const nodes = new Map<string, FlowNode>()
    for (const n of s.nodes as FlowNode[]) if (n && typeof n.id === 'string') nodes.set(n.id, n)
    if (!nodes.has(MAIN)) return undefined
    const order = (s.order as unknown[]).filter((id): id is string => typeof id === 'string' && nodes.has(id))
    return { nodes, order, turn: typeof s.turn === 'number' ? s.turn : 0 }
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

function bigPet(width: number): { lines: string[]; caption: string } {
  let busy = 0
  for (const n of flow.nodes.values()) if (n.status === 'running') busy += 1
  // a slower beat than the tree badges: one art frame every three ticks
  const beat = Math.floor(petFrame / 3) % 4
  const art = (busy ? BIG_AWAKE : BIG_ASLEEP)[beat] ?? []
  const caption = busy ? `awake · ${busy} working` : 'asleep · nothing running'
  // art and caption share one centre line
  return {
    lines: art.map(l => centred(width, 12) + l),
    caption: centred(width, caption.length) + caption,
  }
}
// Fixed width either way, so the tree column does not jitter while a pet runs.
function petMark(node: FlowNode): string {
  if (node.status === 'running') return `${petOf(node)}${['💨  ', ' 💨 ', '  💨'][petFrame % 3]}`
  return `${petOf(node)}${RESTING[node.status]}  `
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

function contextText(context: SessionContextUsage, cost: SessionCost | undefined, startedAt: number | undefined, now: number) {
  if (context.tokens === undefined) return undefined
  const mark = context.tokens >= HARD_AT ? '🔴' : context.tokens >= WARN_AT ? '🟡' : '🟢'
  const pct = context.percent === undefined ? '' : ` ${context.percent}%`
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

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    flow = createFlow(Date.now())
    const usage = await $.session.usage().catch(() => undefined)
    sessionStartedAt = usage?.startedAt
    if (usage) contextLine = contextText(usage.context, usage.cost, usage.startedAt, await $.clock.now())
    $.ui.status(statusText())
    if (sessionStartedAt !== undefined) flow = restored(await read($, savedAtom), sessionStartedAt) ?? flow
    if (adopted(await $.agent.list().catch(() => []), Date.now())) await saveFlow($)
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
      trimmed(flow, counts(flow).running)
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
    return { text: `${c.running + c.done + c.failed} agents so far · ${hint} · /${COMMAND} stop closes` }
  })

  on('turn.start', async ($, e, next) => {
    // Since Claude Code 2.1.299 a subagent's or teammate's turn starts here too (its prompt in `e.text`).
    // Subagents enter the flow through agent.spawn.
    if (e.agentId !== undefined) return next(e)
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
      // no focus: the spawn happens mid-turn and the person may be typing the next prompt
      if (!isOpen && openOnAgent) {
        isOpen = true
        await $.ui.open({ id: PANE, title: 'agents', columns }).catch(err => {
          isOpen = false
          $.ui.log(`agent-flow: pane not opened: ${err}`, { to: 'debug' })
        })
      }
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
    toolRan(flow, e.agentId, use, Date.now())
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    const r = await next(e)
    if (r.deny !== undefined || r.isError) {
      Object.assign(use, { isError: true })
      if (isOpen) {
        $.ui.status(statusText())
        $.ui.invalidate('ui.render')
      }
    }
    // A shell sent to the background (asked for, or moved there by its timeout) joins the flow as a pet.
    const fields = e as unknown as Record<string, unknown>
    const bgId = (r.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
    if (e.tool === 'Bash' && typeof bgId === 'string') {
      const command = typeof fields.command === 'string' ? fields.command : ''
      const description = typeof fields.description === 'string' && fields.description ? fields.description : command
      spawned(
        flow,
        { agentId: shellId(bgId), parentAgentId: e.agentId, description, subagentType: 'shell', prompt: command, fork: false, background: true },
        Date.now(),
      )
      trimmed(flow, keep)
      await saveFlow($)
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
    if (isOpen) {
      $.ui.status(statusText())
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    flow.window = e.context.window
    flow.percent = e.context.percent
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
    if (key === 'close') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return r
    }
    if (key === 'clear') {
      trimmed(flow, counts(flow).running)
      if (selected && !flow.nodes.has(selected)) selected = undefined
    } else if (key === 'refresh') {
      synced(flow, await $.agent.list().catch(() => []))
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns - 1)
    const noop = () => {}
    const main = flow.nodes.get(MAIN)!
    const tree = rows(flow)
    const c = counts(flow)
    const chosen = selected ? flow.nodes.get(selected) : undefined

    const agentRow = (node: FlowNode, prefix: string) => {
      const ctx = node.contextTokens !== undefined ? fmtTokens(node.contextTokens) : ''
      const tools = node.toolCount ? `${node.toolCount}⚒` : ''
      const right = [ctx, tools].filter(Boolean).join(' ')
      const room = width - prefix.length - 2 - (right ? right.length + 1 : 0)
      const name = node.id === MAIN ? 'main' : `${node.type}${node.fork ? ' (fork)' : ''}  ${node.description}`
      return (
        <Box key={`row:${node.id}`} flexDirection="row">
          {prefix ? <Text dimColor>{prefix}</Text> : null}
          <Text color={STATUS_COLOR[node.status]}>{`${petMark(node)} `}</Text>
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
          {flow.percent !== undefined ? <Text dimColor>{` ${flow.percent}%`}</Text> : null}
        </Text>
        {flow.percent !== undefined ? (
          <Text color={flow.percent > 80 ? 'red' : flow.percent > 60 ? 'yellow' : 'green'}>
            {bar(flow.percent, Math.min(width, 40))}
          </Text>
        ) : null}
        {main.prompt ? <Text dimColor wrap="truncate-end">{`› ${main.prompt.replace(/\s+/g, ' ')}`}</Text> : null}
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
            {fit(`  ${u.tool} ${u.label}`, w)}
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

    const big = bigPet(width)
    return (
      <Box flexDirection="column">
        {header}
        <Box key="ag-head" marginTop={1}>
          <Text bold color="cyan">
            {fit(`Agents (${c.running} running · ${c.done} done${c.failed ? ` · ${c.failed} failed` : ''})`, width)}
          </Text>
        </Box>
        {agentRow(main, '')}
        {tree.map(r => agentRow(r.node, r.prefix))}
        {tree.length === 0 ? <Text dimColor>{fit('  no subagents yet', width)}</Text> : null}
        {detail}
        <Box key="big" marginTop={1} flexDirection="column">
          {big.lines.map((l, i) => (
            <Text key={`big:${i}`} color={c.running ? 'yellow' : 'cyan'}>
              {l}
            </Text>
          ))}
          <Text dimColor>{fit(big.caption, width)}</Text>
        </Box>
      </Box>
    )
  })
}
