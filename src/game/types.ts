/**
 * 留方（Shakashaka）—— 游戏专用类型与编码
 *
 * 棋盘单元格分两种：
 *   白格：玩家可以在其中放一个黑色直角三角形，或留空；
 *   黑格：题面给定，不参与放置，可以带 0–4 的数字。
 *
 * 状态里只记录三角形朝向：
 *   0 = 白格留空（或黑格）
 *   1 = 左上朝向（直角在左上角）
 *   2 = 右上朝向
 *   3 = 左下朝向
 *   4 = 右下朝向
 *
 * 题面 board 每格的内部编码：
 *   0 = 白格
 *   1 = 黑格（无数字）
 *   2..6 = 黑格，数字分别为 0..4（值 - 2）
 * 这套编码与自定义题板编辑器的取值一致，方便复用 core/custom。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'

/* ── 朝向 ── */

export const NONE = 0
/** 左上：直角在格子左上角，斜边从左下到右上 */
export const NW = 1
/** 右上：直角在右上角 */
export const NE = 2
/** 左下：直角在左下角 */
export const SW = 3
/** 右下：直角在右下角 */
export const SE = 4

export type Orientation = 0 | 1 | 2 | 3 | 4

export const ORIENTATION_LABELS: Record<Orientation, string> = {
  0: '空',
  1: '左上',
  2: '右上',
  3: '左下',
  4: '右下',
}

/* ── 题面格值 ── */

export const WHITE = 0
export const BLACK = 1
/** 带数字的黑格：2 → 数字 0，3 → 数字 1，…… 6 → 数字 4 */
export const BLACK_CLUE_BASE = 2

export function isBlack(v: number): boolean {
  return v !== WHITE
}

/** 黑格数字；无数字返回 -1 */
export function clueOf(v: number): number {
  return v >= BLACK_CLUE_BASE ? v - BLACK_CLUE_BASE : -1
}

/** 数字 → 题面格值；clue < 0 表示无数字黑格 */
export function blackWithClue(clue: number): number {
  return clue < 0 ? BLACK : BLACK_CLUE_BASE + clue
}

/** 题面格值 → 编辑器的 cell 值（白格 = null） */
export function boardToEditorValue(v: number): number | null {
  return v === WHITE ? null : v
}

/** 编辑器 cell 值 → 题面格值 */
export function editorValueToBoard(v: number | null): number {
  return v == null || v === WHITE ? WHITE : v
}

/* ── 题面 / 状态 ── */

export interface ShakaPuzzle extends Puzzle {
  /** 每格题面：0 白格；1 黑格；2..6 黑格带数字 0..4 */
  board: number[]
  /** 参考解（内置题携带）：每格三角形朝向 0..4，黑格为 0 */
  solution?: number[]
}

export interface ShakaState extends GameState {
  /** 每格三角形朝向 0..4；黑格固定为 0 */
  cells: number[]
  /** 题面 board 的只读副本（让只有 state 的场合也能识别黑格） */
  board: number[]
}

export function asPuzzle(p: Puzzle): ShakaPuzzle {
  return p as ShakaPuzzle
}

export function asState(s: GameState): ShakaState {
  return s as ShakaState
}

/* ── 校验结果 ── */

export interface RegionIssue {
  /** 该连通白区包含的格子 */
  cells: number[]
  /** 格子数 */
  size: number
  /** 外接矩形面积 */
  bboxArea: number
  /** 为什么不是矩形 */
  kind: 'not-rect' | 'outside'
}

export interface ShakaResult extends ValidationResult {
  /** 已放置的三角形数量 */
  triangleCount: number
  /** 白区（未放三角形的白格连通块）数量 */
  regionCount: number
  /** 不是矩形的白区数量 */
  badRegionCount: number
  /** 所有非矩形白区涉及的格 */
  badRegionCells: number[]
  /** 数字不符的黑格 */
  clueBad: number[]
  /** 数字格总数（含数字 0） */
  clueCount: number
  /** 盘面非法值 */
  invalidCells: number[]
  /** 需要高亮的全部格子 */
  badCells: number[]
}

/* ── 编码：题面 ── */

const BOARD_CHARS = new Set(['.', '#', '0', '1', '2', '3', '4'])

/** 题面编码：. 白格，# 黑格（无数字），0–4 黑格带数字 */
export function encodeBoard(board: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < board.length; i++) {
    const v = board[i]! | 0
    if (v === WHITE) out += '.'
    else if (v === BLACK) out += '#'
    else out += String(clueOf(v))
  }
  return out
}

/** 题面解码；长度或字符非法时返回 null */
export function decodeBoard(text: string, size: number): number[] | null {
  if (typeof text !== 'string' || text.length !== size) return null
  const out = new Array<number>(size)
  for (let i = 0; i < size; i++) {
    const ch = text[i]!
    if (!BOARD_CHARS.has(ch)) return null
    if (ch === '.') out[i] = WHITE
    else if (ch === '#') out[i] = BLACK
    else out[i] = BLACK_CLUE_BASE + Number(ch)
  }
  return out
}

/* ── 编码：盘面 ── */

/** 盘面编码：黑格 #，白格 0–4 */
export function encodeCells(board: ArrayLike<number>, cells: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < cells.length; i++) {
    out += isBlack(board[i] ?? WHITE) ? '#' : String((cells[i] ?? NONE) | 0)
  }
  return out
}

/** 盘面解码；黑格允许 # / . / x，白格只允许 0–4 */
export function decodeCells(
  text: string,
  board: ArrayLike<number>,
  size: number,
): number[] | null {
  if (typeof text !== 'string' || text.length !== size) return null
  const out = new Array<number>(size)
  for (let i = 0; i < size; i++) {
    const ch = text[i]!
    if (ch === '#' || ch === 'x' || ch === 'X' || ch === '.') {
      out[i] = NONE
      continue
    }
    if (ch < '0' || ch > '4') return null
    out[i] = Number(ch)
  }
  // 黑格不允许有三角形
  for (let i = 0; i < size; i++) {
    if (isBlack(board[i] ?? WHITE)) out[i] = NONE
  }
  return out
}

/** 题面各格数值是否合法（0..6） */
export function boardIsValid(board: ArrayLike<number>, size: number): boolean {
  if (board.length !== size) return false
  for (let i = 0; i < size; i++) {
    const v = board[i]!
    if (!Number.isInteger(v) || v < 0 || v > 6) return false
  }
  return true
}

/** 统计黑格数字总数（用于题库审计） */
export function clueTotal(board: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < board.length; i++) if (clueOf(board[i]!) >= 0) n++
  return n
}

/** 统计黑格数量 */
export function blackTotal(board: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < board.length; i++) if (isBlack(board[i]!)) n++
  return n
}
