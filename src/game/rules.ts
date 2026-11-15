/**
 * 留方（Shakashaka）—— 推理规则与域传播
 *
 * 每个白格维护一个「可能取值」位集：
 *   bit0 = 留空，bit1..bit4 = 四种三角形朝向
 *
 * 两条基础规则（对求解器与逻辑回放共用，且只做「必然」删减，保持可靠性）：
 *   规则 1（数字）：黑格四周的三角形数量恰好等于数字；
 *   规则 2（矩形）：所有留空白格必须连成矩形。
 *      - 一个已知留空的连通块，其外接矩形内的所有白格都必然是留空；
 *      - 已经完成矩形的连通块，若某一侧无法整排外扩（被黑格/必为三角的格挡住或出界），
 *        则紧贴该侧的那一排格子都不能留空（只能是三角形）。
 *
 * 规则 3（反证）与规则 4（回溯）在 logic.ts / solver.ts 里使用。
 */

import type { ShakaPuzzle } from './types.ts'
import { clueOf, isBlack } from './types.ts'

/** 位集：留空 */
export const EMPTY_BIT = 1
/** 位集：任意一种三角形朝向 */
export const TRI_BITS = 2 | 4 | 8 | 16
/** 位集：全部可能 */
export const ALL_BITS = EMPTY_BIT | TRI_BITS

/** 规则编号（用于回放状态栏） */
export const RULE_CLUE = 1
export const RULE_REGION = 2
export const RULE_PROBE = 3
export const RULE_SEARCH = 4

export interface Deduction {
  index: number
  /** 确定的取值（0 = 留空，1..4 = 朝向） */
  value: number
  rule: number
}

export type DeductHook = (d: Deduction) => void

export function bitOf(value: number): number {
  return 1 << value
}

export function valuesOfMask(mask: number): number[] {
  const out: number[] = []
  for (let v = 0; v <= 4; v++) if (mask & (1 << v)) out.push(v)
  return out
}

/** 域是否已确定：只可能留空，或只可能三角形（朝向不参与推理） */
export function isDecidedDomain(dom: number): boolean {
  return dom === EMPTY_BIT || dom === TRI_BITS
}

export function popcount(x: number): number {
  let c = 0
  let v = x
  while (v) {
    v &= v - 1
    c++
  }
  return c
}

/* ────────────────────────── 邻接表缓存 ────────────────────────── */

const neighborCache = new Map<string, number[][]>()

/** 每格的四邻（越界自动省略），按宽高缓存 */
export function neighborsFor(w: number, h: number): number[][] {
  const key = `${w}x${h}`
  const cached = neighborCache.get(key)
  if (cached) return cached
  const size = w * h
  const list: number[][] = new Array(size)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const ns: number[] = []
      if (x > 0) ns.push(i - 1)
      if (x + 1 < w) ns.push(i + 1)
      if (y > 0) ns.push(i - w)
      if (y + 1 < h) ns.push(i + w)
      list[i] = ns
    }
  }
  neighborCache.set(key, list)
  return list
}

/* ────────────────────────── 初始域 ────────────────────────── */

/** 白格 = 全部可能；黑格 = 空域（不可填） */
export function initialDomains(puzzle: ShakaPuzzle): Uint8Array {
  const size = puzzle.width * puzzle.height
  const dom = new Uint8Array(size)
  for (let i = 0; i < size; i++) dom[i] = isBlack(puzzle.board[i]!) ? 0 : ALL_BITS
  return dom
}

/* ────────────────────────── 传播 ────────────────────────── */

/**
 * 在 dom 上反复应用规则 1/2 直到不动点。
 * 返回 false 表示矛盾；hook 会收到「新变成唯一取值」的推导。
 */
export function propagate(
  dom: Uint8Array,
  puzzle: ShakaPuzzle,
  hook?: DeductHook,
): boolean {
  const w = puzzle.width
  const h = puzzle.height
  const board = puzzle.board
  const size = w * h
  const nb = neighborsFor(w, h)

  let changed = true
  let guard = 0
  while (changed) {
    if (++guard > 400) break // 防御：极端情况下不空转
    changed = false
    let bad = false

    const assign = (i: number, mask: number, rule: number): void => {
      if (bad) return
      const old = dom[i]!
      const next = old & mask
      if (next === old) return
      if (next === 0) {
        bad = true
        return
      }
      dom[i] = next
      changed = true
      if (!isDecidedDomain(old) && isDecidedDomain(next)) {
        hook?.({ index: i, value: next === EMPTY_BIT ? 0 : 1, rule })
      }
    }

    // 规则 1：黑格数字
    for (let i = 0; i < size && !bad; i++) {
      const clue = clueOf(board[i]!)
      if (clue < 0) continue
      const ns = nb[i]!
      let cells = 0
      let triCandidates = 0
      let emptyCandidates = 0
      for (const j of ns) {
        if (isBlack(board[j]!)) continue
        cells++
        const d = dom[j]!
        if (d & TRI_BITS) triCandidates++
        if (d & EMPTY_BIT) emptyCandidates++
      }
      if (clue > cells || triCandidates < clue) {
        bad = true
        break
      }
      const needEmpty = cells - clue
      if (emptyCandidates < needEmpty) {
        bad = true
        break
      }
      // 能放三角的格恰好够 → 这些格都不能留空
      if (triCandidates === clue) {
        for (const j of ns) {
          if (isBlack(board[j]!)) continue
          if (dom[j]! & TRI_BITS) assign(j, TRI_BITS, RULE_CLUE)
          if (bad) break
        }
      }
      // 可能留空的格恰好够 → 这些格都必须留空
      if (emptyCandidates === needEmpty) {
        for (const j of ns) {
          if (isBlack(board[j]!)) continue
          if (dom[j]! & EMPTY_BIT) assign(j, EMPTY_BIT, RULE_CLUE)
          if (bad) break
        }
      }
    }
    if (bad) return false

    // 规则 2：矩形约束
    if (!propagateRegions(dom, puzzle, nb, assign)) return false
  }

  return true
}

function propagateRegions(
  dom: Uint8Array,
  puzzle: ShakaPuzzle,
  nb: number[][],
  assign: (i: number, mask: number, rule: number) => void,
): boolean {
  const w = puzzle.width
  const h = puzzle.height
  const board = puzzle.board
  const size = w * h

  // 已知留空（域里只剩留空）的连通块
  const seen = new Uint8Array(size)
  const components: number[][] = []
  for (let start = 0; start < size; start++) {
    if (seen[start] || dom[start] !== EMPTY_BIT) continue
    const comp: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      for (const j of nb[i]!) {
        if (seen[j] || dom[j] !== EMPTY_BIT) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    components.push(comp)
  }

  for (const comp of components) {
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
    // 外接矩形内的所有格子都必然留空
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = y * w + x
        if (isBlack(board[i]!)) return false
        if ((dom[i]! & EMPTY_BIT) === 0) return false
        if (dom[i] !== EMPTY_BIT) assign(i, EMPTY_BIT, RULE_REGION)
      }
    }
  }

  // 已完成的矩形：不能整排外扩的方向，紧贴该侧的一排必须放三角形
  for (const comp of components) {
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
    const area = (maxX - minX + 1) * (maxY - minY + 1)
    if (area !== comp.length) continue // 还没补成矩形，交给外接矩形规则

    const sides: Array<{ cells: number[]; outOfBoard: boolean }> = []

    // 上
    if (minY === 0) sides.push({ cells: [], outOfBoard: true })
    else {
      const cells: number[] = []
      let out = false
      for (let x = minX; x <= maxX; x++) cells.push((minY - 1) * w + x)
      sides.push({ cells, outOfBoard: out })
    }
    // 下
    if (maxY === h - 1) sides.push({ cells: [], outOfBoard: true })
    else {
      const cells: number[] = []
      for (let x = minX; x <= maxX; x++) cells.push((maxY + 1) * w + x)
      sides.push({ cells, outOfBoard: false })
    }
    // 左
    if (minX === 0) sides.push({ cells: [], outOfBoard: true })
    else {
      const cells: number[] = []
      for (let y = minY; y <= maxY; y++) cells.push(y * w + (minX - 1))
      sides.push({ cells, outOfBoard: false })
    }
    // 右
    if (maxX === w - 1) sides.push({ cells: [], outOfBoard: true })
    else {
      const cells: number[] = []
      for (let y = minY; y <= maxY; y++) cells.push(y * w + (maxX + 1))
      sides.push({ cells, outOfBoard: false })
    }

    for (const side of sides) {
      if (side.outOfBoard) continue // 出界一侧没有格子，无需处理
      if (!side.cells.length) continue
      let canGrow = true
      for (const j of side.cells) {
        if (isBlack(board[j]!) || (dom[j]! & EMPTY_BIT) === 0) {
          canGrow = false
          break
        }
      }
      if (canGrow) continue
      // 这一侧无法整排外扩 → 紧贴的格子都不能留空
      for (const j of side.cells) {
        if (isBlack(board[j]!)) continue
        if (dom[j]! & EMPTY_BIT) assign(j, TRI_BITS, RULE_REGION)
      }
    }
  }

  return true
}
