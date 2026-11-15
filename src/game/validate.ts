/**
 * 留方（Shakashaka）—— 实时校验
 *
 * 完成的判定：
 *   1. 每个黑格数字 = 其上下左右四格中的三角形数量；
 *   2. 所有「未放三角形的白格」的每个四连通块都是矩形。
 * 不要求放满三角形：一整块矩形白区全部留空同样是合法终态。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'
import { neighborsFor } from './rules.ts'
import {
  asPuzzle,
  asState,
  clueOf,
  isBlack,
  NONE,
  type RegionIssue,
  type ShakaResult,
} from './types.ts'

export function validate(state: GameState, puzzle: Puzzle): ShakaResult {
  const s = asState(state)
  const p = asPuzzle(puzzle)
  const w = s.width
  const h = s.height
  const size = w * h
  const board = p.board.length === size ? p.board : s.board
  const cells = s.cells
  const nb = neighborsFor(w, h)

  // 题面可能在题库里被编辑过（同 id 换题面），此时以 puzzle.board 为准，
  // 同步回状态副本，避免左键/右键继续按旧题面判断黑白格。
  if (s.board.length === size) {
    let changed = false
    for (let i = 0; i < size; i++) {
      if (s.board[i] !== board[i]) changed = true
      if (isBlack(board[i]!) && (cells[i] ?? NONE) !== NONE) {
        cells[i] = NONE
        changed = true
      }
    }
    if (changed) s.board = board.slice()
  }

  let triangleCount = 0
  const invalidCells: number[] = []
  for (let i = 0; i < size; i++) {
    if (isBlack(board[i]!)) continue
    const v = cells[i] ?? NONE
    if (!Number.isInteger(v) || v < 0 || v > 4) invalidCells.push(i)
    else if (v !== NONE) triangleCount++
  }

  // 白区：未放三角形的白格连通块
  const seen = new Uint8Array(size)
  const issues: RegionIssue[] = []
  const badRegionCells: number[] = []
  let regionCount = 0
  for (let start = 0; start < size; start++) {
    if (seen[start]) continue
    if (isBlack(board[start]!) || (cells[start] ?? NONE) !== NONE) {
      seen[start] = 1
      continue
    }
    regionCount++
    const comp: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      for (const j of nb[i]!) {
        if (seen[j]) continue
        if (isBlack(board[j]!) || (cells[j] ?? NONE) !== NONE) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    let minX = w
    let maxX = -1
    let minY = h
    let maxY = -1
    for (const i of comp) {
      const x = i % w
      const y = (i / w) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const bboxArea = (maxX - minX + 1) * (maxY - minY + 1)
    if (bboxArea !== comp.length) {
      issues.push({ cells: comp, size: comp.length, bboxArea, kind: 'not-rect' })
      for (const i of comp) badRegionCells.push(i)
    }
  }

  // 数字约束
  const clueBad: number[] = []
  let clueCount = 0
  for (let i = 0; i < size; i++) {
    const clue = clueOf(board[i]!)
    if (clue < 0) continue
    clueCount++
    let around = 0
    for (const j of nb[i]!) {
      if (isBlack(board[j]!)) continue
      if ((cells[j] ?? NONE) !== NONE) around++
    }
    if (around !== clue) clueBad.push(i)
  }

  const badSet = new Set<number>()
  for (const i of badRegionCells) badSet.add(i)
  for (const i of clueBad) badSet.add(i)
  for (const i of invalidCells) badSet.add(i)

  const result: ShakaResult = {
    solved: badSet.size === 0,
    triangleCount,
    regionCount,
    badRegionCount: issues.length,
    badRegionCells,
    clueBad,
    clueCount,
    invalidCells,
    badCells: Array.from(badSet),
  }
  return result
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as ShakaResult
  if (r.solved) return ['完成！所有白区都是矩形，数字也全部吻合']
  const bits: string[] = []
  if (typeof r.badRegionCount === 'number' && r.badRegionCount > 0) {
    bits.push(`${r.badRegionCount} 处白区不是矩形`)
  }
  if (Array.isArray(r.clueBad) && r.clueBad.length > 0) {
    bits.push(`${r.clueBad.length} 个数字不符`)
  }
  if (Array.isArray(r.invalidCells) && r.invalidCells.length > 0) {
    bits.push(`${r.invalidCells.length} 格取值非法`)
  }
  if (typeof r.triangleCount === 'number') bits.push(`已放 ${r.triangleCount} 个三角形`)
  if (!bits.length) bits.push('继续推理')
  return bits
}
