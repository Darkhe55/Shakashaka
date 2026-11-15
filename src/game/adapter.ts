/**
 * ════════════════════════════════════════════════════════════════════
 *  留方（Shakashaka）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 规则：
 *   1. 棋盘有黑格（题面给定）和白格；
 *   2. 在白格中放黑色直角三角形（左上/右上/左下/右下）或留空；
 *   3. 所有未放三角形的白格必须连成矩形区域（每个四连通白区都是矩形）；
 *   4. 黑格上的数字 = 其上下左右四个相邻格中的三角形数量；
 *   5. 题目唯一解。
 */

import { cellCenter } from '../core/board.ts'
import { playDrop, playPluck } from '../core/audio.ts'
import type {
  BoardMetrics,
  CustomSupport,
  GameAdapter,
  GameState,
  KeyContext,
  Move,
  Puzzle,
  SolveResult,
  ValidationResult,
} from '../core/types'
import { planLogicSolve } from './logic.ts'
import { builtinPuzzles, getReferenceSolution } from './puzzles.ts'
import { focusFirstCell, hitTest, metricsFor, moveCursor, normalizeCursor, renderBoard } from './render.ts'
import { solvePuzzle } from './solver.ts'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state.ts'
import { statusBits, validate } from './validate.ts'
import {
  BLACK_CLUE_BASE,
  decodeBoard,
  encodeBoard,
  NONE,
  ORIENTATION_LABELS,
  type Orientation,
  type ShakaPuzzle,
  type ShakaState,
} from './types.ts'

/* ── 1. 元信息 ── */

const meta = {
  title: '留方（Shakashaka）',
  tagline: '把白格切成矩形，用黑三角做墙 —— 越留白，越见方',
  footerNote:
    '规则：在白格中放黑色直角三角形或留空；所有未放三角形的白格必须连成矩形；黑格数字表示其上下左右四格中三角形的数量。每个白格的四连通区域都必须是一个完整的矩形。',
  storageKeyPrefix: 'shakashaka',
  customIdPrefix: 'shakashaka-custom-',
  customMinW: 4,
  customMinH: 4,
  customMaxW: 20,
  customMaxH: 20,
  targetKind: 'cell' as const,
  interactionHint:
    '<kbd>左键</kbd> 循环 空 → 左上 → 右上 → 左下 → 右下 · <kbd>右键</kbd> 清除',
}

/* ── 2. 自定义题板 ── */

/**
 * 编辑器单格取值：
 *   null = 白格
 *   1    = 黑格（无数字）
 *   2..6 = 黑格，数字 0..4
 */
const VALUE_CYCLE: Array<number | null> = [null, 1, 2, 3, 4, 5, 6]

const custom: CustomSupport = {
  mode: 'cell',
  valueCycle: VALUE_CYCLE,

  keyForDigit: (digit) => {
    if (digit === 0) return null // 白格
    if (digit >= 1 && digit <= 4) return BLACK_CLUE_BASE + digit // 黑格 + 数字 1..4
    if (digit === 5) return 1 // 黑格无数字
    return undefined
  },

  cellLabel: (v) => {
    if (v == null) return ''
    if (v === 1) return '■'
    return String(v - BLACK_CLUE_BASE)
  },

  cellClass: (v) => {
    if (v == null) return ''
    return v === 1 ? 'sh-ed-black' : 'sh-ed-clue'
  },

  hint:
    '点击循环：空 → 黑(■) → 黑0 → 黑1 → 黑2 → 黑3 → 黑4；数字键 0 = 白格，1–4 = 黑格带同数数字，5 = 黑格无数字，. / 退格清空。建议不超过 20×20。载入后点「求解」可校验是否恰好一解。',

  toGrid: (p) => {
    const board = (p as ShakaPuzzle).board
    if (!Array.isArray(board) || board.length !== p.width * p.height) return null
    return {
      width: p.width,
      height: p.height,
      grid: board.map((v) => (v === 0 ? null : v)),
    }
  },

  makePuzzle: (w, h, grid, existingId) => ({
    id: existingId ?? `${meta.customIdPrefix}${w}x${h}-${Date.now()}`,
    name: `自定义 · ${w}×${h}`,
    width: w,
    height: h,
    difficulty: 'custom',
    board: grid.map((v) => (v == null || v === 0 ? 0 : v)),
  }),

  encodePuzzle: (p) => ({
    board: encodeBoard((p as ShakaPuzzle).board ?? []),
  }),

  decodePuzzle: (record) => {
    if (typeof record.id !== 'string') return null
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return null
    const w = record.width
    const h = record.height
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
    if (w > meta.customMaxW || h > meta.customMaxH) return null
    const size = w * h
    if (typeof record.board !== 'string') return null
    const board = decodeBoard(record.board, size)
    if (!board) return null
    return {
      id: record.id,
      name:
        typeof record.name === 'string'
          ? record.name
          : `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      board,
    }
  },
}

/* ── 3. 键盘操作 ── */

function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function isCustomEditorOpen(): boolean {
  const panel = document.getElementById('custom-editor')
  return !!panel && !panel.hidden
}

function onKey(e: KeyboardEvent, ctx: KeyContext): boolean {
  if (!ctx.state || !ctx.puzzle) return false
  if (ctx.busy()) return false
  if (isCustomEditorOpen()) return false
  if (isTextInput(e.target)) return false
  if (e.ctrlKey || e.metaKey || e.altKey) return false

  const puzzle = ctx.puzzle
  const state = ctx.state as ShakaState
  const key = e.key

  const isArrow =
    key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
  if (isArrow) {
    const index = focusFirstCell(puzzle)
    if (index < 0) return false
    const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
    const dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
    if (moveCursor(puzzle, dx, dy)) ctx.redraw()
    e.preventDefault()
    return true
  }

  const index = normalizeCursor(puzzle)
  if (index < 0) return false
  const from = state.cells[index] ?? NONE
  let to = from
  let handled = false

  if (key === ' ' || key === 'Spacebar') {
    to = (from + 1) % 5
    handled = true
  } else if (key >= '1' && key <= '4') {
    to = Number(key)
    handled = true
  } else if (key === '0' || key === 'Backspace' || key === 'Delete') {
    to = NONE
    handled = true
  }
  if (!handled) return false

  e.preventDefault()
  if (to !== from) {
    ctx.commit({ index, from, to })
    const row = ((index / state.width) | 0) + 1
    const col = (index % state.width) + 1
    const label = ORIENTATION_LABELS[to as Orientation] ?? '空'
    ctx.setStatus(
      to === NONE
        ? `已清除（第 ${row} 行第 ${col} 列）。`
        : `已放置「${label}」三角形（第 ${row} 行第 ${col} 列）。`,
      'ok',
    )
  }
  return true
}

/* ── 4. 音效与特效 ── */

function playForMove(move: Move, streak: number): void {
  if (move.to === NONE) playDrop(streak)
  else playPluck(streak, move.to === 1 || move.to === 4 ? 1.15 : 0.95)
}

function flashForMove(
  svg: SVGSVGElement,
  move: Move,
  streak: number,
  m: BoardMetrics,
): void {
  const NS = 'http://www.w3.org/2000/svg'
  const center = cellCenter(m, move.index)
  if (move.to !== NONE) {
    const el = svg.querySelector<SVGElement>(`[data-index="${move.index}"]`)
    if (el) {
      el.classList.add('sh-fx-glow')
      const anim = el.animate(
        [
          { transform: 'scale(1)' },
          { transform: `scale(${1 + 0.12 / Math.sqrt(streak)})` },
          { transform: 'scale(1)' },
        ],
        { duration: 520, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' },
      )
      anim.onfinish = () => el.classList.remove('sh-fx-glow')
      anim.oncancel = () => el.classList.remove('sh-fx-glow')
      return
    }
  }
  for (let k = 0; k < 2; k++) {
    setTimeout(() => {
      const ring = document.createElementNS(NS, 'circle')
      ring.setAttribute('class', 'fx-ripple')
      ring.setAttribute('cx', String(center.x))
      ring.setAttribute('cy', String(center.y))
      ring.setAttribute('r', '4')
      svg.appendChild(ring)
      const anim = ring.animate(
        [
          { r: 4, opacity: 0.9, strokeWidth: 4 },
          { r: 24, opacity: 0.3, strokeWidth: 2 },
          { r: 40, opacity: 0, strokeWidth: 1 },
        ],
        {
          duration: 520 / Math.sqrt(streak),
          easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
          fill: 'forwards',
        },
      )
      anim.onfinish = () => ring.remove()
      anim.oncancel = () => ring.remove()
    }, k * (110 / streak))
  }
}

/* ── 5. 组装导出 ── */

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  serializeState,
  deserializeState,
  validate: (state: GameState, puzzle: Puzzle): ValidationResult => validate(state, puzzle),
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solvePuzzle(puzzle, maxNodes),
  firstHintMove,
  custom,
  onKey,
  playForMove,
  flashForMove,
}

/** 供测试/调试使用 */
export { planLogicSolve, solvePuzzle, validate }
export type { ShakaPuzzle, ShakaState }
