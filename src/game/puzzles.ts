/**
 * 留方（Shakashaka）—— 内置题库加载
 *
 * puzzles-data.ts 由 `npm run gen`（scripts/gen-config.mjs → generator.ts）生成：
 *   board    = 题面：. 白格 / # 黑格无数字 / 0–4 黑格带数字
 *   solution = 参考解：0 留空 / 1–4 三角形朝向 / # 黑格
 */

import { RAW_PUZZLES } from './puzzles-data.ts'
import { IMPORTED_PUZZLES } from './imported-puzzles.ts'
import { makeState } from './state.ts'
import {
  decodeBoard,
  decodeCells,
  isBlack,
  NONE,
  type ShakaPuzzle,
  type ShakaState,
} from './types.ts'

export const builtinPuzzles: ShakaPuzzle[] = []
const solutionCells = new Map<string, number[]>()

// 内置题 + 图片识别导入题（imported-puzzles.ts 由 scripts/import-image.mjs --append 写入）
for (const raw of [...RAW_PUZZLES, ...IMPORTED_PUZZLES]) {
  const size = raw.width * raw.height
  const board = decodeBoard(raw.board, size)
  if (!board) {
    console.warn(`[留方] 题面解码失败：${raw.id}`)
    continue
  }

  const puzzle: ShakaPuzzle = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    board,
  }
  builtinPuzzles.push(puzzle)

  if (raw.solution) {
    const cells = decodeCells(raw.solution, board, size)
    if (!cells) {
      console.warn(`[留方] 参考解解码失败：${raw.id}`)
      continue
    }
    // 参考解里黑格必须是 0，白格必须是 0–4
    let valid = true
    for (let i = 0; i < size; i++) {
      if (isBlack(board[i]!)) {
        if (cells[i] !== NONE) valid = false
      } else if (cells[i]! < 0 || cells[i]! > 4) valid = false
    }
    if (valid) {
      puzzle.solution = cells
      solutionCells.set(raw.id, cells)
    } else {
      console.warn(`[留方] 参考解与题面不一致：${raw.id}`)
    }
  } else {
    console.warn(`[留方] 缺少参考解：${raw.id}`)
  }
}

export function getReferenceSolution(id: string): ShakaState | null {
  const cells = solutionCells.get(id)
  if (!cells) return null
  const puzzle = builtinPuzzles.find((p) => p.id === id)
  if (!puzzle) return null
  return makeState(puzzle, cells)
}

export function puzzleById(id: string): ShakaPuzzle | undefined {
  return builtinPuzzles.find((p) => p.id === id)
}

/** 题面的参考解（若内置题携带）；否则 null */
export function referenceFor(puzzle: ShakaPuzzle): number[] | null {
  return puzzle.solution ?? solutionCells.get(puzzle.id) ?? null
}
