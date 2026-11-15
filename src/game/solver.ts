/**
 * 留方（Shakashaka）—— 回溯求解器
 *
 * 注意：三角形朝向（左上/右上/左下/右下）不影响任何规则 ——
 * 数字只数「相邻有几个三角形」，矩形规则只看「哪些格留空」。
 * 因此唯一解指的是「三角形所在格子集合」唯一，求解器按
 *   留空 / 三角形（朝向待定）
 * 两种状态搜索，最后再给三角形补一个好看的朝向。
 *
 * 用 rules.ts 的域传播（数字约束 + 矩形约束）做前向剪枝，
 * 再对剩余不确定格做深度优先搜索。用于：
 *   - 显示解 / 提示一格（自定义题没有参考解时）
 *   - 自定义题板的「唯一解校验」（countSolutions 最多数到 2 组）
 *   - 题库审计（scripts/check.mjs）
 */

import type { Puzzle, SolveResult } from '../core/types'
import {
  EMPTY_BIT,
  TRI_BITS,
  initialDomains,
  neighborsFor,
  popcount,
  propagate,
} from './rules.ts'
import { makeState } from './state.ts'
import { asPuzzle, clueOf, isBlack, NONE, type ShakaState } from './types.ts'

/** 某个格子的朝向（按位置给一个固定但多样的朝向，仅影响观感） */
export function orientationFor(index: number, width: number): number {
  const x = index % width
  const y = (index / width) | 0
  return 1 + ((x + y * 2) % 4)
}

/** 域是否已「确定」：只可能是留空，或只可能是三角形 */
export function isDecided(dom: number): boolean {
  return dom === EMPTY_BIT || dom === TRI_BITS
}

function domainSolution(dom: Uint8Array, width: number): number[] {
  const out = new Array<number>(dom.length).fill(NONE)
  for (let i = 0; i < dom.length; i++) {
    const d = dom[i]!
    if (d === EMPTY_BIT) out[i] = NONE
    else if (d === TRI_BITS) out[i] = orientationFor(i, width)
  }
  return out
}

function allDecided(dom: Uint8Array): boolean {
  for (let i = 0; i < dom.length; i++) {
    const d = dom[i]!
    if (d && !isDecided(d)) return false
  }
  return true
}

export interface SearchOutcome {
  /** 每组解：三角形格为 NE 之类的非零朝向，留空为 0 */
  solutions: number[][]
  nodes: number
  timedOut: boolean
}

/**
 * 搜索最多 limit 组解（按三角形图案去重；朝向不参与计数）。
 * random 提供时用于打乱分支顺序（题库生成器用，保证结果多样）。
 */
export function searchSolutions(
  puzzle: Puzzle,
  limit: number,
  maxNodes = 600_000,
  random?: () => number,
): SearchOutcome {
  const p = asPuzzle(puzzle)
  const w = p.width
  const h = p.height
  const size = w * h
  const board = p.board
  const nb = neighborsFor(w, h)
  const dom = initialDomains(p)

  // 约束度：邻接的数字黑格越多越先决定
  const degree = new Int16Array(size)
  for (let i = 0; i < size; i++) {
    if (isBlack(board[i]!)) continue
    let d = 0
    for (const j of nb[i]!) if (clueOf(board[j]!) >= 0) d++
    degree[i] = d
  }

  const solutions: number[][] = []
  let nodes = 0
  let timedOut = false

  const dfs = (cur: Uint8Array): void => {
    if (solutions.length >= limit || timedOut) return
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return
    }
    if (!propagate(cur, p)) return

    let best = -1
    let bestCount = 6
    let bestDegree = -1
    for (let i = 0; i < size; i++) {
      if (isBlack(board[i]!)) continue
      const d = cur[i]!
      if (!d) return // 理论不可达
      if (d === EMPTY_BIT || d === TRI_BITS) continue
      const c = popcount(d)
      const deg = degree[i]!
      if (c < bestCount || (c === bestCount && deg > bestDegree)) {
        best = i
        bestCount = c
        bestDegree = deg
      }
    }

    if (best < 0) {
      if (allDecided(cur)) solutions.push(domainSolution(cur, w))
      return
    }

    let branches: number[] = [EMPTY_BIT, TRI_BITS].filter((mask) => (cur[best]! & mask) !== 0)
    if (random) {
      const r = random()
      if (r < 0.5) branches = branches.reverse()
    }
    for (const mask of branches) {
      if (solutions.length >= limit || timedOut) return
      const next = cur.slice()
      next[best] = mask
      dfs(next)
    }
  }

  dfs(dom)
  return { solutions, nodes, timedOut }
}

export interface CountOutcome {
  count: number
  solutions: number[][]
  nodes: number
  timedOut: boolean
}

/** 最多数到 limit 组解（默认 2，用于判断唯一性） */
export function countSolutions(puzzle: Puzzle, limit = 2, maxNodes = 600_000): CountOutcome {
  const out = searchSolutions(puzzle, limit, maxNodes)
  return {
    count: out.solutions.length,
    solutions: out.solutions,
    nodes: out.nodes,
    timedOut: out.timedOut,
  }
}

/** 找到一组解（题库生成与逻辑回放兜底用） */
export function findSolution(
  puzzle: Puzzle,
  maxNodes = 600_000,
  random?: () => number,
): { solution: number[] | null; nodes: number; timedOut: boolean } {
  const out = searchSolutions(puzzle, 1, maxNodes, random)
  return { solution: out.solutions[0] ?? null, nodes: out.nodes, timedOut: out.timedOut }
}

/** 纯传播能确定全部格时直接返回，否则搜索 */
export function solvePuzzle(puzzle: Puzzle, maxNodes = 1_500_000): SolveResult {
  const p = asPuzzle(puzzle)
  if (!p.board.length && p.width * p.height > 0) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }

  const dom = initialDomains(p)
  if (propagate(dom, p) && allDecided(dom)) {
    return {
      solved: true,
      solution: makeState(p, domainSolution(dom, p.width)),
      nodes: 0,
      timedOut: false,
      count: 1,
    }
  }

  const out = searchSolutions(p, 2, maxNodes)
  if (!out.solutions.length) {
    return {
      solved: false,
      solution: null,
      nodes: out.nodes,
      timedOut: out.timedOut,
    }
  }
  const solution: ShakaState = makeState(p, out.solutions[0]!)
  return {
    solved: true,
    solution,
    nodes: out.nodes,
    timedOut: out.timedOut,
    count: out.timedOut ? undefined : out.solutions.length,
  }
}

/** 判断一道题是否恰好一解（最多数到 2 组） */
export function isUnique(puzzle: Puzzle, maxNodes = 600_000): {
  unique: boolean
  count: number
  timedOut: boolean
} {
  const out = countSolutions(puzzle, 2, maxNodes)
  return { unique: !out.timedOut && out.count === 1, count: out.count, timedOut: out.timedOut }
}

/** 题面是否有解（供生成器/审计用） */
export function hasSolution(puzzle: Puzzle, maxNodes = 200_000): boolean {
  if (puzzle.width * puzzle.height === 0) return false
  const out = searchSolutions(puzzle, 1, maxNodes)
  return out.solutions.length > 0
}

/** 用一组朝向构造状态（黑格清零），供参考解/审计使用 */
export function stateFromCells(puzzle: Puzzle, cells: ArrayLike<number>): ShakaState {
  return makeState(puzzle, cells)
}
