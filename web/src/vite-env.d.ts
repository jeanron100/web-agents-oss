/// <reference types="vite/client" />

// 对外 Demo 构建开关：`VITE_DEMO=1 npm run build` → 前端恒 mock、永不触碰 /api。
// （demo 站点与真管控台同域，/api/* 就是真 Hub——这个开关是防止真数据被公开展示的安全闸。）
interface ImportMetaEnv {
  readonly VITE_DEMO?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

