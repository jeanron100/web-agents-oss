import type { FileChange } from '../types'

export function DiffFile({ change }: { change: FileChange }) {
  return (
    <div className="diff-file">
      <div className="diff-file__head">
        <span className="diff-file__path">{change.path}</span>
        <span className="diff-stat">
          <span className="add">+{change.additions} </span>
          <span className="del">−{change.deletions}</span>
        </span>
      </div>
      <div className="diff-body">
        {change.lines.map((line, i) => (
          <div key={i} className={`diff-line diff-line--${line.kind}`}>
            <span className="diff-line__no">
              {line.kind === 'add' ? `+${line.no}` : line.kind === 'del' ? `−${line.no}` : line.no}
            </span>
            <span className="diff-line__code">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
