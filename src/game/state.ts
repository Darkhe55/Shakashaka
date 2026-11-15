/**
 * 留方（Shakashaka）—— 棋盘状态与交互值
 *
 * 状态里保存 cells（三角形朝向 0..4）以及题面 board 的只读副本，
 * 这样核心层在只有 state 的场合（左键循环 / 右键 / 校验）也能识别黑格。
 */

import type { GameState, HitTarget, Move, Puzzle } from '../core/types'
import {
  asPuzzle,
  BLACK_CLUE_BASE,
  decodeBoard,
  decodeCells,
  encodeBoard,
  encodeCells,
  isBlack,
  NONE,
  type ShakaState,
} from './types.ts'

export function makeState(puzzle: Puzzle, cells: ArrayLike<number>): ShakaState {
  const p = asPuzzle(puzzle)
  const size = p.width * p.height
  const out = new Array<number>(size).fill(NONE)
  const board = p.board.slice()
  for (let i = 0; i < size; i++) {
    if (isBlack(board[i]!)) out[i] = NONE
    else out[i] = normalizeValue(cells[i] ?? NONE)
  }
  return {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    cells: out,
    board,
  }
}

export function createEmptyState(puzzle: Puzzle): ShakaState {
  const p = asPuzzle(puzzle)
  return {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    cells: new Array<number>(p.width * p.height).fill(NONE),
    board: p.board.slice(),
  }
}

export function cloneState(state: GameState): ShakaState {
  const s = state as ShakaState
  return {
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    cells: s.cells.slice(),
    board: s.board.slice(),
  }
}

function normalizeValue(v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 4) return NONE
  return v
}

/** 黑格不可填；白格 0→1→2→3→4→0 */
export function cycleValue(state: GameState, target: HitTarget): number {
  const s = state as ShakaState
  const i = target.index
  if (i < 0 || i >= s.cells.length) return NONE
  if (isBlack(s.board[i]!)) return NONE
  return ((s.cells[i]! + 1) % 5) as number
}

/** 右键：清除该格三角形 */
export function rightClickValue(_state: GameState, _target: HitTarget): number {
  return NONE
}

export function applyMove(state: GameState, move: Move): void {
  const s = state as ShakaState
  const i = move.index
  if (i < 0 || i >= s.cells.length) return
  if (isBlack(s.board[i]!)) return
  s.cells[i] = normalizeValue(move.to)
}

export function invertMove(move: Move): Move {
  return { index: move.index, from: move.to, to: move.from }
}

export function valueAt(state: GameState, index: number): number {
  const s = state as ShakaState
  return s.cells[index] ?? NONE
}

/* ────────────────────────── 存档 ────────────────────────── */

export function serializeState(state: GameState): Record<string, unknown> {
  const s = state as ShakaState
  return {
    version: 1,
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    board: encodeBoard(s.board),
    cells: encodeCells(s.board, s.cells),
  }
}

export function deserializeState(data: Record<string, unknown>): ShakaState | null {
  if (typeof data.puzzleId !== 'string') return null
  if (typeof data.width !== 'number' || typeof data.height !== 'number') return null
  const w = data.width
  const h = data.height
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
  const size = w * h
  if (size > 20 * 20) return null

  const board = typeof data.board === 'string' ? decodeBoard(data.board, size) : null
  if (!board) return null
  const cells =
    typeof data.cells === 'string' ? decodeCells(data.cells, board, size) : null
  if (!cells) return null
  return { puzzleId: data.puzzleId, width: w, height: h, cells, board }
}

/* ────────────────────────── 提示 ────────────────────────── */

/** 找到第一个「当前还不是三角形、但参考解要求放三角形」的格 */
export function firstHintMove(state: GameState, solution: GameState): Move | null {
  const s = state as ShakaState
  const sol = solution as ShakaState
  const size = Math.min(s.cells.length, sol.cells.length)
  for (let i = 0; i < size; i++) {
    if (isBlack(s.board[i]!)) continue
    const want = (sol.cells[i] ?? NONE) !== NONE
    const cur = (s.cells[i] ?? NONE) !== NONE
    if (want && !cur) {
      return { index: i, from: NONE, to: sol.cells[i] ?? 1 }
    }
  }
  // 没有待放三角形可提示时，退而求其次：清掉多放的三角形
  for (let i = 0; i < size; i++) {
    if (isBlack(s.board[i]!)) continue
    const want = (sol.cells[i] ?? NONE) !== NONE
    const cur = (s.cells[i] ?? NONE) !== NONE
    if (cur && !want) return { index: i, from: s.cells[i]!, to: NONE }
  }
  return null
}

/* ────────────────────────── 自定义题板辅助 ────────────────────────── */

/** 把编辑器网格（null / 0..6）转换为题面 board */
export function boardFromEditorGrid(grid: Array<number | null>): number[] {
  return grid.map((v) => {
    if (v == null || v === 0) return 0
    if (!Number.isInteger(v) || v < 1 || v > 6) return BLACK_CLUE_BASE // 兜底：黑格数字 0
    return v
  })
}
