/* 自动生成，勿手改。运行 npm run gen 重新生成。 */
export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  /** 题面编码串（格式由 src/game/puzzles.ts 解析） */
  board: string
  /** 参考解编码串（没有则留空） */
  solution?: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "shakashaka-6x6-01", name: "初见留白", width: 6, height: 6, difficulty: "easy", series: "入门", board: ".1.0...1.001....1.10.0.2....1..0...1", solution: "1#0#003#0###0030#2##0#0#1030#20#020#" },
  { id: "shakashaka-6x6-02", name: "方寸之间", width: 6, height: 6, difficulty: "easy", series: "入门", board: "2..2......20111.1....10.100.0......0", solution: "#20#103402#####4#0000##0###0#030020#" },
  { id: "shakashaka-7x7-01", name: "折角回廊", width: 7, height: 7, difficulty: "medium", series: "进阶", board: "2..0....2.1.10..1..0.01.2.....2.1..11..1.....0..0", solution: "#20#0003#0#3##00#00#0##1#30100#0#03##10#40100#00#" },
  { id: "shakashaka-8x8-01", name: "白墙花窗", width: 8, height: 8, difficulty: "medium", series: "进阶", board: "01.1.1.....1..2..1.0...1.1.2..11.0...01.0.0.1......1....0.00.2.1", solution: "##3#0#04001#04#01#0#023#3#0#30##0#040##4#0#0#002020#1230#0##0#1#" },
  { id: "shakashaka-8x8-02", name: "庭院深深", width: 8, height: 8, difficulty: "hard", series: "挑战", board: "...00.1..1.1.1.1.1.1.1...0...0..00.2.1.2....21..1..1...1.1.0.2..", solution: "100##0#00#1#0#1#1#0#0#300#020#02##0#1#0#0010##02#20#120#0#0#0#10" },
  { id: "shakashaka-9x9-01", name: "光影交错", width: 9, height: 9, difficulty: "hard", series: "挑战", board: "0..0.2..1.100.....1..1.2000........0.2..0100.1..0....0..1..3.1.0.0...2.....0..0.1", solution: "#00#0#34#0###04000#20#0####00120400#1#30####0#00#0000#02#01#3#0#0#034#03020#00#0#" },
]
