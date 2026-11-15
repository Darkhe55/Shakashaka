/**
 * 留方（Shakashaka）—— Playwright 冒烟测试
 *
 * 前置：先启动 dev server（npm run dev / npm start），端口读 package.json。
 * 用法：npm run ui-check
 * 可用环境变量 EDGE_PATH 指定浏览器可执行文件路径。
 *
 * 覆盖：
 *   1. 页面骨架、6 道内置题、棋盘 SVG；
 *   2. 鼠标左键循环 / 右键清除 / 撤销重做；
 *   3. 键盘方向键 + 空格/1-4/0（且 0 不会误触缩放复位）；
 *   4. 提示一格、显示解、检查；
 *   5. 逻辑解题回放完整跑完并解出；
 *   6. 自定义题板：编辑、载入、求解（唯一解）、保存、编辑、删除。
 * 截图输出到 output/playwright/。
 */
import { chromium } from 'playwright-core'
import { PORT } from './_port.mjs'

const executablePath =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = `http://127.0.0.1:${PORT}/`

const failures = []
function check(cond, message) {
  if (cond) return true
  failures.push(message)
  console.error('FAIL:', message)
  return false
}

const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1360, height: 960 } })
const pageErrors = []
page.on('pageerror', (e) => {
  pageErrors.push(e.message)
  console.error('PAGEERROR:', e.message)
})
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    pageErrors.push(msg.text())
    console.error('CONSOLE:', msg.text())
  }
})

const shot = async (name) => {
  await page.screenshot({ path: `output/playwright/${name}.png`, fullPage: true })
  console.log('  · screenshot', name)
}

const getSession = () =>
  page.evaluate(() => {
    const g = window.__game
    const s = g.getSession()
    if (!s) return null
    const result = g.adapter.validate(s.state, s.puzzle)
    return {
      id: s.puzzle.id,
      name: s.puzzle.name,
      width: s.puzzle.width,
      height: s.puzzle.height,
      board: s.state.board.slice(),
      cells: s.state.cells.slice(),
      solved: result.solved,
      triangles: s.state.cells.filter((v) => v !== 0).length,
      status: document.querySelector('#status')?.textContent ?? '',
    }
  })

const cellPoint = (index) =>
  page.evaluate((index) => {
    const g = window.__game
    const s = g.getSession()
    const m = g.adapter.metricsFor(s.puzzle)
    const svg = document.querySelector('svg.board-svg')
    const o = { x: m.originX ?? m.pad, y: m.originY ?? m.pad }
    const cw = m.cellW ?? m.cell
    const ch = m.cellH ?? m.cell
    const pt = svg.createSVGPoint()
    pt.x = o.x + (index % m.width) * cw + cw / 2
    pt.y = o.y + Math.floor(index / m.width) * ch + ch / 2
    const p = pt.matrixTransform(svg.getScreenCTM())
    return { x: p.x, y: p.y }
  }, index)

const firstWhite = (session) => session.board.findIndex((v) => v === 0)

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('svg.board-svg')

/* ── 1. 页面骨架 + 题库 ─────────────────────────────────── */

const puzzleCount = await page.locator('.puzzle-item').count()
check(puzzleCount >= 6, `内置题数量应 ≥ 6，实际 ${puzzleCount}`)
check((await page.locator('svg.board-svg').count()) === 1, '缺少棋盘 SVG')
check((await page.title()).includes('留方'), `页面标题应为「留方（Shakashaka）」，实际「${await page.title()}」`)
const initialList = await page.locator('.puzzle-item .title').allTextContents()
console.log('  题库：', initialList.join(' / '))

await page.locator('.puzzle-item').filter({ hasText: '初见留白' }).first().click()
await page.waitForTimeout(200)
// 上一次运行可能留下了进度；清空后从空盘开始，保证断言确定
await page.locator('#btn-clear').click()
await page.waitForTimeout(150)
let session = await getSession()
check(session?.id === 'shakashaka-6x6-01', `应载入「初见留白」，实际 ${session?.id}`)
check(session?.width === 6 && session?.height === 6, '题目尺寸应为 6×6')
check(session?.triangles === 0, '新题盘面应为空')
await shot('01-initial')

/* ── 2. 鼠标：左键循环、右键清除、撤销/重做 ──────────────── */

let index = firstWhite(session)
let point = await cellPoint(index)
await page.mouse.click(point.x, point.y)
session = await getSession()
check(session.cells[index] === 1, `左键点击应放到朝向 1，实际 ${session.cells[index]}`)
await page.mouse.click(point.x, point.y)
session = await getSession()
check(session.cells[index] === 2, `再次左键应循环到朝向 2，实际 ${session.cells[index]}`)
await shot('02-mouse')

await page.locator('#btn-undo').click()
await page.waitForTimeout(80)
session = await getSession()
check(session.cells[index] === 1, `撤销后应回到朝向 1，实际 ${session.cells[index]}`)
await page.locator('#btn-redo').click()
await page.waitForTimeout(80)
session = await getSession()
check(session.cells[index] === 2, `重做后应回到朝向 2，实际 ${session.cells[index]}`)

point = await cellPoint(index)
await page.mouse.click(point.x, point.y, { button: 'right' })
await page.waitForTimeout(80)
session = await getSession()
check(session.cells[index] === 0, `右键应清除该格，实际 ${session.cells[index]}`)

/* ── 3. 键盘：方向键移动、1-4 设朝向、0 清空 ─────────────── */

// 先把光标定在第一格
await page.keyboard.press('3')
await page.waitForTimeout(80)
session = await getSession()
const kw = firstWhite(session)
check(session.cells[kw] === 3, `按 3 应在光标格放朝向 3，实际 ${session.cells[kw]}`)
await page.keyboard.press('0')
await page.waitForTimeout(50)
session = await getSession()
check(session.cells[kw] === 0, `按 0 应清空光标格，实际 ${session.cells[kw]}`)
const zoom = await page.locator('#zoom-label').textContent()
check(zoom === '100%', `按 0 不应触发缩放复位，zoom=${zoom}`)

// 方向键移动光标后，空格循环放置一个三角形
const before = (await getSession()).cells.slice()
await page.keyboard.press('ArrowRight')
await page.keyboard.press(' ')
await page.waitForTimeout(80)
session = await getSession()
const changed = []
for (let i = 0; i < session.cells.length; i++) if (session.cells[i] !== before[i]) changed.push(i)
check(changed.length === 1, `方向键 + 空格应只改变一格，实际改变 ${changed.length} 格`)
if (changed.length === 1) {
  check(session.cells[changed[0]] === 1, `空格应循环出朝向 1，实际 ${session.cells[changed[0]]}`)
}
await shot('03-keyboard')
await page.keyboard.press('0')

/* ── 4. 提示一格 / 显示解 / 检查 ─────────────────────────── */

await page.locator('#btn-clear').click()
await page.waitForTimeout(100)
await page.locator('#btn-hint').click()
await page.waitForTimeout(120)
session = await getSession()
check(session.triangles === 1, `提示一格应放置 1 个三角形，实际 ${session.triangles}`)
check(session.status.includes('提示'), `状态栏应提示已提示一格，实际「${session.status}」`)

await page.locator('#btn-solve').click()
await page.waitForTimeout(150)
session = await getSession()
check(session.solved, '显示解后盘面应通过校验')
check(session.triangles > 1, '显示解后应放置多个三角形')
await page.locator('#btn-check').click()
await page.waitForTimeout(120)
session = await getSession()
check(/完成|正确/.test(session.status), `显示解后检查应提示完成，实际「${session.status}」`)
await shot('04-solved')

/* ── 5. 逻辑解题回放 ─────────────────────────────────────── */

await page.locator('#btn-clear').click()
await page.waitForTimeout(100)
await page.locator('#btn-logic').click()
await page.waitForFunction(
  () => {
    const btn = document.querySelector('#btn-logic')
    return btn && !btn.disabled && btn.textContent === '逻辑解题'
  },
  { timeout: 180_000 },
)
await page.waitForTimeout(300)
session = await getSession()
check(session.solved, '逻辑解题回放后盘面应通过校验')
check(session.triangles > 1, '逻辑解题回放后应有多个三角形')
check(/逻辑解题|回放/.test(session.status), `状态栏应显示回放结果，实际「${session.status}」`)
await shot('05-logic')

/* ── 6. 自定义题板：编辑 / 载入 / 求解 / 保存 / 编辑 / 删除 ── */

const builtin6 = await page.evaluate(() => {
  const p = window.__game.adapter.builtinPuzzles.find((x) => x.name === '初见留白')
  return { board: p.board.slice() }
})

await page.locator('#btn-custom').click()
await page.waitForTimeout(120)
await page.fill('#custom-w', '6')
await page.fill('#custom-h', '6')
await page.locator('#custom-regen').click()
await page.waitForTimeout(120)
check((await page.locator('.custom-cell').count()) === 36, '自定义编辑器应生成 36 格')

// 用内置题题面填充编辑器（点击循环：空→黑→黑0→黑1…）
await page.evaluate((board) => {
  for (let i = 0; i < board.length; i++) {
    const times = board[i]
    const btn = document.querySelector(`.custom-cell[data-i="${i}"]`)
    for (let k = 0; k < times; k++) btn.click()
  }
}, builtin6.board)

const painted = await page.evaluate(() =>
  [...document.querySelectorAll('.custom-cell')].map((b) => b.textContent),
)
const expectedDark = builtin6.board.filter((v) => v >= 2).length
check(
  painted.filter((text) => /[0-4]/.test(text)).length === expectedDark,
  `编辑器应有 ${expectedDark} 个带数字黑格，实际 ${painted.filter((t) => /[0-4]/.test(t)).length}`,
)
const paintedBlack = await page.evaluate(
  () => document.querySelectorAll('.custom-cell.sh-ed-black, .custom-cell.sh-ed-clue').length,
)
check(
  paintedBlack === builtin6.board.filter((v) => v > 0).length,
  `编辑器黑格数应为 ${builtin6.board.filter((v) => v > 0).length}，实际 ${paintedBlack}`,
)
await shot('06-custom-editor')

await page.locator('#custom-apply').click()
await page.waitForTimeout(200)
session = await getSession()
check(session.id.startsWith('shakashaka-custom-'), `载入后应是自定义题，实际 ${session.id}`)
check(
  JSON.stringify(session.board) === JSON.stringify(builtin6.board),
  '载入后的题面应与编辑器一致',
)
const customRows = await page.locator('.puzzle-row').filter({ has: page.locator('.puzzle-act') }).count()
check(customRows >= 1, '题库中应出现自定义题（带编辑/删除按钮）')

await page.locator('#custom-solve').click()
await page.waitForTimeout(400)
session = await getSession()
check(session.solved, '自定义题求解后盘面应通过校验')
const solveMsg = await page.locator('#custom-msg').textContent()
check(/唯一解/.test(solveMsg ?? ''), `自定义题求解应提示唯一解，实际「${solveMsg}」`)
await shot('07-custom-loaded')

// 保存到题库（覆盖同一 id）
await page.locator('#custom-save').click()
await page.waitForTimeout(200)
const saveMsg = await page.locator('#custom-msg').textContent()
check(/已保存|已更新/.test(saveMsg ?? ''), `保存到题库应有提示，实际「${saveMsg}」`)

// 编辑：打开已保存自定义题，格子应还原，改动后保存
const editBtn = page.locator('.puzzle-act[data-edit]').first()
await editBtn.click()
await page.waitForTimeout(200)
check(await page.locator('#custom-editor').isVisible(), '点击编辑后自定义编辑器应打开')
const restoredDark = await page.evaluate(
  () => document.querySelectorAll('.custom-cell.sh-ed-black, .custom-cell.sh-ed-clue').length,
)
check(
  restoredDark === builtin6.board.filter((v) => v > 0).length,
  `编辑时应还原 ${builtin6.board.filter((v) => v > 0).length} 个黑格，实际 ${restoredDark}`,
)
await page.evaluate(() => document.querySelector('.custom-cell[data-i="0"]')?.click())
const editedFirst = await page.evaluate(
  () => document.querySelector('.custom-cell[data-i="0"]')?.textContent,
)
check(editedFirst === '■', `编辑第一个格子后应变成黑格，实际「${editedFirst}」`)
await page.locator('#custom-save').click()
await page.waitForTimeout(200)
check(
  (/已保存|已更新/.test((await page.locator('#custom-msg').textContent()) ?? '')),
  '编辑后保存应成功',
)

// 删除（两次点击确认）
const delBtn = page.locator('.puzzle-act[data-del]').first()
await delBtn.click()
await page.waitForTimeout(120)
check(
  (await page.locator('.puzzle-act[data-del].confirm').count()) === 1,
  '第一次点删除应进入确认态',
)
await page.locator('.puzzle-act[data-del].confirm').first().click()
await page.waitForTimeout(300)
session = await getSession()
check(
  !session.id.startsWith('shakashaka-custom-'),
  '删除当前自定义题后应切换到其它题',
)
check(
  (await page.locator('.puzzle-act[data-del]').count()) === 0,
  '删除后题库中不应再有自定义题',
)
check(/删除/.test(session.status), `删除后状态栏应有提示，实际「${session.status}」`)
await shot('08-custom-deleted')

/* ── 收尾 ───────────────────────────────────────────────── */

check(pageErrors.length === 0, `页面不应有 JS 错误：${pageErrors.join(' | ')}`)
console.log(`\n[ui-check] 失败 ${failures.length} 项`)
await browser.close()
if (failures.length || pageErrors.length) process.exitCode = 1
else console.log('[ui-check] OK ✔')
