/**
 * 留方（Shakashaka）—— 推理规则与域传播
 *
 * 每个白格维护一个「可能取值」位集：
 *   bit0 = 留空，bit1..bit4 = 四种三角形朝向
 *
 * 四条安全规则（对求解器与逻辑回放共用，且只做「必然」删减，保持可靠性）：
 *   规则 1（数字）：黑格四周的三角形数量恰好等于数字；
 *   规则 2（矩形）：所有留空白格必须连成矩形。
 *      - 一个已知留空的连通块，其外接矩形内的所有白格都必然是留空；
 *      - 已经完成矩形的连通块，若某一侧无法整排外扩（被黑格/必为三角的格挡住或出界），
 *        则紧贴该侧的那一排格子都不能留空（只能是三角形）。
 *   规则 3（凸角）：任意 2×2 内不能恰好有 3 格留空。
 *      三格留空必连成一块，其外接矩形就是这 2×2；第 4 格若是三角形/黑格就落在矩形内 → 矛盾。
 *      于是当 2×2 里已有 2 格必留空 + 1 格必三角形时，第 4 格必为三角形。
 *   规则 4（共享白格）：对角相邻的两个数字格共享 2 个白格邻居。
 *      枚举共享格的三角形/留空分配，用两个数字的计数范围判定可行性；
 *      在所有可行分配里取值一致的共享格即可确定（数字弧一致）。
 *
 * 规则 5（反证）与规则 6（回溯）在 logic.ts / solver.ts 里使用。
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
/** 2×2 凸角：不允许恰好 3 格留空（等价于 2 留空 + 1 三角 → 第 4 格必三角） */
export const RULE_CORNER = 3
/** 对角数字共享白格的弧一致 */
export const RULE_SHARED = 4
export const RULE_PROBE = 5
export const RULE_SEARCH = 6

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

    // 规则 3：2×2 凸角（不允许恰好 3 格留空）
    if (!propagateCornerWindows(dom, puzzle, assign)) return false

    // 规则 4：对角数字共享白格的弧一致
    if (!propagateSharedClues(dom, puzzle, nb, assign)) return false

    // 规则 2：矩形约束
    if (!propagateRegions(dom, puzzle, nb, assign)) return false
  }

  return true
}

/**
 * 规则 3：任意 2×2 内不能恰好 3 格留空。
 * 证明：三格留空在同一 2×2 内必四连通，其外接矩形就是这 2×2；
 * 第 4 格若为三角形或黑格，就落在矩形外接框内却不是留空格 → 白区不是矩形，矛盾。
 * 因此对每个 2×2 枚举「允许的留空/三角组合」，取值在所有可行组合里一致的格即可确定。
 */
function propagateCornerWindows(
  dom: Uint8Array,
  puzzle: ShakaPuzzle,
  assign: (i: number, mask: number, rule: number) => void,
): boolean {
  const w = puzzle.width
  const h = puzzle.height
  const board = puzzle.board
  const cells: number[] = [0, 0, 0, 0]
  const masks: number[] = [0, 0, 0, 0]

  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = y * w + x
      cells[0] = a
      cells[1] = a + 1
      cells[2] = a + w
      cells[3] = a + w + 1
      for (let k = 0; k < 4; k++) masks[k] = isBlack(board[cells[k]!]!) ? 0 : dom[cells[k]!]!
      let feasible = 0
      let emptyOk = 0b1111 // 每格「可以为空」的可行组合统计（按位或）
      let triOk = 0b1111
      // 位：1 = 留空，0 = 三角形；黑格固定为 0（非空）
      for (let pattern = 0; pattern < 16; pattern++) {
        let empties = 0
        let ok = true
        for (let k = 0; k < 4; k++) {
          const isEmpty = (pattern >> k) & 1
          if (isEmpty) {
            empties++
            if (!(masks[k]! & EMPTY_BIT)) {
              ok = false
              break
            }
          } else if (masks[k]! !== 0 && !(masks[k]! & TRI_BITS)) {
            // 白格必须还有三角形候选；黑格 masks = 0，固定为非空
            ok = false
            break
          }
        }
        if (!ok) continue
        // 三格留空 + 第 4 格非空 → 白区不是矩形，禁止
        if (empties === 3) continue
        feasible++
        let emptyBits = 0
        let triBits = 0
        for (let k = 0; k < 4; k++) {
          if ((pattern >> k) & 1) emptyBits |= 1 << k
          else triBits |= 1 << k
        }
        emptyOk &= emptyBits
        triOk &= triBits
      }
      if (!feasible) return false
      for (let k = 0; k < 4; k++) {
        const index = cells[k]!
        if (isBlack(board[index]!)) continue
        const canEmpty = (emptyOk >> k) & 1
        const canTri = (triOk >> k) & 1
        if (!canEmpty && canTri) assign(index, TRI_BITS, RULE_CORNER)
        else if (canEmpty && !canTri) assign(index, EMPTY_BIT, RULE_CORNER)
      }
    }
  }
  return true
}

/**
 * 规则 4：对角相邻（曼哈顿距离 2）的两个数字格共享 2 个白格邻居。
 * 枚举共享格「三角形 / 留空」的所有分配；对每个分配，用两个数字各自的
 * 「还需要几个三角形、非共享邻居够不够」判断可行性。
 * 在所有可行分配中取值一致的共享格即可确定。
 */
function propagateSharedClues(
  dom: Uint8Array,
  puzzle: ShakaPuzzle,
  nb: number[][],
  assign: (i: number, mask: number, rule: number) => void,
): boolean {
  const w = puzzle.width
  const h = puzzle.height
  const board = puzzle.board
  const size = w * h
  const clues: number[] = []
  for (let i = 0; i < size; i++) if (clueOf(board[i]!) >= 0) clues.push(i)
  if (clues.length < 2) return true

  for (let a = 0; a < clues.length; a++) {
    const ci = clues[a]!
    const xi = ci % w
    const yi = (ci / w) | 0
    for (let b = a + 1; b < clues.length; b++) {
      const cj = clues[b]!
      const dx = cj % w
      const dy = (cj / w) | 0
      if (Math.abs(dx - xi) + Math.abs(dy - yi) !== 2) continue

      const ni = nb[ci]!.filter((j) => !isBlack(board[j]!))
      const nj = nb[cj]!.filter((j) => !isBlack(board[j]!))
      const shared: number[] = []
      for (const j of ni) if (nj.includes(j)) shared.push(j)
      if (!shared.length) continue

      const onlyI = ni.filter((j) => !shared.includes(j))
      const onlyJ = nj.filter((j) => !shared.includes(j))
      const triI = onlyI.filter((j) => (dom[j]! & TRI_BITS) !== 0).length
      const emptyI = onlyI.filter((j) => (dom[j]! & EMPTY_BIT) !== 0).length
      const triJ = onlyJ.filter((j) => (dom[j]! & TRI_BITS) !== 0).length
      const emptyJ = onlyJ.filter((j) => (dom[j]! & EMPTY_BIT) !== 0).length
      const clueI = clueOf(board[ci]!)
      const clueJ = clueOf(board[cj]!)

      // 可行性：共享格放 triS 个三角形，非共享格需要 clue - triS 个三角形
      const fits = (need: number, cells: number, tri: number, empty: number): boolean => {
        if (need < 0 || need > cells) return false
        if (need > tri) return false
        if (cells - need > empty) return false
        return true
      }

      const allEmpty = (1 << shared.length) - 1
      let feasible = 0
      // 每格「可以为空」「可以为三角」的可行分配按位或
      let emptyOk = allEmpty
      let triOk = allEmpty
      for (let pattern = 0; pattern < 1 << shared.length; pattern++) {
        let triS = 0
        let ok = true
        for (let k = 0; k < shared.length; k++) {
          const j = shared[k]!
          if ((pattern >> k) & 1) {
            triS++
            if (!(dom[j]! & TRI_BITS)) {
              ok = false
              break
            }
          } else if (!(dom[j]! & EMPTY_BIT)) {
            ok = false
            break
          }
        }
        if (!ok) continue
        if (!fits(clueI - triS, onlyI.length, triI, emptyI)) continue
        if (!fits(clueJ - triS, onlyJ.length, triJ, emptyJ)) continue
        feasible++
        let emptyBits = 0
        let triBits = 0
        for (let k = 0; k < shared.length; k++) {
          if ((pattern >> k) & 1) triBits |= 1 << k
          else emptyBits |= 1 << k
        }
        emptyOk &= emptyBits
        triOk &= triBits
      }
      if (!feasible) return false
      for (let k = 0; k < shared.length; k++) {
        const j = shared[k]!
        const canEmpty = (emptyOk >> k) & 1
        const canTri = (triOk >> k) & 1
        if (!canEmpty && canTri) assign(j, TRI_BITS, RULE_SHARED)
        else if (canEmpty && !canTri) assign(j, EMPTY_BIT, RULE_SHARED)
      }
    }
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
