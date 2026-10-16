import { useState } from 'react'
import { ACCENTS, THEMES, applyAccent, applyTheme, loadAccent, loadTheme, type AccentId, type ThemeId } from '../lib/theme'

// 色系 + 强调色选择器（设置页）。
//
// 两者正交：色系换中性色，强调色换 --accent。6 × 6 = 36 种组合，都存 localStorage。
// 切换即时生效（改 <html> 上的 data-theme / data-accent，CSS 变量层叠自动重算），
// 不需要重载、不需要后端。

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(loadTheme)
  const [accent, setAccent] = useState<AccentId>(loadAccent)

  const pickTheme = (id: ThemeId) => { applyTheme(id); setTheme(id) }
  const pickAccent = (id: AccentId) => { applyAccent(id); setAccent(id) }

  return (
    <div className="detail-section">
      <div className="dl-title">
        外观
        <span className="dl-title__sub">色系与强调色可自由组合，即时生效，存在本机</span>
      </div>

      <div className="tp__label">色系</div>
      <div className="tp__grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`tp__card ${theme === t.id ? 'tp__card--on' : ''}`}
            onClick={() => pickTheme(t.id)}
            aria-pressed={theme === t.id}
          >
            <span className="tp__swatch" style={{ background: t.swatch[0] }}>
              <span className="tp__chip" style={{ background: t.swatch[1] }} />
              <span className="tp__chip tp__chip--accent" style={{ background: t.swatch[2] }} />
            </span>
            <span className="tp__name">{t.name}</span>
            <span className="tp__desc">{t.desc}</span>
          </button>
        ))}
      </div>

      <div className="tp__label">强调色</div>
      <div className="tp__accents">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            className={`tp__dot ${accent === a.id ? 'tp__dot--on' : ''}`}
            style={{ background: a.color }}
            onClick={() => pickAccent(a.id)}
            title={a.name}
            aria-label={`强调色 ${a.name}`}
            aria-pressed={accent === a.id}
          />
        ))}
      </div>

      <div className="tp__note">
        六态色（运行中 / 等待审批 / 等待输入 / 空闲 / 已完成 / 出错）与引擎双色（Claude 暖 · Codex 冷）
        <b>不随主题改变语义</b>——它们要让你一眼看出「谁在等我」。浅色主题下这些颜色会自动加深，
        以保证在白底上依然可辨。
      </div>
    </div>
  )
}
