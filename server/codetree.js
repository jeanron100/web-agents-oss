// 代码视图（功能3·demo）：实时项目树 + git 状态 + 文件预览。零额外依赖。
// 树来源优先 `git ls-files -co --exclude-standard`（天然按 .gitignore 排除 node_modules/dist），
// 非 git 仓库退回 fs 浅扫；统一再过一道 DENY 顶段黑名单 + 节点上限，契合 .232 内存约束。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { openProjectFile, imageMime, MAX_IMAGE_BYTES } from './file-image.js'

const DENY = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache', '.venv', '.turbo', 'coverage'])

function git(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    // core.quotePath=false：让含中文/特殊字符的路径原样输出（否则被引号包裹，树会裂出幽灵目录）
    execFile('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout))
  })
}

// 非 git 仓库兜底：广度浅扫，遇 DENY 段跳过，受 maxNodes 限制
function walkFs(cwd, maxNodes) {
  const files = []
  const stack = ['']
  while (stack.length && files.length < maxNodes) {
    const rel = stack.shift()
    const abs = rel ? path.join(cwd, rel) : cwd
    let ents = []
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (DENY.has(e.name) || e.name.startsWith('.git')) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push(childRel)
      else if (e.isFile()) { files.push(childRel); if (files.length >= maxNodes) break }
    }
  }
  return files
}

function sortTree(node) {
  if (!node.children) return
  node.children.sort((a, b) =>
    (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  for (const c of node.children) sortTree(c)
}

/** 构建项目树。返回 { root, fileCount, truncated } 或 null（cwd 无效）。 */
export async function buildTree(cwd, { maxNodes = 5000 } = {}) {
  if (!cwd || !fs.existsSync(cwd)) return null
  let files
  const out = await git(cwd, ['ls-files', '-co', '--exclude-standard'])
  files = out != null ? out.split('\n').filter(Boolean) : walkFs(cwd, maxNodes)
  files = files.filter((f) => !f.split('/').some((seg) => DENY.has(seg)))
  let truncated = false
  if (files.length > maxNodes) { files = files.slice(0, maxNodes); truncated = true }

  const root = { name: path.basename(cwd) || cwd, type: 'dir', path: '', children: [] }
  const dirMap = new Map([['', root]])
  const ensureDir = (relDir) => {
    const hit = dirMap.get(relDir)
    if (hit) return hit
    const parentRel = relDir.includes('/') ? relDir.slice(0, relDir.lastIndexOf('/')) : ''
    const parent = ensureDir(parentRel)
    const node = { name: relDir.slice(relDir.lastIndexOf('/') + 1), type: 'dir', path: relDir, children: [] }
    parent.children.push(node)
    dirMap.set(relDir, node)
    return node
  }
  for (const rel of files) {
    const slash = rel.lastIndexOf('/')
    const parent = ensureDir(slash >= 0 ? rel.slice(0, slash) : '')
    parent.children.push({ name: rel.slice(slash + 1), type: 'file', path: rel })
  }
  sortTree(root)
  return { root, fileCount: files.length, truncated }
}

/** 工作区改动 diff（未暂存 + 已暂存 + 未跟踪文件名清单），给 Codex 审核用。截断到 maxBytes。 */
export async function gitDiff(cwd, maxBytes = 60_000) {
  if (!cwd) return { diff: '', files: [], empty: true }
  const [unstaged, staged, untracked] = await Promise.all([
    git(cwd, ['diff', '--stat=200', 'HEAD']),
    git(cwd, ['diff']),
    git(cwd, ['ls-files', '--others', '--exclude-standard']),
  ])
  const stat = unstaged ?? ''
  let diff = staged ?? ''
  // 也带上已暂存的改动
  const cached = await git(cwd, ['diff', '--cached'])
  if (cached) diff += (diff ? '\n' : '') + cached
  const untrackedList = (untracked ?? '').split('\n').filter(Boolean)
  let body = ''
  if (stat.trim()) body += `# 改动概览（git diff --stat HEAD）\n${stat}\n`
  if (untrackedList.length) body += `# 新增未跟踪文件\n${untrackedList.slice(0, 50).join('\n')}\n`
  if (diff.trim()) body += `\n# 详细 diff\n${diff}`
  const truncated = body.length > maxBytes
  return {
    diff: truncated ? body.slice(0, maxBytes) + '\n…（diff 已截断）' : body,
    files: untrackedList,
    empty: !body.trim(),
    truncated,
  }
}

/** 工作区 git 状态：相对路径 -> 两字符状态码（M/A/D/??/...）。非 git 仓库返回 {}。 */
export async function gitStatus(cwd) {
  const map = {}
  const out = await git(cwd, ['status', '--porcelain=v1'])
  if (out == null) return map
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2).trim() || '?'
    let p = line.slice(3)
    if (p.includes(' -> ')) p = p.split(' -> ')[1] // rename: 取目标
    p = p.replace(/^"|"$/g, '')
    map[p] = code
  }
  return map
}

/** 安全读取单文件（防目录穿越 + 体积上限 + 二进制识别）。返回 null=不存在/越界。 */
export function readFileSafe(cwd, rel, maxBytes = 200_000) {
  const file = openProjectFile(cwd, rel)
  if (!file) return null
  const { fd, stat: st } = file
  const len = Math.min(st.size, maxBytes)
  const buf = Buffer.alloc(len)
  try {
    fs.readSync(fd, buf, 0, len, 0)
  } catch { return null } finally { fs.closeSync(fd) }
  const mediaType = imageMime(buf, rel)
  const binary = !!mediaType || buf.includes(0)
  return {
    path: rel,
    size: st.size,
    mtimeMs: st.mtimeMs,
    truncated: st.size > maxBytes,
    binary,
    ...(mediaType ? { imageMime: mediaType, imageMaxBytes: MAX_IMAGE_BYTES } : {}),
    content: binary ? '' : buf.toString('utf8'),
  }
}

/** 安全写：限 cwd 内已存在文本文件，乐观锁(mtime)，原子写(temp+rename)。
 *  → { ok:true, mtimeMs, size } | { ok:false, error, mtimeMs?, size? } */
export function writeFileSafe(cwd, rel, content, { baseMtimeMs, maxBytes = 200_000 } = {}) {
  if (!cwd || !rel) return { ok: false, error: 'path' }
  const base = path.resolve(cwd)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) return { ok: false, error: 'path' } // 越界
  if (typeof content !== 'string') return { ok: false, error: 'path' } // 非字符串内容=非法请求(映射 400)
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, error: 'toolarge' }
  let st
  try { st = fs.statSync(abs) } catch { return { ok: false, error: 'notfound' } }
  if (!st.isFile()) return { ok: false, error: 'notfile' }
  if (baseMtimeMs != null && Math.round(st.mtimeMs) !== Math.round(baseMtimeMs)) {
    return { ok: false, error: 'conflict', mtimeMs: st.mtimeMs, size: st.size } // 乐观锁
  }
  const tmp = `${abs}.wa-tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, abs)
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    return { ok: false, error: 'io' }
  }
  let ns
  try { ns = fs.statSync(abs) } catch { return { ok: false, error: 'io' } }
  return { ok: true, mtimeMs: ns.mtimeMs, size: ns.size }
}
