// server/event-redaction.js — 统一脱敏边界（db-redis-mongo-phase1 / P0）
//
// 铁律：写任何数据库之前，在这一处脱敏一次；不要让各下游各自脱敏（漏一个就泄露）。
// 默认绝不进库：完整 Prompt/回答正文、.env 内容、Token/Cookie/密码/私钥、完整 Bash 参数、
// 终端输出、文件正文/图片二进制。允许进库：工具名、状态、耗时、退出码、项目内相对路径、
// 错误分类与截断脱敏摘要、Token/成本统计、审批类型与结果。纯函数、零依赖、可单测。

// 这些字段名一旦出现，整段丢弃（不是脱敏是删除）——它们本就不该进库。
const FORBIDDEN_KEYS = new Set([
  'prompt', 'text', 'content', 'message', 'answer', 'reply',
  'output', 'stdout', 'stderr', 'terminal',
  'command', 'cmd', 'args', 'argv',
  'env', 'dotenv', 'image', 'images', 'bytes', 'base64', 'buffer',
])

const MAX_STR = 500 // 允许留存的字符串一律截断，杜绝正文夹带

/** 对单个字符串做敏感串脱敏（token/cookie/密码/连接串/私钥/.env 行/Bearer 等）。 */
export function redactString(s) {
  if (typeof s !== 'string') return s
  let out = s
    // 私钥块
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '***PRIVATE_KEY***')
    // Authorization: Bearer/Basic <token>
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{6,}/gi, '$1 ***')
    // 常见 API key 前缀
    .replace(/\bsk-[A-Za-z0-9._-]{10,}/g, 'sk-***')
    .replace(/\bghp_[A-Za-z0-9]{10,}/g, 'ghp_***')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox-***')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, 'AKIA***')
    // Cookie: 行
    .replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, '$1: ***')
    // key=value / key: value 形式的密码/令牌（引号可选）
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key)\s*[=:]\s*)(["']?)[^\s"';,)]+\2/gi, '$1***')
    // 连接串里的 user:pass@host（redis://:pass@ 、mongodb://u:p@ 、mysql://u:p@ …）
    .replace(/([a-z][a-z0-9+.\-]*:\/\/[^\s:/@]*:)[^@\s/]+(@)/gi, '$1***$2')
    // .env 风格：以大写 secret-ish key 打头的整行赋值
    .replace(/^(\s*[A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|PWD|CRED|APIKEY)[A-Z0-9_]*\s*=\s*).+$/gm, '$1***')
  if (out.length > MAX_STR) out = out.slice(0, MAX_STR) + '…'
  return out
}

// 递归脱敏任意值：对象丢弃禁用字段名 + 脱敏其余字符串；数组逐项；字符串走 redactString。
function redactValue(v, depth = 0) {
  if (depth > 6) return null // 防御超深/环
  if (typeof v === 'string') return redactString(v)
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, depth + 1))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue // 整段丢弃
      out[k] = redactValue(val, depth + 1)
    }
    return out
  }
  return v // number/boolean/null 原样
}

/**
 * 对统一信封做脱敏，返回可安全入库的信封（不改原对象）。
 * - payload 递归脱敏 + 丢弃禁用字段；
 * - 打上 privacy.redacted=true、containsPrompt=false。
 */
export function redactEvent(env) {
  const payload = redactValue(env?.payload ?? {}, 0)
  return {
    ...env,
    payload,
    privacy: { redacted: true, containsPrompt: false },
  }
}
