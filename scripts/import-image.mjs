/**
 * 留方（Shakashaka）题面图片导入（全自动识图）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--name 名称] [--series 识图]
 *                                  [--append] [--verify] [--dry] [--json out.json]
 *                                  [--map "簇=数字,..."] [--fix "x,y=值,..."]
 *
 * 流程：
 *   1. Playwright + Edge 打开图片到 canvas，取灰度像素；
 *   2. 用「网格线投影」定位 n×n 格（深色细线夹在白格之间）；
 *   3. 每格取内部区域判断黑格 / 白格；黑格里的白字（0–4）做字形归一化；
 *   4. 字形聚类 + 多字体多字号模板匹配自动判读数字（--map 可人工覆盖簇）；
 *   5. 结构校验（题面数字不超过其相邻白格数），预览；
 *   6. --verify 调项目 solver 求解 / 唯一性检查（50×50 这类大盘面通常会超时，只警告）；
 *   7. --append 写入 src/game/imported-puzzles.ts（不会被 npm run gen 覆盖）。
 *
 * 题面编码沿用项目现有格式：`.` 白格、`#` 黑格无数字、`0`–`4` 黑格带数字。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { decodeBoard, encodeBoard } from '../src/game/types.ts'
import { countSolutions } from '../src/game/solver.ts'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function edgePath() {
  for (const c of EDGE_CANDIDATES) if (c && existsSync(c)) return c
  throw new Error('找不到 Edge 可执行文件，请用 EDGE_PATH 指定')
}

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
function arg(flag, fallback = '') {
  const i = args.indexOf(flag)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
function argEq(flag) {
  for (const a of args) if (a.startsWith(flag + '=')) return a.slice(flag.length + 1)
  return null
}
const VALUE_FLAGS = new Set(['--name', '--series', '--json', '--map', '--fix'])
const imageArg = args.find((a) => !a.startsWith('--') && !VALUE_FLAGS.has(args[args.indexOf(a) - 1]))
if (!imageArg) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--name 名称] [--series 识图] [--append] [--verify] [--dry] [--json out.json] [--map "簇=数字,..."] [--fix "x,y=值,..."]',
  )
  process.exit(1)
}
const IMAGE = path.resolve(imageArg)
if (!existsSync(IMAGE)) {
  console.error('找不到图片:', IMAGE)
  process.exit(1)
}

const nameOpt = arg('--name')
const series = arg('--series', '识图')
const jsonOut = arg('--json')
const append = has('--append')
const verifyOpt = has('--verify')
const dry = has('--dry')

const manualClusters = new Map()
const mapArg = argEq('--map') ?? arg('--map', '')
if (mapArg) {
  for (const pair of mapArg.split(/[,;]/)) {
    const m = /^\s*(\d+)\s*=\s*(\d+)\s*$/.exec(pair)
    if (!m) {
      console.error(`--map 格式错误：${pair}（应为 簇号=数字）`)
      process.exit(1)
    }
    manualClusters.set(Number(m[1]), Number(m[2]))
  }
}
const cellFixes = new Map()
const fixArg = argEq('--fix') ?? arg('--fix', '')
if (fixArg) {
  for (const part of fixArg.split(/[,;]/)) {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*=\s*(#|\d)\s*$/.exec(part)
    if (!m) {
      console.error(`--fix 格式错误：${part}（应为 x,y=# 或 x,y=数字）`)
      process.exit(1)
    }
    cellFixes.set(`${m[1]},${m[2]}`, m[3])
  }
}

/* ───────────────────────── 浏览器端几何 + 字形提取 ───────────────────────── */

const dataUrl = `data:image/png;base64,${readFileSync(IMAGE).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: edgePath() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const analysis = await page.evaluate(async (dataUrl) => {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const W = img.naturalWidth
  const H = img.naturalHeight
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const px = g.getImageData(0, 0, W, H).data
  const gray = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 255 : 0.299 * px[(y * W + x) * 4] + 0.587 * px[(y * W + x) * 4 + 1] + 0.114 * px[(y * W + x) * 4 + 2])

  // 1) 网格线：深色 1–2px 线，且左右（上下）都是白格
  const lineAt = (axis) => {
    const n = axis === 'x' ? W : H
    const len = axis === 'x' ? H : W
    const score = new Int32Array(n)
    for (let i = 2; i < n - 2; i++) {
      let c = 0
      for (let j = 2; j < len - 2; j++) {
        const v = axis === 'x' ? gray(i, j) : gray(j, i)
        if (v >= 140) continue
        const a = axis === 'x' ? gray(i - 2, j) : gray(j, i - 2)
        const b = axis === 'x' ? gray(i + 2, j) : gray(j, i + 2)
        if (a >= 248 && b >= 248) c++
      }
      score[i] = c
    }
    const threshold = len * 0.05
    const peaks = []
    let start = -1
    for (let i = 0; i < n; i++) {
      const on = score[i] >= threshold
      if (on && start < 0) start = i
      if (!on && start >= 0) {
        peaks.push((start + i - 1) / 2)
        start = -1
      }
    }
    if (start >= 0) peaks.push((start + n - 1) / 2)
    return peaks
  }
  let xs = lineAt('x')
  let ys = lineAt('y')
  // 线被黑格遮住时可能缺几条：按中位间距补齐到等高
  const fillLines = (list, target) => {
    if (list.length < 2) return list
    const out = list.slice().sort((a, b) => a - b)
    const gaps = []
    for (let i = 1; i < out.length; i++) gaps.push(out[i] - out[i - 1])
    gaps.sort((a, b) => a - b)
    const pitch = gaps[Math.floor(gaps.length / 2)]
    const merged = [out[0]]
    for (let i = 1; i < out.length; i++) {
      const gap = out[i] - merged[merged.length - 1]
      const k = Math.max(1, Math.round(gap / pitch))
      for (let q = 1; q < k; q++) merged.push(merged[merged.length - 1] + gap / k)
      merged.push(out[i])
    }
    while (merged.length > target) merged.pop()
    return merged
  }
  let N = Math.min(xs.length, ys.length) - 1
  if (N < 3) throw new Error(`网格识别失败：竖线 ${xs.length}、横线 ${ys.length}`)
  xs = fillLines(xs, N + 1)
  ys = fillLines(ys, N + 1)
  if (xs.length !== N + 1 || ys.length !== N + 1) {
    N = Math.min(xs.length, ys.length) - 1
    xs = xs.slice(0, N + 1)
    ys = ys.slice(0, N + 1)
  }
  const cellW = (xs[N] - xs[0]) / N
  const cellH = (ys[N] - ys[0]) / N

  // 2) 黑白格判定 + 黑格白字提取
  const NS = 20
  const glyphOf = (isInk, box) => {
    const x0 = box.minX
    const y0 = box.minY
    const x1 = box.maxX
    const y1 = box.maxY
    let ix0 = x1 + 1
    let iy0 = y1 + 1
    let ix1 = x0 - 1
    let iy1 = y0 - 1
    let ink = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!isInk(x, y)) continue
        ink++
        if (x < ix0) ix0 = x
        if (x > ix1) ix1 = x
        if (y < iy0) iy0 = y
        if (y > iy1) iy1 = y
      }
    }
    if (ink < 6 || ix1 < ix0) return null
    const bw = ix1 - ix0 + 1
    const bh = iy1 - iy0 + 1
    const m = new Array(NS * NS).fill(0)
    for (let j = 0; j < NS; j++) {
      const sy = iy0 + Math.min(bh - 1, Math.floor((j * bh) / NS))
      for (let i = 0; i < NS; i++) {
        const sx = ix0 + Math.min(bw - 1, Math.floor((i * bw) / NS))
        m[j * NS + i] = isInk(sx, sy) ? 1 : 0
      }
    }
    return { m, ink, w: bw, h: bh }
  }

  const cells = []
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const x0 = xs[c]
      const y0 = ys[r]
      const x1 = xs[c + 1]
      const y1 = ys[r + 1]
      const mx = x0 + (x1 - x0) * 0.24
      const my = y0 + (y1 - y0) * 0.24
      const mw = (x1 - x0) * 0.52
      const mh = (y1 - y0) * 0.52
      let dark = 0
      let total = 0
      for (let y = Math.round(my); y < Math.round(my + mh); y++) {
        for (let x = Math.round(mx); x < Math.round(mx + mw); x++) {
          total++
          if (gray(x, y) < 128) dark++
        }
      }
      const black = total > 0 && dark / total > 0.5
      let glyph = null
      if (black) {
        // 黑格里的数字是白字：取格子内 (去边) 的浅色连通域
        const ix0 = Math.round(x0 + (x1 - x0) * 0.14)
        const iy0 = Math.round(y0 + (y1 - y0) * 0.14)
        const ix1 = Math.round(x1 - (x1 - x0) * 0.14)
        const iy1 = Math.round(y1 - (y1 - y0) * 0.14)
        const local = { minX: ix1 + 1, minY: iy1 + 1, maxX: ix0 - 1, maxY: iy0 - 1 }
        let n = 0
        for (let y = iy0; y <= iy1; y++) {
          for (let x = ix0; x <= ix1; x++) {
            if (gray(x, y) < 150) continue
            n++
            if (x < local.minX) local.minX = x
            if (x > local.maxX) local.maxX = x
            if (y < local.minY) local.minY = y
            if (y > local.maxY) local.maxY = y
          }
        }
        if (n >= 12) {
          const bh = local.maxY - local.minY + 1
          const bw = local.maxX - local.minX + 1
          if (bh >= 7 && bh <= cellH * 0.85 && bw >= 2 && bw <= cellW * 0.8) {
            glyph = glyphOf((x, y) => gray(x, y) >= 150, local)
          }
        }
      }
      cells.push({ row: r, col: c, black, glyph })
    }
  }

  return {
    W,
    H,
    N,
    cellW: Number(cellW.toFixed(2)),
    cellH: Number(cellH.toFixed(2)),
    xs: xs.map((v) => Number(v.toFixed(1))),
    ys: ys.map((v) => Number(v.toFixed(1))),
    cells,
    blackCount: cells.filter((c) => c.black).length,
    glyphCount: cells.filter((c) => c.glyph).length,
  }
}, dataUrl)

/* ───────────────────────── 字形模板 ───────────────────────── */

const NS = 20
const DIGITS = '01234'
const templates = await page.evaluate(({ NS, DIGITS }) => {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const g = canvas.getContext('2d', { willReadFrequently: true })
  const FONTS = ['Arial', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Microsoft YaHei']
  const WEIGHTS = [400, 700]
  const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56]
  const out = {}
  for (const ch of DIGITS) out[ch] = []
  const norm = (data, threshold) => {
    let x0 = 96
    let y0 = 96
    let x1 = -1
    let y1 = -1
    let ink = 0
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        if (data[(y * 96 + x) * 4] < threshold) {
          ink++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (!ink) return null
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const m = new Array(NS * NS).fill(0)
    for (let j = 0; j < NS; j++) {
      const sy = y0 + Math.min(bh - 1, Math.floor((j * bh) / NS))
      for (let i = 0; i < NS; i++) {
        const sx = x0 + Math.min(bw - 1, Math.floor((i * bw) / NS))
        m[j * NS + i] = data[(sy * 96 + sx) * 4] < threshold ? 1 : 0
      }
    }
    return { m, w: bw, h: bh }
  }
  for (const font of FONTS) {
    for (const weight of WEIGHTS) {
      for (const size of SIZES) {
        for (const phase of [0, 0.25, 0.5, 0.75]) {
          for (const ch of DIGITS) {
            g.fillStyle = '#fff'
            g.fillRect(0, 0, 96, 96)
            g.fillStyle = '#000'
            g.font = `${weight} ${size}px "${font}"`
            g.textAlign = 'center'
            g.textBaseline = 'middle'
            g.fillText(ch, 48 + phase, 48 + phase)
            const data = g.getImageData(0, 0, 96, 96).data
            const t = norm(data, 128)
            if (t) out[ch].push({ m: t.m, w: t.w, h: t.h, font, weight, size })
          }
        }
      }
    }
  }
  return out
}, { NS, DIGITS })

function simShift(a, b, radius = 1) {
  let best = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      let inter = 0
      let uni = 0
      for (let j = 0; j < NS; j++) {
        const bj = j + dy
        for (let i = 0; i < NS; i++) {
          const av = a[j * NS + i]
          const bi = i + dx
          const bv = bj >= 0 && bj < NS && bi >= 0 && bi < NS ? b[bj * NS + bi] : 0
          if (av && bv) inter++
          if (av || bv) uni++
        }
      }
      const s = uni ? inter / uni : 0
      if (s > best) best = s
    }
  }
  return best
}

function clusterGlyphs(glyphs, threshold) {
  const clusters = []
  for (const glyph of glyphs) {
    let best = -1
    let bi = -1
    for (let k = 0; k < clusters.length; k++) {
      const s = simShift(glyph.m, clusters[k].proto)
      if (s > best) {
        best = s
        bi = k
      }
    }
    if (bi >= 0 && best >= threshold) {
      const cl = clusters[bi]
      cl.count++
      for (let i = 0; i < glyph.m.length; i++) cl.sum[i] += glyph.m[i]
      for (let i = 0; i < glyph.m.length; i++) cl.proto[i] = cl.sum[i] / cl.count >= 0.5 ? 1 : 0
    } else {
      clusters.push({ count: 1, sum: glyph.m.slice(), proto: glyph.m.slice() })
    }
  }
  clusters.sort((a, b) => b.count - a.count)
  return clusters
}

/* ───────────────────────── 判读 ───────────────────────── */

const clueGlyphs = analysis.cells.filter((c) => c.glyph).map((c) => c.glyph)
if (!clueGlyphs.length) {
  console.error('[import] 没有识别到任何数字；确认图片是留方题面（黑格白字 0–4）')
  process.exit(1)
}
const clusters = clusterGlyphs(clueGlyphs, 0.86)
const clusterTable = clusters.map((cl, k) => {
  const scores = DIGITS.split('').map((ch) => {
    let best = 0
    let meta = null
    for (const t of templates[ch]) {
      const s = simShift(cl.proto, t.m)
      if (s > best) {
        best = s
        meta = t
      }
    }
    return { ch, score: best, meta }
  })
  scores.sort((a, b) => b.score - a.score)
  const manual = manualClusters.get(k)
  return {
    k,
    count: cl.count,
    label: manual ?? Number(scores[0].ch),
    auto: Number(scores[0].ch),
    margin: scores[0].score - scores[1].score,
    scores: scores.slice(0, 3),
    manual: manual !== undefined,
    proto: cl.proto,
  }
})
console.log(
  `[import] ${path.basename(IMAGE)}：${analysis.W}×${analysis.H}px，格距 ${analysis.cellW}×${analysis.cellH}px，` +
    `识别 ${analysis.N}×${analysis.N}（黑格 ${analysis.blackCount}，数字 ${analysis.glyphCount}）`,
)
console.log('[import] 字形簇判读（--map 簇号=数字 可人工覆盖）：')
for (const row of clusterTable) {
  const flag = row.manual ? '人工' : row.margin < 0.05 ? '低置信' : '自动'
  console.log(
    `  簇${String(row.k).padStart(2)} n=${String(row.count).padStart(3)} → ${row.label}（${flag}，` +
      `${row.scores.map((s) => `${s.ch}:${s.score.toFixed(2)}`).join(' ')}）`,
  )
}
const labelOf = new Map(clusterTable.map((row) => [row.k, row.label]))
function clusterIndexFor(glyph) {
  let best = -1
  let bi = 0
  clusters.forEach((cl, k) => {
    const s = simShift(glyph.m, cl.proto)
    if (s > best) {
      best = s
      bi = k
    }
  })
  return bi
}

const N = analysis.N
const board = new Array(N * N).fill(0) // 0 白格；1 黑格无数字；2..6 黑格数字 0..4
for (const cell of analysis.cells) {
  const i = cell.row * N + cell.col
  if (!cell.black) {
    board[i] = 0
    continue
  }
  if (!cell.glyph) {
    board[i] = 1
    continue
  }
  const k = clusterIndexFor(cell.glyph)
  board[i] = 2 + (labelOf.get(k) ?? 0)
}
for (const [key, v] of cellFixes) {
  const [x, y] = key.split(',').map(Number)
  if (x < 0 || y < 0 || x >= N || y >= N) {
    console.warn(`[import] --fix ${key} 越界，忽略`)
    continue
  }
  board[y * N + x] = v === '#' ? 1 : 2 + Number(v)
}

/* ───────────────────────── 校验 + 预览 ───────────────────────── */

const issues = []
const isBlack = (v) => v !== 0
const clueOf = (v) => (v >= 2 ? v - 2 : -1)
const whiteAt = (x, y) => x >= 0 && y >= 0 && x < N && y < N && !isBlack(board[y * N + x])
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    const v = board[r * N + c]
    const clue = clueOf(v)
    if (clue < 0) continue
    let around = 0
    if (whiteAt(c - 1, r)) around++
    if (whiteAt(c + 1, r)) around++
    if (whiteAt(c, r - 1)) around++
    if (whiteAt(c, r + 1)) around++
    if (clue > around) issues.push(`黑格 (${c},${r}) 数字 ${clue} 大于其相邻白格数 ${around}`)
  }
}
if (!analysis.glyphCount) issues.push('题面没有任何数字（留方题至少会有若干数字格）')

console.log(`[import] 识别题面 ${N}×${N}（. 白格 / # 黑格 / 0-4 黑格数字）：`)
const shown = Math.min(N, 60)
for (let r = 0; r < shown; r++) {
  let line = ''
  for (let c = 0; c < shown; c++) {
    const v = board[r * N + c]
    line += v === 0 ? '.' : v === 1 ? '#' : String(v - 2)
  }
  console.log('  ' + String(r).padStart(2) + ' ' + line)
}
const clueTotal = board.filter((v) => v >= 2).length
const blackTotal = board.filter((v) => v !== 0).length
console.log(`[import] 黑格 ${blackTotal} / ${N * N}，数字格 ${clueTotal}，白格 ${N * N - blackTotal}`)
if (issues.length) {
  console.error(`[import] 题面结构问题 ${issues.length} 个：`)
  for (const msg of issues.slice(0, 20)) console.error('  - ' + msg)
  process.exitCode = 2
}

/* ───────────────────────── 求解校验（可选，大盘面通常超时） ───────────────────────── */

let solution = ''
let unique = false
if (!issues.length && verifyOpt) {
  const puzzle = {
    id: 'import-temp',
    name: 'import-temp',
    width: N,
    height: N,
    difficulty: 'hard',
    board,
  }
  const t0 = Date.now()
  const counted = countSolutions(puzzle, 2, 800_000)
  if (counted.timedOut) {
    console.warn(`[import] 唯一性检查超时（${counted.nodes} 节点，${Date.now() - t0}ms），仅警告（大盘面属正常）`)
  } else if (counted.count === 0) {
    console.warn('[import] 题面无解：识别结果可能有误，请用 --map / --fix 修正')
  } else if (counted.count > 1) {
    console.warn(`[import] 解不唯一（至少 ${counted.count} 个），参考解留空`)
  } else {
    unique = true
    console.log(`[import] 唯一解 ✓（${Date.now() - t0}ms，${counted.nodes} 节点）`)
  }
}

/* ───────────────────────── 导出 / 写入 ───────────────────────── */

const id = `shakashaka-img-${N}x${N}-${Date.now().toString(36)}`
const name = nameOpt || `识图 · 留方 ${N}×${N}`
const boardText = encodeBoard(board)
// 参考解编码串（0 留空 / # 黑格）——唯一解校验成功时才能补全，这里通常留空
const solutionText = ''

if (jsonOut) {
  const file = path.resolve(jsonOut)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        width: N,
        height: N,
        board: boardText,
        solution: solution || solutionText,
        unique,
        source: path.basename(IMAGE),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`[import] 已导出 JSON：${file}`)
}

if (append) {
  if (dry) {
    console.log('[import] --dry：跳过写入')
  } else if (issues.length) {
    console.error('[import] 题面结构有问题，拒绝写入（可用 --fix 修正后重跑）')
    process.exitCode = 2
  } else {
    const file = path.resolve('src/game/imported-puzzles.ts')
    const entry =
      `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${N}, height: ${N}, ` +
      `difficulty: 'hard', series: ${JSON.stringify(series)}, board: ${JSON.stringify(boardText)}, ` +
      `solution: ${JSON.stringify(solutionText)} },\n`
    if (!existsSync(file)) {
      writeFileSync(
        file,
        `/* 图片识别导入的题（scripts/import-image.mjs --append 写入；npm run gen 不会覆盖） */\n` +
          `import type { RawPuzzle } from './puzzles-data'\n\nexport const IMPORTED_PUZZLES: RawPuzzle[] = [\n${entry}]\n`,
      )
    } else {
      let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      const marker = text.lastIndexOf(']')
      if (marker < 0) throw new Error('imported-puzzles.ts 格式异常：找不到结尾 ]')
      text = text.slice(0, marker).replace(/\s+$/, '') + '\n' + entry + text.slice(marker)
      writeFileSync(file, text)
    }
    console.log(`[import] 已写入 ${file}：${id} ${name}${unique ? '' : '（参考解为空）'}`)
  }
} else {
  console.log('[import] 预览模式（未写入）。加 --append 写入 src/game/imported-puzzles.ts。')
}

await browser.close()
