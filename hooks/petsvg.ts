// The mascots as one SVG: flat, coloured animals for the surfaces that draw `Svg` (the editor,
// the desktop and mobile apps). The terminal has no Svg, so it keeps the ASCII art in mascot.ts.
// Pure strings, no engine calls, so node can render and test it directly.

import type { Kind, Mascot } from './mascot.ts'

const INK = '#3b2f2f'
const CHEEK = '#ff8fa3'
const EDGE = 'stroke="#00000026" stroke-width="1"'

type Look = { fur: string; belly: string; head?: string; ears: string; face: string }

// Each pet sits in a 100×100 cell: head circle at (50,48) r26, body at (50,82).
const LOOKS: Record<Kind, Look> = {
  cat: {
    fur: '#f4a259',
    belly: '#ffe3c2',
    ears: `<path d="M27 38 L30 12 L47 27 Z" fill="#f4a259" ${EDGE}/><path d="M73 38 L70 12 L53 27 Z" fill="#f4a259" ${EDGE}/>
<path d="M31 32 L32 19 L41 27 Z" fill="#ffc8a8"/><path d="M69 32 L68 19 L59 27 Z" fill="#ffc8a8"/>`,
    face: `<path d="M46 27 v6 M50 26 v7 M54 27 v6" stroke="#d9822b" stroke-width="2" stroke-linecap="round"/>
<path d="M48 55 h4 l-2 2.5 z" fill="#e5737f"/>
<path d="M22 55 h10 M22 60 l10 -2 M78 55 h-10 M78 60 l-10 -2" stroke="${INK}" stroke-width="1" opacity=".5"/>`,
  },
  chick: {
    fur: '#ffd23f',
    belly: '#fff1a8',
    ears: `<path d="M48 23 q0 -10 6 -9 q-4 3 -3 9 z" fill="#f5b700"/>`,
    face: `<path d="M45 55 L55 55 L50 62 Z" fill="#ff8c1a"/>`,
  },
  penguin: {
    fur: '#34405a',
    belly: '#ffffff',
    ears: '',
    face: `<ellipse cx="41" cy="52" rx="10" ry="12" fill="#ffffff"/><ellipse cx="59" cy="52" rx="10" ry="12" fill="#ffffff"/>
<ellipse cx="50" cy="60" rx="15" ry="9" fill="#ffffff"/><path d="M45 55 L55 55 L50 61 Z" fill="#ff9f1c"/>`,
  },
  koala: {
    fur: '#a3a9b6',
    belly: '#e6e8ee',
    ears: `<circle cx="25" cy="34" r="14" fill="#a3a9b6" ${EDGE}/><circle cx="75" cy="34" r="14" fill="#a3a9b6" ${EDGE}/>
<circle cx="25" cy="34" r="8" fill="#e6e8ee"/><circle cx="75" cy="34" r="8" fill="#e6e8ee"/>`,
    face: `<ellipse cx="50" cy="57" rx="6" ry="8" fill="#3d3d4a"/>`,
  },
  owl: {
    fur: '#8d6346',
    belly: '#ecdab8',
    ears: `<path d="M27 32 L26 14 L40 25 Z" fill="#8d6346"/><path d="M73 32 L74 14 L60 25 Z" fill="#8d6346"/>`,
    face: `<circle cx="40" cy="47" r="11" fill="#f3e3c3"/><circle cx="60" cy="47" r="11" fill="#f3e3c3"/>
<path d="M47 56 L53 56 L50 62 Z" fill="#f29e38"/>`,
  },
  hamster: {
    fur: '#e8b37a',
    belly: '#fff4e6',
    ears: `<circle cx="31" cy="26" r="8" fill="#e8b37a" ${EDGE}/><circle cx="69" cy="26" r="8" fill="#e8b37a" ${EDGE}/>
<circle cx="31" cy="26" r="4" fill="#ffc2c2"/><circle cx="69" cy="26" r="4" fill="#ffc2c2"/>`,
    face: `<ellipse cx="33" cy="58" rx="9" ry="7" fill="#fff4e6"/><ellipse cx="67" cy="58" rx="9" ry="7" fill="#fff4e6"/>
<ellipse cx="50" cy="55" rx="2.4" ry="1.8" fill="#e5737f"/>`,
  },
  dog: {
    fur: '#e0ac74',
    belly: '#fbe6cc',
    ears: `<ellipse cx="25" cy="48" rx="8" ry="17" fill="#8b5a2b" transform="rotate(18 25 48)"/>
<ellipse cx="75" cy="48" rx="8" ry="17" fill="#8b5a2b" transform="rotate(-18 75 48)"/>`,
    face: `<ellipse cx="50" cy="58" rx="9" ry="6.5" fill="#fbe6cc"/><ellipse cx="50" cy="55" rx="3.6" ry="2.6" fill="${INK}"/>
<path d="M48 61 q2 5 4 0 z" fill="#ff7a8a"/>`,
  },
  panda: {
    fur: '#fafafa',
    belly: '#ffffff',
    ears: `<circle cx="29" cy="27" r="9" fill="#2b2b2b"/><circle cx="71" cy="27" r="9" fill="#2b2b2b"/>`,
    face: `<ellipse cx="40" cy="49" rx="7" ry="9" fill="#2b2b2b" transform="rotate(25 40 49)"/>
<ellipse cx="60" cy="49" rx="7" ry="9" fill="#2b2b2b" transform="rotate(-25 60 49)"/>
<ellipse cx="50" cy="57" rx="3" ry="2" fill="#2b2b2b"/>`,
  },
  unicorn: {
    fur: '#f6f1ff',
    belly: '#ffffff',
    ears: `<path d="M44 25 L50 0 L56 25 Z" fill="#ffd166" ${EDGE}/><path d="M46 18 l8 -2 M47 11 l6 -2" stroke="#e0a800" stroke-width="1.4"/>
<path d="M30 33 L31 16 L42 27 Z" fill="#f6f1ff" ${EDGE}/><path d="M70 33 L69 16 L58 27 Z" fill="#f6f1ff" ${EDGE}/>
<circle cx="62" cy="25" r="6" fill="#ff9ecf"/><circle cx="72" cy="32" r="6" fill="#a78bfa"/><circle cx="77" cy="42" r="5" fill="#7dd3fc"/>`,
    face: `<ellipse cx="50" cy="57" rx="2.4" ry="1.6" fill="#e5737f"/>`,
  },
  rabbit: {
    fur: '#f4f4f4',
    belly: '#ffffff',
    ears: `<ellipse cx="39" cy="14" rx="7" ry="18" fill="#f4f4f4" ${EDGE}/><ellipse cx="61" cy="14" rx="7" ry="18" fill="#f4f4f4" ${EDGE}/>
<ellipse cx="39" cy="15" rx="3.5" ry="13" fill="#ffc8d6"/><ellipse cx="61" cy="15" rx="3.5" ry="13" fill="#ffc8d6"/>`,
    face: `<path d="M48 55 h4 l-2 2.5 z" fill="#e5737f"/>`,
  },
}

/** One pet, drawn in its 100×100 cell; `i` staggers the hop so neighbours are out of step. */
export function petSvg(m: Mascot, i = 0): string {
  const look = LOOKS[m.kind]
  const eyesY = m.kind === 'owl' ? 47 : 49
  const eyes = m.asleep
    ? `<path d="M36 ${eyesY} q4 3 8 0 M56 ${eyesY} q4 3 8 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    : [40, 60]
        .map(
          x => `<ellipse cx="${x}" cy="${eyesY}" rx="${m.kind === 'owl' ? 5 : 3.6}" ry="${m.kind === 'owl' ? 5 : 4}" fill="${m.kind === 'panda' ? '#fafafa' : INK}">
<animate attributeName="ry" values="4;4;0.4;4" keyTimes="0;0.92;0.96;1" dur="${3 + (i % 3) * 0.7}s" repeatCount="indefinite"/></ellipse>
<circle cx="${x + 1.3}" cy="${eyesY - 1.5}" r="1.2" fill="${m.kind === 'panda' ? INK : '#fff'}"/>`,
        )
        .join('')
  const mouth =
    m.kind === 'chick' || m.kind === 'penguin' || m.kind === 'owl' || m.kind === 'dog'
      ? ''
      : `<path d="M46 59 q2 2.4 4 0 q2 2.4 4 0" stroke="${INK}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`
  const cheeks = `<ellipse cx="33" cy="58" rx="4.5" ry="3" fill="${CHEEK}" opacity=".45"/><ellipse cx="67" cy="58" rx="4.5" ry="3" fill="${CHEEK}" opacity=".45"/>`
  const feet =
    m.kind === 'chick' || m.kind === 'penguin' || m.kind === 'owl'
      ? `<path d="M41 96 l-3 3 M41 96 l0 3.5 M59 96 l3 3 M59 96 l0 3.5" stroke="#ff8c1a" stroke-width="1.8" stroke-linecap="round"/>`
      : `<ellipse cx="40" cy="96" rx="7" ry="3.5" fill="${look.fur}" ${EDGE}/><ellipse cx="60" cy="96" rx="7" ry="3.5" fill="${look.fur}" ${EDGE}/>`
  const arms =
    m.kind === 'panda'
      ? `<ellipse cx="29" cy="80" rx="6" ry="10" fill="#2b2b2b"/><ellipse cx="71" cy="80" rx="6" ry="10" fill="#2b2b2b"/>`
      : m.kind === 'chick' || m.kind === 'penguin' || m.kind === 'owl'
        ? `<ellipse cx="27" cy="80" rx="5" ry="10" fill="${look.fur}" ${EDGE} transform="rotate(15 27 80)"/><ellipse cx="73" cy="80" rx="5" ry="10" fill="${look.fur}" ${EDGE} transform="rotate(-15 73 80)"/>`
        : ''
  const pet = `${look.ears}
<ellipse cx="50" cy="80" rx="24" ry="17" fill="${look.fur}" ${EDGE}/>
<ellipse cx="50" cy="83" rx="14" ry="11" fill="${look.belly}"/>
${arms}${feet}
<circle cx="50" cy="48" r="26" fill="${look.fur}" ${EDGE}/>
${look.face}${cheeks}${eyes}${mouth}`
  const motion = m.asleep
    ? `<animateTransform attributeName="transform" type="scale" additive="sum" values="1 1;1.015 0.985;1 1" dur="3s" repeatCount="indefinite"/>`
    : `<animateTransform attributeName="transform" type="translate" values="0 0;0 -5;0 0" dur="0.7s" begin="${(i * 0.23).toFixed(2)}s" repeatCount="indefinite"/>`
  const z = m.asleep
    ? [0, 1, 2]
        .map(
          k => `<text x="78" y="30" font-family="sans-serif" font-weight="700" font-size="${10 + k * 3}" fill="#7dd3fc" opacity="0">Z
<animate attributeName="opacity" values="0;1;0" dur="3s" begin="${k}s" repeatCount="indefinite"/>
<animateTransform attributeName="transform" type="translate" values="0 0;8 -18" dur="3s" begin="${k}s" repeatCount="indefinite"/></text>`,
        )
        .join('')
    : ''
  return `<ellipse cx="50" cy="99" rx="26" ry="3" fill="#000" opacity=".15"/><g>${motion}${pet}</g>${z}`
}

/** Columns for `n` cells in a `w`×`h` box: the count that gives the biggest square cell. */
export function bestGrid(n: number, w: number, h: number): { cols: number; cell: number } {
  let best = { cols: 1, cell: 0 }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cell = Math.min(w / cols, h / rows)
    if (cell > best.cell) best = { cols, cell }
  }
  return best
}

/**
 * All the pets in one SVG `w`×`h` px: each as big as the box allows (up to `maxCell`), on as many
 * rows as gives them the most room, rows centred. Smaller than `minCell` each: the first that
 * fit and a `+N` badge for the rest.
 */
export function sceneSvg(pets: readonly Mascot[], w: number, h: number, maxCell = 240, minCell = 44): string {
  let shown = [...pets]
  let { cols, cell } = bestGrid(shown.length, w, h)
  let more = 0
  while (cell < minCell && shown.length > 1) {
    shown = shown.slice(0, -1)
    more = pets.length - shown.length
    ;({ cols, cell } = bestGrid(shown.length + 1, w, h))
  }
  cell = Math.min(cell, maxCell)
  const count = shown.length + (more ? 1 : 0)
  const rows = Math.ceil(count / cols)
  const top = (h - rows * cell) / 2
  const parts: string[] = []
  for (let k = 0; k < count; k++) {
    const r = Math.floor(k / cols)
    const inRow = Math.min(cols, count - r * cols)
    const left = (w - inRow * cell) / 2
    const x = left + (k % cols) * cell
    const y = top + r * cell
    const s = cell / 100
    const body =
      k < shown.length
        ? petSvg(shown[k]!, k)
        : `<text x="50" y="58" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="#9aa0a6">+${more}</text>`
    parts.push(`<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s.toFixed(3)})">${body}</g>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`
}
