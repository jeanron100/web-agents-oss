// 色系（主题）与强调色。
//
// 两者**正交**：色系换的是中性色（底/面板/边框/文字），强调色换的是 --accent。
// 六套色系 × 六种强调色 = 36 种组合，都持久化在 localStorage。
//
// ⚠️ 语义色（六态 / 引擎双色 / 待办四色）**不归主题管**——它们是协议的一部分，
// 用户一眼要能看出"谁在等我"。主题只能调它们的**明度**以适配底色（见 global.css 里
// light 主题把所有语义色加深了一档：给深底设计的亮色放白底上几乎不可见）。
//
// 防闪烁：index.html 里有一段内联脚本，在 CSS 生效**之前**就把 data-theme/data-accent
// 写到 <html> 上。放在 React 里做会先闪一帧默认色。

export type ThemeId = 'default' | 'graphite' | 'midnight' | 'sepia' | 'contrast' | 'light'
export type AccentId = 'blue' | 'violet' | 'teal' | 'rose' | 'amber' | 'lime'

export const THEMES: Array<{ id: ThemeId; name: string; desc: string; swatch: [string, string, string] }> = [
  { id: 'default', name: '深空', desc: '默认。冷调深蓝灰', swatch: ['#0b0f14', '#1a2230', '#2dd4a7'] },
  { id: 'graphite', name: '石墨', desc: '纯中性灰，去蓝调', swatch: ['#0d0d0e', '#1f1f21', '#2dd4a7'] },
  { id: 'midnight', name: '午夜', desc: '深靛蓝，对比更强', swatch: ['#070b18', '#151d38', '#6366f1'] },
  { id: 'sepia', name: '暖褐', desc: '低色温，夜间护眼', swatch: ['#14100c', '#2a2117', '#d99a4e'] },
  { id: 'contrast', name: '高对比', desc: '强光下 / 无障碍', swatch: ['#000000', '#1a1a1a', '#4ade80'] },
  { id: 'light', name: '浅色', desc: '白底。语义色已加深', swatch: ['#f7f8fa', '#e7eaef', '#0d9488'] },
]

export const ACCENTS: Array<{ id: AccentId; name: string; color: string }> = [
  { id: 'blue', name: '蓝', color: '#3b82f6' },
  { id: 'violet', name: '紫', color: '#8b5cf6' },
  { id: 'teal', name: '青', color: '#14b8a6' },
  { id: 'rose', name: '玫', color: '#f43f5e' },
  { id: 'amber', name: '琥珀', color: '#f59e0b' },
  { id: 'lime', name: '柠', color: '#84cc16' },
]

const THEME_KEY = 'agent-console-theme'
const ACCENT_KEY = 'agent-console-accent'

const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v)
const isAccent = (v: unknown): v is AccentId => ACCENTS.some((a) => a.id === v)

export function loadTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return isTheme(v) ? v : 'default'
  } catch { return 'default' }
}
export function loadAccent(): AccentId {
  try {
    const v = localStorage.getItem(ACCENT_KEY)
    return isAccent(v) ? v : 'blue'
  } catch { return 'blue' }
}

export function applyTheme(id: ThemeId): void {
  const el = document.documentElement
  if (id === 'default') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', id)
  try { localStorage.setItem(THEME_KEY, id) } catch { /* 私密模式 */ }
  // PWA 状态栏/地址栏跟着变，否则浅色主题下顶部还是一条黑边
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', getComputedStyle(el).getPropertyValue('--bg').trim() || '#0b0f14')
}

export function applyAccent(id: AccentId): void {
  const el = document.documentElement
  if (id === 'blue') el.removeAttribute('data-accent')
  else el.setAttribute('data-accent', id)
  try { localStorage.setItem(ACCENT_KEY, id) } catch { /* 私密模式 */ }
}
