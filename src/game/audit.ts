/**
 * 留方（Shakashaka）—— 题库 / 适配器深度审计
 *
 * 由 scripts/check.mjs 在 Node 里直接 import（Node 24 原生 TS type-stripping）。
 * 检查：
 *   1. 内置题 ≥ 6 道，id 唯一，题面尺寸一致；
 *   2. 每题都有参考解且通过实时校验；
 *   3. 每题恰好一解（求解器最多数 2 组）；
 *   4. 每题都能纯规则（数字 + 矩形 + 反证）推完，回放计划与参考解一致；
 *   5. 自定义题板编解码往返、进度存档往返。
 */

import { adapter } from './adapter.ts'
import { planLogicSolve } from './logic.ts'
import { countSolutions } from './solver.ts'
import { makeState } from './state.ts'
import {
  asPuzzle,
  asState,
  decodeBoard,
  encodeBoard,
  isBlack,
  NONE,
  type ShakaPuzzle,
} from './types.ts'
import { validate } from './validate.ts'

export interface PuzzleAudit {
  id: string
  name: string
  size: string
  difficulty: string
  black: number
  clues: number
  triangles: number
  refValid: boolean
  refMissing: boolean
  solutionCount: number
  unique: boolean
  timedOut: boolean
  logicFrames: number
  logicSaturated: boolean
  /** 反证试探次数（0 = 纯规则推完） */
  logicProbeTrials: number
  /** 兜底回溯节点数 */
  logicSearchNodes: number
  /** 定点推理后仍未定的白格数 */
  logicUndecided: number
  /** 各规则贡献的推导帧数 */
  ruleFrames: Record<number, number>
  logicFinalValid: boolean
  logicMatchesRef: boolean
  logicMs: number
  solveMs: number
}

export interface AuditReport {
  puzzles: PuzzleAudit[]
  customRoundtrip: boolean
  stateRoundtrip: boolean
  errors: string[]
  ok: boolean
}

const COUNT_NODES = 400_000

export function auditBuiltinPuzzles(): AuditReport {
  const errors: string[] = []
  const puzzles = adapter.builtinPuzzles
  if (puzzles.length < 6) {
    errors.push(`内置题只有 ${puzzles.length} 道（至少需要 6 道）`)
  }
  const seen = new Set<string>()
  const rows: PuzzleAudit[] = []

  for (const puzzle of puzzles) {
    const p = asPuzzle(puzzle)
    if (seen.has(p.id)) errors.push(`重复 id：${p.id}`)
    seen.add(p.id)
    const size = p.width * p.height
    if (p.board.length !== size) {
      errors.push(`${p.id} 题面长度 ${p.board.length} != ${p.width}×${p.height}`)
      continue
    }
    let black = 0
    let clues = 0
    for (const v of p.board) {
      if (isBlack(v)) black++
      if (v >= 2) clues++
    }

    // 参考解
    const ref = adapter.getReferenceSolution(p.id)
    const refMissing = !ref
    if (!ref) errors.push(`${p.id} 缺少参考解`)
    const refValid = !!ref && validate(ref, p).solved
    if (ref && !refValid) errors.push(`${p.id} 参考解未通过校验`)
    const refCells = ref ? asState(ref).cells.slice() : null
    const triangles = refCells ? refCells.filter((v) => v !== NONE).length : 0

    // 唯一解
    const tSolve = performance.now()
    const counted = countSolutions(p, 2, COUNT_NODES)
    const solveMs = Math.round(performance.now() - tSolve)
    if (counted.timedOut) errors.push(`${p.id} 唯一解校验超时（${counted.nodes} 节点）`)
    const unique = !counted.timedOut && counted.count === 1
    if (!unique && !counted.timedOut) {
      errors.push(`${p.id} 不是唯一解（至少 ${counted.count} 组）`)
    }

    // 纯逻辑推演
    const empty = adapter.createEmptyState(p)
    const tLogic = performance.now()
    const plan = planLogicSolve(p, empty)
    const logicMs = Math.round(performance.now() - tLogic)
    const final = plan.finalState
    const logicFinalValid = !!final && validate(final, p).solved
    if (!final) errors.push(`${p.id} 逻辑回放没有产出终态`)
    else if (!logicFinalValid) errors.push(`${p.id} 逻辑回放终态未通过校验`)
    let logicMatchesRef = false
    if (final && refCells) {
      const cells = asState(final).cells
      logicMatchesRef = cells.length === refCells.length
      if (logicMatchesRef) {
        // 三角形朝向不影响规则：按「是否是三角形」比较
        for (let i = 0; i < cells.length; i++) {
          if ((cells[i] !== NONE) !== (refCells[i] !== NONE)) {
            logicMatchesRef = false
            break
          }
        }
      }
      if (!logicMatchesRef) errors.push(`${p.id} 逻辑回放终态与参考解不同`)
    }
    if (!plan.saturated) errors.push(`${p.id} 逻辑回放需要回溯试探（不能纯规则推完）`)
    if (!plan.frames.length) errors.push(`${p.id} 逻辑回放没有产生任何推理帧`)

    rows.push({
      id: p.id,
      name: p.name,
      size: `${p.width}×${p.height}`,
      difficulty: p.difficulty,
      black,
      clues,
      triangles,
      refValid,
      refMissing,
      solutionCount: counted.count,
      unique,
      timedOut: counted.timedOut,
      logicFrames: plan.frames.length,
      logicSaturated: plan.saturated,
      logicProbeTrials: plan.probeTrials,
      logicSearchNodes: plan.searchNodes,
      logicUndecided: plan.undecided,
      ruleFrames: plan.ruleFrames,
      logicFinalValid,
      logicMatchesRef,
      logicMs,
      solveMs,
    })
  }

  // 自定义题板编解码往返
  let customRoundtrip = false
  try {
    const grid: Array<number | null> = new Array(5 * 5).fill(null)
    grid[0] = 1
    grid[1] = 2
    grid[2] = 3
    grid[3] = 4
    grid[6] = 5
    grid[7] = 6
    const made = adapter.custom.makePuzzle(5, 5, grid, 'shakashaka-custom-roundtrip')
    const encoded = adapter.custom.encodePuzzle(made)
    // 与 core/library.ts 的流程一致：条目 = Puzzle 基础字段 + 游戏特有编码字段
    const entry = {
      id: made.id,
      name: made.name,
      width: made.width,
      height: made.height,
      difficulty: made.difficulty,
      ...encoded,
    }
    const decoded = adapter.custom.decodePuzzle(entry)
    const restored = adapter.custom.toGrid?.(made)
    const board = asPuzzle(made).board
    customRoundtrip =
      !!decoded &&
      !!restored &&
      board.length === 25 &&
      board[0] === 1 &&
      board[1] === 2 &&
      board[7] === 6 &&
      encodeBoard(board) === String(encoded.board) &&
      JSON.stringify(asPuzzle(decoded).board) === JSON.stringify(board) &&
      restored.grid[0] === 1 &&
      restored.grid[7] === 6
    if (!customRoundtrip) errors.push('自定义题板编解码往返失败')
  } catch (err) {
    errors.push(`自定义题板编解码异常：${err instanceof Error ? err.message : String(err)}`)
  }

  // 进度存档往返
  let stateRoundtrip = false
  try {
    const first = adapter.builtinPuzzles[0]
    if (first) {
      const st = asState(adapter.createEmptyState(first))
      const p = asPuzzle(first)
      let placed = 0
      for (let i = 0; i < st.cells.length && placed < 5; i++) {
        if (isBlack(p.board[i]!)) continue
        st.cells[i] = ((i % 4) + 1) as number
        placed++
      }
      const data = adapter.serializeState(st)
      const back = adapter.deserializeState(data)
      stateRoundtrip =
        !!back &&
        JSON.stringify(asState(back).cells) === JSON.stringify(st.cells) &&
        JSON.stringify(asState(back).board) === JSON.stringify(st.board)
      if (!stateRoundtrip) errors.push('进度存档序列化往返失败')
    }
  } catch (err) {
    errors.push(`进度存档异常：${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    puzzles: rows,
    customRoundtrip,
    stateRoundtrip,
    errors,
    ok: errors.length === 0,
  }
}

/** 供调试：解码一个题面字符串并做校验 */
export function inspectBoard(text: string, width: number, height: number): {
  board: number[] | null
  stateValid: boolean
} {
  const board = decodeBoard(text, width * height)
  if (!board) return { board: null, stateValid: false }
  const puzzle: ShakaPuzzle = {
    id: 'inspect',
    name: 'inspect',
    width,
    height,
    difficulty: 'custom',
    board,
  }
  return { board, stateValid: validate(makeState(puzzle, board.map(() => 0)), puzzle).solved }
}
