/**
 * 留方（Shakashaka）—— SVG 渲染与命中
 *
 * 视觉层次：
 *   棋盘底 → 每格底色（黑格 / 白格）→ 留空白区着色（一眼看出矩形）
 *   → 三角形 → 数字 → 错误高亮 → 键盘光标 → 命中层
 */

import type { BoardMetrics, GameState, HitTarget, Puzzle, ValidationResult } from '../core/types'
import { cellAtPoint, regionFill, squareMetrics } from '../core/board.ts'
import {
  asPuzzle,
  asState,
  clueOf,
  isBlack,
  NONE,
  NW,
  NE,
  SW,
  SE,
  type ShakaResult,
} from './types.ts'

/* ────────────────────────── 度量 ────────────────────────── */

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  const n = Math.max(puzzle.width, puzzle.height)
  const cell = n <= 6 ? 64 : n <= 8 ? 54 : n <= 10 ? 48 : n <= 14 ? 40 : 34
  const pad = Math.round(cell * 0.5)
  return squareMetrics(puzzle.width, puzzle.height, { cell, pad })
}

/* ────────────────────────── 键盘光标（模块级共享） ────────────────────────── */

let cursorPuzzleId: string | null = null
let cursorIndex = -1

export function cursorFor(puzzle: Puzzle): number {
  return cursorPuzzleId === puzzle.id ? cursorIndex : -1
}

export function setCursor(puzzle: Puzzle, index: number): void {
  cursorPuzzleId = puzzle.id
  cursorIndex = index
}

/** 光标落在可用白格上；返回规范化后的下标（-1 表示没有白格） */
export function normalizeCursor(puzzle: Puzzle): number {
  const p = asPuzzle(puzzle)
  const size = p.width * p.height
  if (size <= 0) return -1
  if (cursorPuzzleId !== puzzle.id || cursorIndex < 0 || cursorIndex >= size) {
    cursorPuzzleId = puzzle.id
    cursorIndex = -1
    for (let i = 0; i < size; i++) {
      if (!isBlack(p.board[i]!)) {
        cursorIndex = i
        break
      }
    }
  }
  if (cursorIndex >= 0 && isBlack(p.board[cursorIndex]!)) {
    // 光标停在黑格上（题面改过）→ 找最近的可用白格
    let found = -1
    for (let i = 0; i < size; i++) {
      if (!isBlack(p.board[i]!)) {
        found = i
        break
      }
    }
    cursorIndex = found
  }
  return cursorIndex
}

/** 按方向移动光标（跳过黑格；越界保持不动），返回是否移动 */
export function moveCursor(puzzle: Puzzle, dx: number, dy: number): boolean {
  const p = asPuzzle(puzzle)
  const w = p.width
  const h = p.height
  const start = normalizeCursor(puzzle)
  if (start < 0) return false
  let x = start % w
  let y = (start / w) | 0
  for (;;) {
    x += dx
    y += dy
    if (x < 0 || y < 0 || x >= w || y >= h) return false
    const i = y * w + x
    if (!isBlack(p.board[i]!)) {
      cursorIndex = i
      return true
    }
  }
}

function firstWhite(puzzle: Puzzle): number {
  const p = asPuzzle(puzzle)
  if (p.board.length !== p.width * p.height) return -1
  for (let i = 0; i < p.board.length; i++) if (!isBlack(p.board[i]!)) return i
  return -1
}

/** 光标落到棋盘第一格（方向键第一次按下时用） */
export function focusFirstCell(puzzle: Puzzle): number {
  const cur = normalizeCursor(puzzle)
  if (cur >= 0) return cur
  const i = firstWhite(puzzle)
  setCursor(puzzle, i)
  return i
}

/* ────────────────────────── 渲染 ────────────────────────── */

const f = (n: number): string => (Math.round(n * 100) / 100).toFixed(2)

function trianglePoints(
  x: number,
  y: number,
  s: number,
  orientation: number,
): string {
  switch (orientation) {
    case NW:
      return `${f(x)} ${f(y)} ${f(x + s)} ${f(y)} ${f(x)} ${f(y + s)}`
    case NE:
      return `${f(x + s)} ${f(y)} ${f(x + s)} ${f(y + s)} ${f(x)} ${f(y)}`
    case SW:
      return `${f(x)} ${f(y)} ${f(x)} ${f(y + s)} ${f(x + s)} ${f(y + s)}`
    case SE:
      return `${f(x + s)} ${f(y)} ${f(x + s)} ${f(y + s)} ${f(x)} ${f(y + s)}`
    default:
      return ''
  }
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  _colorGrid?: unknown,
): string {
  const m = metricsFor(puzzle)
  const p = asPuzzle(puzzle)
  const s = asState(state)
  const r = result as ShakaResult
  const w = puzzle.width
  const h = puzzle.height
  const size = w * h
  const o = { x: m.originX ?? m.pad, y: m.originY ?? m.pad }
  const cw = m.cellW ?? m.cell
  const ch = m.cellH ?? m.cell
  const board = p.board

  const clueBad = new Set<number>(r.clueBad ?? [])
  const regionBad = new Set<number>(r.badRegionCells ?? [])
  const invalid = new Set<number>(r.invalidCells ?? [])
  // 刚开局时白区都还不是矩形、数字也都还没凑够，这是正常的「未完成」，不该满盘飘红。
  // 玩家开始放置三角形后才展示错误；非法值随时展示。
  const showMistake = (r.triangleCount ?? 0) > 0
  const cursor = cursorFor(p)

  // 留空白区的连通块编号（用于着色，让「矩形」一眼可见）
  const regionOf = new Int16Array(size).fill(-1)
  {
    let next = 0
    const stack: number[] = []
    for (let start = 0; start < size; start++) {
      if (regionOf[start] !== -1) continue
      if (isBlack(board[start]!) || (s.cells[start] ?? NONE) !== NONE) continue
      const id = next++
      regionOf[start] = id
      stack.push(start)
      while (stack.length) {
        const i = stack.pop()!
        const x = i % w
        const y = (i / w) | 0
        const tryPush = (j: number): void => {
          if (regionOf[j] !== -1) return
          if (isBlack(board[j]!) || (s.cells[j] ?? NONE) !== NONE) return
          regionOf[j] = id
          stack.push(j)
        }
        if (x > 0) tryPush(i - 1)
        if (x + 1 < w) tryPush(i + 1)
        if (y > 0) tryPush(i - w)
        if (y + 1 < h) tryPush(i + w)
      }
    }
  }

  const parts: string[] = []
  parts.push(
    `<rect class="sh-board-bg" x="${f(o.x - 10)}" y="${f(o.y - 10)}" width="${f(w * cw + 20)}" height="${f(h * ch + 20)}" rx="${f(m.cell * 0.18)}" />`,
  )

  const gap = Math.max(0, m.cell * 0.02)
  const triInset = m.cell * 0.06
  const gridStroke = Math.max(0.8, m.cell * 0.022)

  for (let i = 0; i < size; i++) {
    const x = o.x + (i % w) * cw
    const y = o.y + ((i / w) | 0) * ch
    const v = board[i] ?? 0
    const black = isBlack(v)
    const clue = clueOf(v)
    const tri = black ? NONE : (s.cells[i] ?? NONE)
    const clueWrong = invalid.has(i) || (clueBad.has(i) && showMistake)
    const regionWrong = regionBad.has(i) && showMistake
    const bad = clueWrong || regionWrong
    const region = regionOf[i]

    let cls = 'sh-cell'
    if (black) cls += ' sh-black'
    else if (tri !== NONE) cls += ' sh-tri-cell'
    else cls += ' sh-empty'
    if (bad) cls += ' sh-bad'

    let fill = ''
    if (!black && tri === NONE) {
      if (region >= 0) {
        fill = regionWrong ? '#f7e2da' : regionFill(region)
      }
    }
    parts.push(
      `<rect class="${cls}" x="${f(x + gap)}" y="${f(y + gap)}" width="${f(cw - gap * 2)}" height="${f(ch - gap * 2)}"${fill ? ` style="fill:${fill}"` : ''} />`,
    )

    if (black) {
      if (clue >= 0) {
        const label = String(clue)
        const fs = (label.length > 1 ? m.cell * 0.3 : m.cell * 0.4).toFixed(2)
        const clueCls = clueBad.has(i) && showMistake ? ' sh-clue-bad' : ''
        parts.push(
          `<text class="sh-clue${clueCls}" x="${f(x + cw / 2)}" y="${f(y + ch / 2 + m.cell * 0.015)}" style="font-size:${fs}px">${label}</text>`,
        )
      }
    } else if (tri !== NONE) {
      const pts = trianglePoints(x + triInset, y + triInset, m.cell - triInset * 2, tri)
      parts.push(`<polygon class="sh-tri" data-index="${i}" points="${pts}" />`)
    }

    if (clueWrong) {
      parts.push(
        `<rect class="sh-error" x="${f(x + 1.5)}" y="${f(y + 1.5)}" width="${f(cw - 3)}" height="${f(ch - 3)}" rx="${f(m.cell * 0.08)}" />`,
      )
    } else if (regionWrong) {
      parts.push(
        `<rect class="sh-region-warn" x="${f(x + 1.5)}" y="${f(y + 1.5)}" width="${f(cw - 3)}" height="${f(ch - 3)}" rx="${f(m.cell * 0.08)}" />`,
      )
    }
    if (i === cursor) {
      parts.push(
        `<rect class="sh-cursor" x="${f(x + 2)}" y="${f(y + 2)}" width="${f(cw - 4)}" height="${f(ch - 4)}" rx="${f(m.cell * 0.08)}" />`,
      )
    }
  }

  // 网格线（统一描边，避免每格 stroke 叠加）
  const lines: string[] = []
  for (let x = 0; x <= w; x++) {
    lines.push(
      `<line x1="${f(o.x + x * cw)}" y1="${f(o.y)}" x2="${f(o.x + x * cw)}" y2="${f(o.y + h * ch)}" />`,
    )
  }
  for (let y = 0; y <= h; y++) {
    lines.push(
      `<line x1="${f(o.x)}" y1="${f(o.y + y * ch)}" x2="${f(o.x + w * cw)}" y2="${f(o.y + y * ch)}" />`,
    )
  }
  parts.push(
    `<g class="sh-grid" stroke-width="${f(gridStroke)}">${lines.join('')}</g>`,
  )

  parts.push(
    `<rect class="sh-frame" x="${f(o.x)}" y="${f(o.y)}" width="${f(w * cw)}" height="${f(h * ch)}" rx="${f(m.cell * 0.04)}" />`,
  )

  // 命中层：透明矩形覆盖每格
  for (let i = 0; i < size; i++) {
    const x = o.x + (i % w) * cw
    const y = o.y + ((i / w) | 0) * ch
    parts.push(
      `<rect class="cell-hit" data-index="${i}" x="${f(x)}" y="${f(y)}" width="${f(cw)}" height="${f(ch)}" />`,
    )
  }

  return `<svg class="board-svg sh-board" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${p.width}×${p.height} 留方棋盘">${parts.join('')}</svg>`
}

export function hitTest(
  m: BoardMetrics,
  _puzzle: Puzzle,
  x: number,
  y: number,
): HitTarget | null {
  const index = cellAtPoint(m, x, y)
  return index == null ? null : { index }
}
