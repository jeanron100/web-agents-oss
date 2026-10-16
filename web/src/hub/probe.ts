/**
 * 数据源探测的判据与阈值。抽出来是为了能单测——这两个值各自踩过一次线上坑。
 */

/**
 * 探测超时。
 *
 * ⚠️ 别调小。2026-08-01 实测公网 `/api/state`（带 cookie，80KB 载荷）：3.96s / 2.34s / 2.34s。
 * 旧值 2500ms 正落在这个区间中间 ⇒ 冷加载**抛硬币**：超时就回退 mock，于是用户点进任何真实
 * 会话都显示「会话不存在或已结束」。这不是偶发——是每次打开都有相当概率中招。
 */
export const HUB_PROBE_TIMEOUT_MS = 8000

/**
 * 「真 Hub 可达」的判据：**必须是 2xx 且响应体是 JSON**。
 *
 * ⚠️ 不能只看 `res.ok`。`vite dev` 未配 proxy 时，Vite 的 SPA fallback 对**通配 Accept**
 * （浏览器 fetch 的默认值，星号斜杠星号）同样兜底 ⇒ `GET /api/state` 返回 **200 + index.html**。
 * 旧判据于是为真 → 选中 ApiHubClient → 之后每 3s 在 HTML 上 `res.json()` 抛错、被空 catch 吞掉
 * → store 永远是空的 → **一块空白看板，且永远不会自我修复**（mock 升级探测器只在 mock 态才启动）。
 * 同一个洞在 nginx 未配 /api 反代时也成立。
 */
export function isLiveHubResponse(res: { ok: boolean; headers: { get(name: string): string | null } }): boolean {
  if (!res.ok) return false
  return (res.headers.get('content-type') ?? '').includes('json')
}
