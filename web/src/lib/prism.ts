import Prism from 'prismjs'
// 按依赖顺序导入语言（tsx 依赖 jsx+typescript；它们依赖 clike/markup）
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-sql'

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'css', html: 'markup', xml: 'markup', vue: 'markup',
  md: 'markdown', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
}

export function highlight(code: string, ext: string): string {
  const lang = BY_EXT[ext]
  const grammar = lang ? Prism.languages[lang] : null
  if (!grammar) return code.replace(/&/g, '&amp;').replace(/</g, '&lt;') // 无高亮也要转义
  return Prism.highlight(code, grammar, lang)
}
