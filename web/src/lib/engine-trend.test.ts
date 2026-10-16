import { expect, it } from 'vitest'
import { engineTrend, tokenPath, usageEngines } from './engine-trend'

it('有引擎拆分才显示对应历史，无法归属的旧记录留空', () => {
  const points = engineTrend([{date:'1'}, {date:'2',byEngine:{codex:20,kimi:5,claude:900}}, {date:'3',byEngine:{}}], 3)
  expect(points).toEqual([{date:'1',codex:null,kimi:null,claude:null},{date:'2',codex:20,kimi:5,claude:900},{date:'3',codex:0,kimi:0,claude:0}])
  expect(engineTrend([{date:'1'},{date:'2'}], 1)).toHaveLength(1)
})
it('显示真实存在的引擎，保持 Codex/Kimi/Claude 顺序，不把缺失当成数据', () => {
  expect(usageEngines([{ date: '1', byEngine: { claude: 10, codex: 0 } }])).toEqual(['codex', 'claude'])
  expect(usageEngines([{ date: '1' }, { date: '2', byEngine: { kimi: NaN } }])).toEqual([])
})
it('缺测处断开曲线，真实零值仍在坐标中', () => {
  expect(tokenPath([10,null,0],20)).toBe('M64.0,114.0 M672.0,194.0')
  expect(tokenPath([0],1)).toBe('M368.0,194.0')
})
