/**
 * 留方（Shakashaka）题库生成配置
 *
 * 真正的生成逻辑在 src/game/generator.ts。Node 24 原生支持直接 import .ts
 * （type stripping），因此这里不需要额外编译步骤。
 */

import { generatePuzzles as generate } from '../src/game/generator.ts'

export const NAME = '留方生成器'

export function generatePuzzles() {
  return generate()
}
