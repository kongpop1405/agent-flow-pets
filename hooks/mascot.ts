// The mascots between the Git section and Workflow: one per running loop, drawn in plain ASCII
// so every row is exactly as wide as it looks (emoji widths differ between fonts).
// Pure data and layout, no engine calls, so node can test it directly.

export type Kind = 'cat' | 'chick' | 'penguin' | 'koala' | 'owl' | 'hamster' | 'dog' | 'panda' | 'unicorn' | 'rabbit'
export type Size = 'S' | 'L'
export type Mascot = { kind: Kind; asleep?: boolean }

const block = (lines: string[]) => {
  const w = Math.max(...lines.map(l => l.length))
  return lines.map(l => l.padEnd(w))
}

const ART: Record<Kind, Record<Size, string[]>> = {
  cat: {
    S: [' /\\_/\\', '( o.o )', ' > ^ <', '(")_(")'],
    L: [
      '   /\\_____/\\',
      '  /  o   o  \\',
      ' ( ==  ^  == )',
      '  )         (',
      ' (           )',
      '( (  )   (  ) )',
      '(__(__)___(__)__)',
    ],
  },
  chick: {
    S: ['   __', ' <(o )_', '  ( ._>', "   '-'"],
    L: ['     ,', "   .-'-.", '  ( o o )', '  (  v  )', ' /(     )\\', "   '---'", '    ^ ^'],
  },
  penguin: {
    S: ['  .-.', ' (o o)', '/( v )\\', '  ^ ^'],
    L: ['    .---.', '   / o o \\', '   \\  v  /', "  /'-----'\\", ' / |     | \\', '   \\_____/', '    ^   ^'],
  },
  koala: {
    S: ['@(   )@', ' (o o)', ' ( Y )', "  '''"],
    L: [' .--.     .--.', '( @  )---(  @ )', " '--( o   o )'", '    (   V   )', '    (  ._.  )', '    (__/ \\__)'],
  },
  owl: {
    S: [' ,_,', '(O,O)', '(   )', '-"-"-'],
    L: ['  /\\     /\\', ' ((O)   (O))', '  \\   v   /', '  /(     )\\', ' / (     ) \\', '   (_____)', '    "   "'],
  },
  hamster: {
    S: [' ()_()', '(=o.o=)', '( >w< )', ' "" ""'],
    L: ['   ()_____()', '  /  o   o  \\', ' (=   .w.   =)', ' (  (     )  )', "  \\  '---'  /", "   '--\"-\"--'"],
  },
  dog: {
    S: [' /^ ^\\', '/ 0 0 \\', 'V\\ Y /V', ' / - \\'],
    L: ['   __     __', '  /  \\___/  \\', ' /  /o   o\\  \\', ' \\_/   Y   \\_/', '   \\  \\_/  /', "   /'-----'\\", '  (_)     (_)'],
  },
  panda: {
    S: ['(o)_(o)', ' (@ @)', ' ( w )', "  '''"],
    L: [' (@@)     (@@)', '   /       \\', '  | (@) (@) |', '  |    w    |', '   \\  ---  /', '  (@@)   (@@)'],
  },
  unicorn: {
    S: ['   \\', ' /\\_\\', '( o.o)~', ' > ^ <~'],
    L: ['      \\', '    __/\\__', '   /  o   \\~~', '  (    __  )~~', '   \\__/  \\_)~', '     |   |', '     "   "'],
  },
  rabbit: {
    S: ['(\\(\\', '( o.o)', 'o_(")(")'],
    L: ['   (\\   /)', '   ( \\ / )', '  ( o   o )', '  (   ^   )', ' (  (   )  )', ' (__)---(__)'],
  },
}
for (const v of Object.values(ART)) for (const s of ['S', 'L'] as const) v[s] = block(v[s])

// Nothing running: the cat sleeps, with z's drifting up beside its head.
const ASLEEP: Record<Size, string[]> = {
  S: block([' /\\_/\\', '( -.- )', ' > ^ <', '(")_(")~']),
  L: block([
    '   /\\_____/\\',
    '  /  -   -  \\',
    ' ( ==  ^  == )',
    '  )         (',
    ' (           )',
    '( (  )   (  ) )',
    '(__(__)___(__)__)',
  ]),
}
const Z_FRAMES = [
  ['    ', '    '],
  ['   z', '    '],
  ['  Z ', '   z'],
  [' Z  ', '  Z '],
]

/** One frame of one mascot; `beat` turns once per art frame, `i` staggers neighbours. */
export function mascotArt(m: Mascot, size: Size, beat: number, i = 0): string[] {
  if (m.asleep) {
    const z = Z_FRAMES[beat % Z_FRAMES.length]!
    return ASLEEP[size].map((l, y) => l + (z[y] ?? '    '))
  }
  // a working pet hops one column side to side, out of step with the one next to it
  const left = (beat + i) % 2 === 0
  return ART[m.kind][size].map(l => (left ? `${l} ` : ` ${l}`))
}

/** Greedy rows of items `widths` wide in `width` columns, `gap` apart: the index lists per row. */
export function packRows(widths: readonly number[], width: number, gap: number): number[][] {
  const out: number[][] = []
  let row: number[] = []
  let used = 0
  widths.forEach((w, i) => {
    if (row.length && used + gap + w > width) {
      out.push(row)
      row = []
      used = 0
    }
    used += (row.length ? gap : 0) + w
    row.push(i)
  })
  if (row.length) out.push(row)
  return out
}

const GAP = 2

function draw(blocks: string[][], rowsOf: number[][], width: number): string[] {
  const out: string[] = []
  rowsOf.forEach((idx, r) => {
    if (r) out.push('')
    const h = Math.max(...idx.map(i => blocks[i]!.length))
    // bottom-aligned, so pets of different heights stand on one floor
    const padded = idx.map(i => {
      const b = blocks[i]!
      return [...Array<string>(h - b.length).fill(' '.repeat(b[0]!.length)), ...b]
    })
    const rowWidth = padded.reduce((s, b) => s + b[0]!.length, 0) + GAP * (idx.length - 1)
    const left = ' '.repeat(Math.max(0, Math.floor((width - rowWidth) / 2)))
    for (let y = 0; y < h; y++) out.push((left + padded.map(b => b[y]).join(' '.repeat(GAP))).trimEnd())
  })
  return out
}

const heightOf = (blocks: string[][], rowsOf: number[][]) =>
  rowsOf.reduce((s, idx) => s + Math.max(...idx.map(i => blocks[i]!.length)), 0) + Math.max(0, rowsOf.length - 1)

/**
 * The lines for `pets` in at most `rows` rows and `width` columns. Big art first, wrapping onto
 * more rows while the height allows; then the small art the same way; what still does not fit
 * is counted on a last `+N more` line. No room for even one small pet: no lines at all.
 */
export function mascotRows(pets: readonly Mascot[], rows: number, width: number, beat: number): string[] {
  if (!pets.length) return []
  for (const size of ['L', 'S'] as const) {
    const blocks = pets.map((m, i) => mascotArt(m, size, beat, i))
    if (blocks.some(b => b[0]!.length > width)) continue
    const rowsOf = packRows(
      blocks.map(b => b[0]!.length),
      width,
      GAP,
    )
    if (heightOf(blocks, rowsOf) <= rows) return draw(blocks, rowsOf, width)
  }
  const blocks = pets.map((m, i) => mascotArt(m, 'S', beat, i))
  if (blocks.some(b => b[0]!.length > width)) return []
  const rowsOf = packRows(
    blocks.map(b => b[0]!.length),
    width,
    GAP,
  )
  // keep whole rows while they and the `+N more` line still fit
  const kept: number[][] = []
  for (const idx of rowsOf) {
    if (heightOf(blocks, [...kept, idx]) + 1 > rows) break
    kept.push(idx)
  }
  if (!kept.length) return []
  const hidden = pets.length - kept.reduce((s, idx) => s + idx.length, 0)
  const more = `+${hidden} more`
  return [...draw(blocks, kept, width), ' '.repeat(Math.max(0, Math.floor((width - more.length) / 2))) + more]
}
