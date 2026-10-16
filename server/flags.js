// server/flags.js — WebAgents 2.0 数据库层特性开关（db-redis-mongo-phase1 / P0）
//
// 三个开关默认全 0：不装 redis/mongodb 包、不连库、不影响现有主流程。影子写优先——
// 先只写不读、验证无回归，再逐步让 UI 读 Mongo。任何阶段回滚只需把对应开关置 0。
//
//   WA_REDIS_ENABLED       Redis 协调层（心跳/租约/幂等/通知去重）总开关
//   WA_MONGO_ENABLED       MongoDB 历史投影总开关
//   WA_EVENT_SHADOW_WRITE  事件影子写（normalize→redact→写库）总开关；需与上面配合
//
// 约定：只认字符串 '1' 为开；其余（含未设置）一律关。集中在此，避免各处各读各的 env。

const on = (v) => v === '1' || v === 'true'

export const flags = {
  redisEnabled: () => on(process.env.WA_REDIS_ENABLED),
  mongoEnabled: () => on(process.env.WA_MONGO_ENABLED),
  eventShadowWrite: () => on(process.env.WA_EVENT_SHADOW_WRITE),
  /** 便于 /api/v2/health 一次性回报 */
  snapshot: () => ({
    WA_REDIS_ENABLED: on(process.env.WA_REDIS_ENABLED),
    WA_MONGO_ENABLED: on(process.env.WA_MONGO_ENABLED),
    WA_EVENT_SHADOW_WRITE: on(process.env.WA_EVENT_SHADOW_WRITE),
  }),
}
