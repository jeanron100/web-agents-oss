/** 可选 Claude 模型（id ↔ 中文 label），会话头/新建/卡片共用，避免多处漂移。 */
// ⚠️ 模型目录由**本机 claude CLI 版本**决定，不是这份清单说了算（2026-09-23 实测）：
//   CLI 2.1.278 传 `claude-opus-5-5` 直接报
//   「isn't described by this version's model catalog; update Claude Code」，
//   升到 2.1.280 后同一条命令返回 ok。**Agent SDK 未动（0.3.172），不影响。**
//   ⇒ 用户报「怎么没有最新模型」时，第一件事是查 `claude --version` 并升级，
//     不是查清单然后解释「上游没有」（Codex 那次就是这么栽的，CLAUDE.md 记着）。
// ⚠️ id 是**横杠**形式：`claude-opus-5-5` ✅ / `claude-opus-5.5` ✗（后者报 "may not exist"）。
export const CLAUDE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
]

/** Kimi Code 官方客户端模型 ID；ACP 可能把值写成 kimi-code/<id>，驱动会负责归一化。 */
export const KIMI_MODELS: Array<{ id: string; label: string; description: string }> = [
  { id: 'k3', label: 'Kimi K3 · 1M', description: '旗舰编码模型；1M 上下文需对应会员权益' },
  { id: 'k3-256k', label: 'Kimi K3 · 256K', description: '日常开发推荐，配额消耗更低' },
  { id: 'kimi-for-coding', label: 'K2.7 Code', description: '代码补全与常规开发' },
  { id: 'kimi-for-coding-highspeed', label: 'K2.7 HighSpeed', description: '高速输出；需要对应会员权益' },
]

/** 模型 id → 展示 label；未知 id 原样返回（如 Codex 的 gpt-5.5 或已存的 pretty 名） */
export function modelLabel(id: string): string {
  const bare = id.replace(/^kimi-code\//, '')
  return CLAUDE_MODELS.find((m) => m.id === id)?.label
    ?? KIMI_MODELS.find((m) => m.id === bare)?.label
    ?? id
}
