import type { Engine } from '../types'

export const engineName: Record<Engine, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' }

export function EngineBadge({ engine, model }: { engine: Engine; model?: string }) {
  return (
    <span className={`engine-badge engine-badge--${engine}`}>
      {engineName[engine]}
      {model ? ` · ${model}` : ''}
    </span>
  )
}
