// Which git repos the session touched and the branch each sits on. Plain data, no engine
// calls, like flow.ts: the hooks module runs git and feeds the answers in.

export type TouchKind = 'edit' | 'git' | 'read'

export type RepoTouch = {
  /** the repo's toplevel, as git prints it */
  top: string
  /** branch name, `detached <sha>`, or undefined until git answered */
  branch?: string
  edit: number
  git: number
  read: number
  /** last touch */
  at: number
}

export type Repos = Record<string, RepoTouch>

export const KEEP_REPOS = 12

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const unquote = (s: string) => s.replace(/^["']|["']$/g, '')

const isAbs = (p: string) => /^(?:[A-Za-z]:[\\/]|\/|~[\\/]?)/.test(p)

/** `/c/x` (Git Bash) → `C:/x`, `~` → home, backslashes kept for git to read. */
function normal(p: string, home: string | undefined): string {
  let out = unquote(p.trim())
  if (home && (out === '~' || out.startsWith('~/') || out.startsWith('~\\'))) out = home + out.slice(1)
  const drive = /^\/([A-Za-z])(\/|$)/.exec(out)
  if (drive) out = `${drive[1]!.toUpperCase()}:/${out.slice(3)}`
  return out
}

const dirOf = (file: string) => {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return i > 0 ? file.slice(0, i) : file
}

/**
 * The directories a tool call worked in, each with what it did there: a file's folder for
 * Edit/Write/Read, `git -C <dir>` / `cd <dir>` for a shell running git, else the session's cwd.
 * A shell call that runs no git touches nothing: building or listing is not repo work.
 */
export function touchedDirs(
  tool: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
  home?: string,
): { dir: string; kind: TouchKind }[] {
  if (EDIT_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    const kind: TouchKind = EDIT_TOOLS.has(tool) ? 'edit' : 'read'
    const file = str(input.file_path) ?? str(input.notebook_path)
    if (file) return [{ dir: normal(isAbs(file) ? dirOf(file) : `${cwd ?? '.'}/${dirOf(file)}`, home), kind }]
    const path = str(input.path)
    if (path) return [{ dir: normal(path, home), kind }]
    return cwd ? [{ dir: cwd, kind }] : []
  }
  if (!SHELL_TOOLS.has(tool)) return []
  const command = str(input.command)
  // git as a command of its own, not a word inside one (`grep git notes.md`)
  if (!command || !/(?:^|[;&|(\n]\s*)git\s/.test(command)) return []
  const dirs: string[] = []
  const path = String.raw`("[^"]+"|'[^']+'|[^\s;&|)]+)`
  for (const m of command.matchAll(new RegExp(String.raw`\bgit\s+-C\s+${path}`, 'g'))) dirs.push(m[1]!)
  if (!dirs.length) {
    for (const m of command.matchAll(new RegExp(String.raw`(?:^|[;&|(]\s*)cd\s+${path}`, 'g'))) dirs.push(m[1]!)
  }
  const usable = dirs.map(d => normal(d, home)).filter(d => !d.includes('$') && !d.includes('%'))
  // a path held in a shell variable cannot be read here: guessing the cwd would credit the wrong repo
  if (dirs.length && !usable.length) return []
  const out = usable.map(d => (isAbs(d) || !cwd ? d : `${cwd}/${d}`))
  if (!out.length && cwd) out.push(cwd)
  return [...new Set(out)].map(dir => ({ dir, kind: 'git' as const }))
}

/** Counts a touch on the repo at `top`, dropping the stalest past KEEP_REPOS. */
export function touched(repos: Repos, top: string, kind: TouchKind, now: number): RepoTouch {
  const r = (repos[top] ??= { top, edit: 0, git: 0, read: 0, at: now })
  r[kind] += 1
  r.at = now
  const keys = Object.keys(repos)
  if (keys.length > KEEP_REPOS) {
    keys.sort((a, b) => repos[a]!.at - repos[b]!.at)
    for (const k of keys.slice(0, keys.length - KEEP_REPOS)) if (k !== top) delete repos[k]
  }
  return r
}

/** `git symbolic-ref` / `rev-parse` output → what the pane shows. */
export function branchText(symbolic: string | undefined, sha: string | undefined): string | undefined {
  const name = symbolic?.trim()
  if (name) return name
  const s = sha?.trim()
  return s ? `detached ${s}` : undefined
}

/** Repos, edited first, then git work, then reads; the newest first within each. */
export function listed(repos: Repos): RepoTouch[] {
  const rank = (r: RepoTouch) => (r.edit ? 0 : r.git ? 1 : 2)
  return Object.values(repos).sort((a, b) => rank(a) - rank(b) || b.at - a.at)
}

export const repoName = (top: string) => top.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || top

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function restoredRepos(v: unknown): Repos {
  const out: Repos = {}
  if (!isObj(v)) return out
  for (const [top, r] of Object.entries(v)) {
    if (!isObj(r)) continue
    const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0)
    out[top] = {
      top,
      branch: typeof r.branch === 'string' ? r.branch : undefined,
      edit: num('edit'),
      git: num('git'),
      read: num('read'),
      at: num('at'),
    }
  }
  return out
}
