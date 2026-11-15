/**
 * 留方（Shakashaka）—— 题库生成器
 *
 * 思路：随机黑格布局 → 求出一组解 → 由解反推黑格数字 → 校验「恰好一解 + 纯规则可推完」
 * → 再贪心地把多余黑格恢复成白格（同时保持唯一解与可逻辑推演），让盘面更疏朗。
 *
 * 被 scripts/gen-config.mjs 调用（Node 24 原生 import .ts）。
 * 生成结果写入 src/game/puzzles-data.ts。
 */

import { cellsFromDomains, rulesFixpoint } from './logic.ts'
import { countSolutions, findSolution } from './solver.ts'
import { makeState } from './state.ts'
import {
  blackWithClue,
  encodeBoard,
  encodeCells,
  isBlack,
  NONE,
  type ShakaPuzzle,
} from './types.ts'
import { validate } from './validate.ts'

export interface RawPuzzleEntry {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  board: string
  solution: string
}

/* ────────────────────────── 随机数 ────────────────────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ────────────────────────── 工具 ────────────────────────── */

export interface Candidate {
  board: number[]
  solution: number[]
}

const SOLVE_NODES = 80_000
const COUNT_NODES = 80_000

function tempPuzzle(board: number[], w: number, h: number): ShakaPuzzle {
  return { id: 'tmp', name: 'tmp', width: w, height: h, difficulty: 'medium', board }
}

/** 由解反推所有黑格数字 */
function rebuildClues(board: number[], solution: number[], w: number, h: number): void {
  const size = w * h
  for (let i = 0; i < size; i++) {
    if (!isBlack(board[i]!)) continue
    const x = i % w
    const y = (i / w) | 0
    let count = 0
    if (x > 0 && solution[i - 1] !== NONE) count++
    if (x + 1 < w && solution[i + 1] !== NONE) count++
    if (y > 0 && solution[i - w] !== NONE) count++
    if (y + 1 < h && solution[i + w] !== NONE) count++
    board[i] = blackWithClue(count)
  }
}

function randomBlack(rng: () => number, w: number, h: number, prob: number): number[] {
  const board = new Array<number>(w * h).fill(0)
  for (let i = 0; i < board.length; i++) if (rng() < prob) board[i] = 1
  return board
}

/** 解是否通过校验（只关心三角形图案，朝向无关） */
function solutionValid(puzzle: ShakaPuzzle, solution: number[]): boolean {
  return validate(makeState(puzzle, solution), puzzle).solved
}

/** 纯规则推演能否完整得到这组解 */
function logicMatches(puzzle: ShakaPuzzle, solution: number[], w: number, h: number): boolean {
  const fx = rulesFixpoint(puzzle, 4000, 30)
  if (!fx.ok) return false
  const deduced = cellsFromDomains(fx.dom, w)
  if (!validate(makeState(puzzle, deduced), puzzle).solved) return false
  for (let i = 0; i < w * h; i++) {
    if ((deduced[i] !== NONE) !== (solution[i] !== NONE)) return false
  }
  return true
}

function isUniquePuzzle(puzzle: ShakaPuzzle): boolean {
  const counted = countSolutions(puzzle, 2, COUNT_NODES)
  return !counted.timedOut && counted.count === 1
}

function emptyStateSolved(puzzle: ShakaPuzzle): boolean {
  return validate(makeState(puzzle, new Array<number>(puzzle.width * puzzle.height).fill(NONE)), puzzle)
    .solved
}

/* ────────────────────────── 生成 + 精简 ────────────────────────── */

interface Config {
  w: number
  h: number
  difficulty: 'easy' | 'medium' | 'hard'
  series: string
  name: string
  blackProb: number
  minTriangles: number
  minBlack: number
}

/**
 * 贪心精简：把黑格一个个变回白格（解里该格本来就留空），
 * 只要解仍合法、仍唯一、仍可纯逻辑推完就保留。
 */
function minimizeBlack(
  rng: () => number,
  puzzle: ShakaPuzzle,
  solution: number[],
  w: number,
  h: number,
): Candidate | null {
  const board = puzzle.board.slice()
  const blackIndexes: number[] = []
  for (let i = 0; i < board.length; i++) if (isBlack(board[i]!)) blackIndexes.push(i)
  for (let i = blackIndexes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = blackIndexes[i]!
    blackIndexes[i] = blackIndexes[j]!
    blackIndexes[j] = t
  }

  for (const i of blackIndexes) {
    if (board[i] === 0) continue
    const trialBoard = board.slice()
    trialBoard[i] = 0
    const trial = tempPuzzle(trialBoard, w, h)
    if (!solutionValid(trial, solution)) continue
    if (emptyStateSolved(trial)) continue
    if (!isUniquePuzzle(trial)) continue
    if (!logicMatches(trial, solution, w, h)) continue
    board[i] = 0
  }

  const finalPuzzle = tempPuzzle(board, w, h)
  if (!solutionValid(finalPuzzle, solution)) return null
  if (!isUniquePuzzle(finalPuzzle)) return null
  if (!logicMatches(finalPuzzle, solution, w, h)) return null
  return { board, solution }
}

function tryGenerate(rng: () => number, cfg: Config): Candidate | null {
  const { w, h } = cfg
  for (let attempt = 0; attempt < 400; attempt++) {
    const prob = cfg.blackProb + (rng() - 0.5) * 0.1
    const board = randomBlack(rng, w, h, prob)
    let blackCount = 0
    for (const v of board) if (v !== 0) blackCount++
    if (blackCount < cfg.minBlack) continue

    const base = tempPuzzle(board, w, h)
    const found = findSolution(base, SOLVE_NODES, rng)
    if (!found.solution) continue
    const triangles = found.solution.filter((v) => v !== NONE).length
    if (triangles < cfg.minTriangles) continue

    rebuildClues(board, found.solution, w, h)
    const puzzle = tempPuzzle(board, w, h)
    if (emptyStateSolved(puzzle)) continue
    if (!isUniquePuzzle(puzzle)) continue
    if (!logicMatches(puzzle, found.solution, w, h)) continue

    const minimized = minimizeBlack(rng, puzzle, found.solution, w, h)
    if (!minimized) continue
    return minimized
  }
  return null
}

/* ────────────────────────── 生成入口 ────────────────────────── */

const CONFIGS: Config[] = [
  {
    w: 6,
    h: 6,
    difficulty: 'easy',
    series: '入门',
    name: '初见留白',
    blackProb: 0.5,
    minTriangles: 7,
    minBlack: 10,
  },
  {
    w: 6,
    h: 6,
    difficulty: 'easy',
    series: '入门',
    name: '方寸之间',
    blackProb: 0.52,
    minTriangles: 8,
    minBlack: 10,
  },
  {
    w: 7,
    h: 7,
    difficulty: 'medium',
    series: '进阶',
    name: '折角回廊',
    blackProb: 0.5,
    minTriangles: 9,
    minBlack: 12,
  },
  {
    w: 8,
    h: 8,
    difficulty: 'medium',
    series: '进阶',
    name: '白墙花窗',
    blackProb: 0.5,
    minTriangles: 10,
    minBlack: 14,
  },
  {
    w: 8,
    h: 8,
    difficulty: 'hard',
    series: '挑战',
    name: '庭院深深',
    blackProb: 0.52,
    minTriangles: 12,
    minBlack: 16,
  },
  {
    w: 9,
    h: 9,
    difficulty: 'hard',
    series: '挑战',
    name: '光影交错',
    blackProb: 0.52,
    minTriangles: 14,
    minBlack: 18,
  },
]

export function generatePuzzles(): RawPuzzleEntry[] {
  const rng = mulberry32(20261115)
  const out: RawPuzzleEntry[] = []
  const serialBySize = new Map<string, number>()

  for (const cfg of CONFIGS) {
    const t0 = performance.now()
    const found = tryGenerate(rng, cfg)
    if (!found) {
      console.warn(`[gen] ${cfg.w}x${cfg.h}「${cfg.name}」生成失败，请调整参数`)
      continue
    }
    const black = found.board.filter((v) => v !== 0).length
    const clues = found.board.filter((v) => v >= 2).length
    const triangles = found.solution.filter((v) => v !== NONE).length
    const sizeKey = `${cfg.w}x${cfg.h}`
    const serial = (serialBySize.get(sizeKey) ?? 0) + 1
    serialBySize.set(sizeKey, serial)
    const entry: RawPuzzleEntry = {
      id: `shakashaka-${cfg.w}x${cfg.h}-${String(serial).padStart(2, '0')}`,
      name: cfg.name,
      width: cfg.w,
      height: cfg.h,
      difficulty: cfg.difficulty,
      series: cfg.series,
      board: encodeBoard(found.board),
      solution: encodeCells(found.board, found.solution),
    }
    out.push(entry)
    console.log(
      `[gen] ${cfg.w}x${cfg.h}「${cfg.name}」黑格 ${black}（数字 ${clues}）· 三角形 ${triangles} · ${Math.round(performance.now() - t0)}ms`,
    )
  }
  return out
}

/* ────────────────────────── 调试辅助 ────────────────────────── */

/** 生成一道题（不写文件，供调试用） */
export function generateOne(
  w: number,
  h: number,
  seed = 1,
  blackProb = 0.5,
): RawPuzzleEntry | null {
  const rng = mulberry32(seed)
  const found = tryGenerate(rng, {
    w,
    h,
    difficulty: 'medium',
    series: 'debug',
    name: 'debug',
    blackProb,
    minTriangles: 6,
    minBlack: 8,
  })
  if (!found) return null
  return {
    id: `shakashaka-${w}x${h}-debug`,
    name: 'debug',
    width: w,
    height: h,
    difficulty: 'medium',
    series: 'debug',
    board: encodeBoard(found.board),
    solution: encodeCells(found.board, found.solution),
  }
}

/** 生成流程统计（调试用） */
export interface GenStats {
  attempts: number
  solved: number
  unique: number
  logic: number
  accepted: number
}

export function generateStats(
  w: number,
  h: number,
  seed = 1,
  attempts = 120,
  blackProb = 0.5,
): GenStats {
  const rng = mulberry32(seed)
  const stats: GenStats = { attempts, solved: 0, unique: 0, logic: 0, accepted: 0 }
  for (let k = 0; k < attempts; k++) {
    const board = randomBlack(rng, w, h, blackProb)
    const base = tempPuzzle(board, w, h)
    const found = findSolution(base, SOLVE_NODES, rng)
    if (!found.solution) continue
    stats.solved++
    rebuildClues(board, found.solution, w, h)
    const puzzle = tempPuzzle(board, w, h)
    if (!isUniquePuzzle(puzzle)) continue
    stats.unique++
    if (!logicMatches(puzzle, found.solution, w, h)) continue
    stats.logic++
    const min = minimizeBlack(rng, puzzle, found.solution, w, h)
    if (min) stats.accepted++
  }
  return stats
}
