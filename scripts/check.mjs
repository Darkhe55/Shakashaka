/**
 * 留方（Shakashaka）—— 题库审计
 *
 * 直接在 Node 里 import 游戏适配器与求解器（Node 24 原生 TS type-stripping），
 * 不依赖浏览器 / dev server。检查内容：
 *   1. 内置题 ≥ 6 道、id 唯一、题面尺寸正确；
 *   2. 每题参考解存在且通过实时校验；
 *   3. 每题恰好一解；
 *   4. 每题都能纯规则推完，且逻辑回放终态与参考解一致；
 *   5. 自定义题板编解码往返、进度存档往返。
 *
 * 用法：npm run check
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AUDIT_FILE = path.resolve('src/game/audit.ts')
const url = pathToFileURL(AUDIT_FILE).href

let auditBuiltinPuzzles
try {
  const mod = await import(url)
  auditBuiltinPuzzles = mod.auditBuiltinPuzzles
} catch (err) {
  console.error('[check] 无法加载 src/game/audit.ts：')
  console.error(err)
  process.exit(1)
}

const report = auditBuiltinPuzzles()

const rows = report.puzzles.map((p) => ({
  题名: p.name,
  尺寸: p.size,
  难度: p.difficulty,
  黑格: p.black,
  数字: p.clues,
  三角: p.triangles,
  参考解: p.refMissing ? '缺失' : p.refValid ? 'OK' : '非法',
  解数: p.timedOut ? '超时' : p.unique ? '唯一' : `≥${p.solutionCount}`,
  逻辑帧: p.logicFrames,
  纯逻辑推完: p.logicSaturated ? '是' : '否',
  终态校验: p.logicFinalValid ? 'OK' : 'FAIL',
  与参考解一致: p.logicMatchesRef ? 'OK' : 'FAIL',
}))

console.log(`[check] 内置题：${report.puzzles.length} 道`)
if (rows.length) console.table(rows)

console.log(`[check] 自定义题板编解码往返：${report.customRoundtrip ? 'OK' : 'FAIL'}`)
console.log(`[check] 进度存档往返：${report.stateRoundtrip ? 'OK' : 'FAIL'}`)

if (report.errors.length) {
  console.error(`\n[check] 发现 ${report.errors.length} 个问题：`)
  for (const e of report.errors) console.error('  - ' + e)
} else {
  console.log('\n[check] 全部通过 ✔')
}

process.exitCode = report.ok ? 0 : 1
