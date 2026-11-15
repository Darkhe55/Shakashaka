/**
 * 留方（Shakashaka）—— 逻辑解题回放计划
 *
 * 推理顺序：
 *   1. 数字约束：黑格四周的三角形数量；
 *   2. 矩形约束：外接矩形补完、已完成矩形无法整排外扩时紧贴格必须放三角；
 *   3. 反证：某一格取某值后规则立刻矛盾 → 排除该值；
 *   4. 若规则仍不能推完，用求解器补完并标注「回溯试探」。
 *
 * 注意：三角形朝向不影响任何规则，推理只区分「留空 / 三角形」。
 * 回放时三角形会用固定朝向显示；玩家已有的三角形（任意朝向）视为已满足。
 *
 * 内置题全部可只靠 1–3 推完（saturated = true）。
 */

import type { GameState, LogicPlan, Move, PlaybackFrame, Puzzle } from '../core/types'
import {
  EMPTY_BIT,
  TRI_BITS,
  initialDomains,
  isDecidedDomain,
  propagate,
  RULE_CLUE,
  RULE_PROBE,
  RULE_REGION,
  RULE_SEARCH,
} from './rules.ts'
import { findSolution, orientationFor } from './solver.ts'
import { makeState } from './state.ts'
import { asPuzzle, asState, isBlack, NONE } from './types.ts'
import { validate } from './validate.ts'

const RULE_LABELS: Record<number, string> = {
  [RULE_CLUE]: '数字约束：黑格四周的三角形数量已经确定',
  [RULE_REGION]: '矩形约束：留空白格必须补成矩形 / 这一格必须放三角形',
  [RULE_PROBE]: '反证：另一种填法会立刻违反规则',
  [RULE_SEARCH]: '回溯试探：唯一解要求这一格放三角形',
}

const PROBE_BUDGET = 12_000
const PROBE_ROUNDS = 60
const SEARCH_NODES = 900_000

export interface RulesFixpoint {
  /** 传播后的域（位集） */
  dom: Uint8Array
  /** false = 题面矛盾 */
  ok: boolean
  /** 反证试探次数 */
  probeTrials: number
}

/**
 * 只做「规则 1/2 + 反证」的定点推理，不产生回放帧。
 * 题库生成器与 scripts/check.mjs 用它判断一道题是否可纯逻辑推完。
 */
export function rulesFixpoint(
  puzzle: Puzzle,
  probeBudget = 4000,
  probeRounds = 40,
): RulesFixpoint {
  const p = asPuzzle(puzzle)
  const size = p.width * p.height
  const dom = initialDomains(p)
  const fail: RulesFixpoint = { dom, ok: false, probeTrials: 0 }
  if (p.board.length !== size) return fail
  if (!propagate(dom, p)) return fail

  let budget = probeBudget
  for (let round = 0; round < probeRounds && budget > 0; round++) {
    let progressed = false
    for (let i = 0; i < size && budget > 0; i++) {
      if (isBlack(p.board[i]!)) continue
      const d = dom[i]!
      if (isDecidedDomain(d)) continue
      const branches = [EMPTY_BIT, TRI_BITS].filter((mask) => (d & mask) !== 0)
      for (const mask of branches) {
        if (budget-- <= 0) break
        const trial = dom.slice()
        trial[i] = mask
        if (propagate(trial, p)) continue
        const next = dom[i]! & ~mask
        if (!next) return fail
        dom[i] = next
        progressed = true
      }
    }
    if (!progressed) break
    if (!propagate(dom, p)) return fail
  }
  return { dom, ok: true, probeTrials: probeBudget - budget }
}

/** 由域构造「确定的三角形（固定朝向），其余留空」 */
export function cellsFromDomains(dom: Uint8Array, width: number): number[] {
  const out = new Array<number>(dom.length).fill(NONE)
  for (let i = 0; i < dom.length; i++) {
    const d = dom[i]!
    if (d === TRI_BITS) out[i] = orientationFor(i, width)
  }
  return out
}

export function planLogicSolve(puzzle: Puzzle, initialState: GameState): LogicPlan {
  const p = asPuzzle(puzzle)
  const s = asState(initialState)
  const size = p.width * p.height
  const w = p.width

  const emptyPlan: LogicPlan = {
    puzzleId: p.id,
    frames: [],
    finalState: null,
    ruleSteps: 0,
    saturated: false,
  }
  if (p.board.length !== size) return emptyPlan

  const displayed: number[] =
    s.board.length === size && s.cells.length === size
      ? s.cells.slice()
      : new Array<number>(size).fill(NONE)
  for (let i = 0; i < size; i++) if (isBlack(p.board[i]!)) displayed[i] = NONE

  const frames: PlaybackFrame[] = []
  let lastRule = -1
  let streak = 0
  const emit = (index: number, to: number, rule: number): void => {
    const from = displayed[index] ?? NONE
    // 三角形朝向无关：已经是三角形就不再指挥播放
    if (to !== NONE && from !== NONE) return
    if (from === to) return
    displayed[index] = to
    if (rule === lastRule) streak++
    else {
      lastRule = rule
      streak = 1
    }
    const move: Move = { index, from, to }
    frames.push({ rule, label: RULE_LABELS[rule] ?? '推理', move, streak })
  }

  const emitDeduction = (index: number, triangle: boolean, rule: number): void => {
    emit(index, triangle ? orientationFor(index, w) : NONE, rule)
  }

  const dom = initialDomains(p)
  const hook = (d: { index: number; value: number; rule: number }): void => {
    emitDeduction(d.index, d.value !== 0, d.rule)
  }

  if (!propagate(dom, p, hook)) return emptyPlan

  const candidateFromDomains = (): number[] => cellsFromDomains(dom, w)

  const finalFromDisplayed = (): LogicPlan => ({
    puzzleId: p.id,
    frames,
    finalState: makeState(p, displayed.slice()),
    ruleSteps: frames.length,
    saturated: true,
  })

  const finishWithCandidate = (): LogicPlan | null => {
    const candidate = candidateFromDomains()
    const state = makeState(p, candidate)
    if (!validate(state, p).solved) return null
    // 玩家盘面上多出来的三角形需要清掉
    for (let i = 0; i < size; i++) {
      if (isBlack(p.board[i]!)) continue
      if (candidate[i] === NONE && displayed[i] !== NONE) emit(i, NONE, RULE_PROBE)
    }
    return finalFromDisplayed()
  }

  const byRules = finishWithCandidate()
  if (byRules) return byRules

  // —— 反证：逐格试探，排除会立刻矛盾的填法 ——
  let budget = PROBE_BUDGET
  for (let round = 0; round < PROBE_ROUNDS && budget > 0; round++) {
    let progressed = false
    for (let i = 0; i < size && budget > 0; i++) {
      if (isBlack(p.board[i]!)) continue
      const d = dom[i]!
      if (isDecidedDomain(d)) continue
      const branches = [EMPTY_BIT, TRI_BITS].filter((mask) => (d & mask) !== 0)
      for (const mask of branches) {
        if (budget-- <= 0) break
        const trial = dom.slice()
        trial[i] = mask
        if (propagate(trial, p)) continue
        const old = dom[i]!
        const next = old & ~mask
        if (!next) return emptyPlan
        dom[i] = next
        progressed = true
        if (!isDecidedDomain(old) && isDecidedDomain(next)) {
          emitDeduction(i, next === TRI_BITS, RULE_PROBE)
        }
      }
    }
    if (!progressed) break
    if (!propagate(dom, p, hook)) return emptyPlan
    const done = finishWithCandidate()
    if (done) return done
  }

  const afterProbe = finishWithCandidate()
  if (afterProbe) return afterProbe

  // —— 兜底：回溯补完，标注「回溯试探」 ——
  const found = findSolution(p, SEARCH_NODES)
  if (!found.solution) {
    return {
      puzzleId: p.id,
      frames,
      finalState: null,
      ruleSteps: frames.length,
      saturated: false,
    }
  }
  for (let i = 0; i < size; i++) {
    if (isBlack(p.board[i]!)) continue
    if (found.solution[i] !== NONE) emit(i, orientationFor(i, w), RULE_SEARCH)
    else if (displayed[i] !== NONE) emit(i, NONE, RULE_SEARCH)
  }
  return {
    puzzleId: p.id,
    frames,
    finalState: makeState(p, displayed.slice()),
    ruleSteps: frames.length,
    saturated: false,
  }
}
