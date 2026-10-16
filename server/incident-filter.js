// 重启事件簿的删除条件。纯函数，单测见 incident-filter.test.mjs。
//
// ⚠️ 这是**破坏性**操作。条件写错的代价不对称：
// 事件簿里「重启当时被 SIGKILL 波及了哪些会话」那份名单，**事后再也拿不到**
// （重启后那些平台会话早就不在列表里了，只能靠重启前那一拍的轮询缓存抓下来）。
// 它是本项目最痛那类事故（重启把正在跑的回合拦腰截断）的唯一复盘依据。
// 所以「只清无影响记录」必须严格只匹配空名单——**宁可漏删，不可错删**。
//
// 为什么「无影响」的记录值得清：例行部署每次都产生一条，9 天攒了 45 条，其中绝大多数
// 是「无会话受影响」的噪声，把真正有价值的那几条淹没了。

const KIND = 'agent.restart'

/** 该记录是否「没有波及任何会话」。字段缺失（老记录）与 null 都算无影响。 */
export function isNoImpact(doc) {
  const k = doc?.killedSessions
  return !Array.isArray(k) || k.length === 0
}

/**
 * 删除条件。
 * @param onlyEmpty true=只删无影响的噪声；false=全清
 *
 * 两个都必须锁定 kind：这个集合里还有 agent 上下线等别的状态事件，
 * 不锁 kind 会把它们一起删掉。
 */
export function restartDeleteFilter(onlyEmpty) {
  if (!onlyEmpty) return { kind: KIND }
  return {
    kind: KIND,
    $or: [
      { killedSessions: { $exists: false } }, // 老记录压根没这个字段
      { killedSessions: { $size: 0 } },       // 空数组
    ],
  }
}
