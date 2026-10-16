import { expect, it } from 'vitest'
import { orderServers } from './server-order'
it('有项目先显示，232 后是 34，其余稳定排序且不改原数组', () => {
  const servers = ['srv-177-42', 'srv-189-4', 'srv-185-34', 'srv-178-232'].map((id) => ({ id }))
  const before = [...servers]
  const sessions = ['srv-177-42', 'srv-185-34', 'srv-178-232'].map((serverId) => ({ serverId }))
  expect(orderServers(servers, sessions).map((s) => s.id)).toEqual(['srv-178-232', 'srv-185-34', 'srv-177-42', 'srv-189-4'])
  expect(servers).toEqual(before)
  expect(orderServers(servers, [{ serverId: 'srv-189-4' }])[0].id).toBe('srv-189-4')
})
