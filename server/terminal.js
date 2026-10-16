import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { createTerminalInputQueue } from './terminal-input.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}
// server→client 帧（不掩码）。opcode: 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong
export function encodeFrame(payload, opcode = 0x2) {
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([header, payload])
}
// 增量解析 client→server（掩码）帧。返回 {frames:[{opcode,payload}], rest:Buffer}
export function decodeFrames(buf) {
  const MAX_FRAME = 8 * 1024 * 1024
  const frames = []
  let off = 0
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1]
    const opcode = b0 & 0x0f, masked = b1 & 0x80
    let len = b1 & 0x7f, p = off + 2
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
    if (len > MAX_FRAME) throw new Error('ws frame too large')
    if (!masked) throw new Error('unmasked client frame')
    const maskLen = 4
    if (p + maskLen + len > buf.length) break
    let payload = buf.subarray(p + maskLen, p + maskLen + len)
    { const m = buf.subarray(p, p + 4); const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3]; payload = out }
    frames.push({ opcode, payload })
    off = p + maskLen + len
  }
  return { frames, rest: buf.subarray(off) }
}

const sessions = new Map() // termId -> TermSession
// 空闲回收窗：从 30min 放宽到 24h——「持久终端」不该动不动就把用户几小时前建的会话清掉（用户报「会话突然没了很奇怪」）。
// 且只清「真正被遗弃」的：保留/有前台程序在跑/有人正连着看 的一律不清（见回收循环）。要清得快可设 WT_IDLE_MS。
const IDLE_MS = Number(process.env.WT_IDLE_MS ?? 24 * 60 * 60_000)
const MAX_TERMS = Number(process.env.WT_MAX ?? 8)
// 专用 tmux socket：所有终端会话跑在这个 socket 的 server 上，且该 server 经 systemd-run 起在 agent
// 的 cgroup 之外 → agent 重启（部署/崩溃/重启）不会连带 SIGKILL 掉 tmux server，会话真正持久（复用/长跑不丢）。
// （历史坑：默认 socket 的 server 由 agent execFile 起、落在 web-agents-agent.service cgroup 内，
//  KillMode=control-group 一重启就整锅端，用户「保留」的会话刷新即消失。）
const SOCK = process.env.WT_TMUX_SOCK || 'web-agents'
const tx = (args, cb) => execFile('tmux', ['-L', SOCK, ...args], { timeout: 5000 }, cb)
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', '-bash', '-zsh', '-sh'])

// pane_current_command 只看前台命令。`long-job &` 回到 shell 提示符后它会变回 bash，旧回收逻辑
// 因而会在 24h 后误杀仍有后台任务的会话。tmux pane_pid 是该 shell；检查其 /proc 子进程即可覆盖
// shell job（前台/后台）且不依赖命令名白名单。读取失败时返回 false，仍由 keep/viewer/前台信号兜底。
export function hasDescendantProcess(pid, procRoot = '/proc') {
  const root = Number(pid)
  if (!Number.isInteger(root) || root <= 0) return false
  try {
    return fs.readFileSync(`${procRoot}/${root}/task/${root}/children`, 'utf8')
      .trim().split(/\s+/).filter(Boolean).map(Number)
      .some((child) => Number.isInteger(child) && child > 0)
  } catch { return false }
}

/** Aggregate every pane/window in a tmux session; one live pane protects the whole session. */
export function protectedTerminalSessions(paneRows, procRoot = '/proc') {
  const protectedNames = new Set()
  for (const line of String(paneRows || '').split('\n')) {
    if (!line) continue
    const [name, cmd, panePid] = line.split('\x1f')
    if (!name?.startsWith('wt-')) continue
    if ((cmd && !SHELLS.has(cmd)) || hasDescendantProcess(panePid, procRoot)) protectedNames.add(name)
  }
  return protectedNames
}
// 幂等确保专用 tmux server 存在且在 agent cgroup 之外：systemd-run 放进 PID1 名下瞬时单元 +
// KillMode=process（单元停也不杀 server）+ __wa_keep__ 保活会话让 server 常驻。非 systemd 环境退回直接起。
let tmuxServerReady = null
function ensureTmuxServer() {
  if (tmuxServerReady) return tmuxServerReady
  tmuxServerReady = new Promise((resolve) => {
    tx(['has-session', '-t', '__wa_keep__'], (err) => {
      if (!err) return resolve() // server 已在（含保活会话）
      execFile('systemd-run', ['--collect', '--property=KillMode=process',
        'tmux', '-L', SOCK, 'new-session', '-d', '-s', '__wa_keep__', 'tail', '-f', '/dev/null'], () => {
        tx(['has-session', '-t', '__wa_keep__'], (e2) => {
          if (!e2) return resolve()
          // systemd-run 不可用 → 退回直接起（会落在 agent cgroup 内、重启会丢，但至少能用）
          tx(['new-session', '-d', '-s', '__wa_keep__', 'tail', '-f', '/dev/null'], () => resolve())
        })
      })
    })
  })
  return tmuxServerReady
}
// 统一的空闲回收（Map 内 + agent 重启遗留的孤儿一起管，用 tmux 为权威源）。只清「真正被遗弃」的会话：
//   · @keep 保留 → 永不清；
//   · 前台程序或 shell 后台 job 在跑 → 永不清；
//   · 有 web 端正连着看(viewer>0) → 不清；
// 其余 bare-shell 空闲超 IDLE_MS(默认 24h) 才回收。这样「survive 重启的会话 30min 后被孤儿回收误杀」不再发生。
const reclaimTimer = setInterval(() => {
  const now = Date.now()
  // 僵尸探测：Map 内会话对应的 tmux 会话已不在（外部 kill/崩溃）→ 回收，兜底 fifo end/err 未触发
  for (const s of sessions.values()) tx(['has-session', '-t', s.name], (err) => { if (err) s.close() })
  tx(['list-panes', '-a', '-F', '#{session_name}\x1f#{pane_current_command}\x1f#{pane_pid}'], (paneErr, paneOut) => {
    if (paneErr) return // 判活数据取不到时 fail-safe：本轮不回收
    const protectedNames = protectedTerminalSessions(paneOut)
    tx(['list-sessions', '-F', '#{session_name}\x1f#{session_activity}\x1f#{@keep}'], (err, out) => {
      if (err || !out) return
      for (const line of out.split('\n')) {
        if (!line) continue
        const [name, activity, keep] = line.split('\x1f')
        if (!name?.startsWith('wt-')) continue
        if (keep === '1') continue                  // 保留：永不回收
        if (protectedNames.has(name)) continue      // 任一 pane 有前台程序或后台 job：保护整个 session
        const s = sessions.get(name.slice(3))
        if (s && s.subs.size > 0) continue          // 有人正连着看：不回收
        if (now - (Number(activity) * 1000 || 0) > IDLE_MS) { if (s) s.close(); else tx(['kill-session', '-t', name], () => {}) }
      }
    })
  })
}, 60_000)
reclaimTimer.unref?.()

// 列出本机所有 web 终端 tmux 会话（wt-*）。tmux 是权威源：即便 agent 重启丢了内存 Map，会话仍在 tmux 里，
// 故直接查 tmux，能列出「上次留下的、可复用」的会话。label/keep 存 tmux 用户选项（@label/@keep）→ 跨 agent 重启持久。
export function listTermSessions() {
  return new Promise((resolve) => {
    // 字段用 \x1f(单元分隔符)分隔，不用 \t——cwd/pane_current_path 里可能真含制表符会撑破解析（复核 CONFIRMED）；
    // label 已在 setTermMeta 去除 \x00-\x1f，cwd 含 \x1f 几乎不可能。
    const FMT = '#{session_name}\x1f#{session_created}\x1f#{session_activity}\x1f#{session_attached}\x1f#{pane_current_path}\x1f#{pane_current_command}\x1f#{@label}\x1f#{@keep}'
    tx(['list-sessions', '-F', FMT], (err, out) => {
      if (err || !out) return resolve([])
      const list = []
      for (const line of out.split('\n')) {
        if (!line) continue
        const [name, created, activity, attached, cwd, cmd, label, keep] = line.split('\x1f')
        if (!name?.startsWith('wt-')) continue
        const termId = name.slice(3)
        const s = sessions.get(termId)
        list.push({
          termId,
          label: label || '',
          created: Number(created) * 1000 || 0,
          activity: Number(activity) * 1000 || 0,
          cwd: cwd || '',
          command: cmd || '',
          running: !!cmd && !SHELLS.has(cmd), // 非 shell = 有程序在前台跑（长任务）
          viewers: s ? s.subs.size : 0,        // 当前 web 端连着的观看者数
          keep: keep === '1',
        })
      }
      // 最近活动的排前面
      list.sort((a, b) => b.activity - a.activity)
      resolve(list)
    })
  })
}

// termId 合法性：与 WS 握手同一套字符集，挡住可能匹配到别的 tmux 目标或含控制字符的输入。
const VALID_TERMID = /^[A-Za-z0-9_-]{1,64}$/

// 设置会话元数据（重命名 / 保留开关）。写 tmux 用户选项（持久）+ 同步内存 keep（回收循环即时生效）。
export function setTermMeta(termId, { label, keep } = {}) {
  return new Promise((resolve) => {
    if (!VALID_TERMID.test(termId)) return resolve(false)
    const name = 'wt-' + termId
    tx(['has-session', '-t', name], (err) => {
      if (err) return resolve(false)
      const ops = []
      // 去掉制表/换行/控制字符——它们会破坏 listTermSessions 的 \t 分隔解析（label 里塞 \t 会错位）。
      if (typeof label === 'string') ops.push(['set-option', '-t', name, '@label', label.replace(/[\t\r\n\x00-\x1f]/g, ' ').slice(0, 40)])
      if (typeof keep === 'boolean') ops.push(['set-option', '-t', name, '@keep', keep ? '1' : '0'])
      const s = sessions.get(termId)
      if (s && typeof keep === 'boolean') { s.keep = keep; s.keepSet = true }
      let pending = ops.length
      if (!pending) return resolve(true)
      for (const args of ops) tx(args, () => { if (--pending === 0) resolve(true) })
    })
  })
}

// 显式删除一个终端会话（picker 里的「删除」）。
export function killTermSession(termId) {
  return new Promise((resolve) => {
    if (!VALID_TERMID.test(termId)) return resolve(false)
    const name = 'wt-' + termId
    const s = sessions.get(termId)
    if (s) { s.close(); return resolve(true) }
    // 不在内存 Map（agent 重启后遗留的 tmux 会话）→ 直接 kill tmux
    tx(['kill-session', '-t', name], (err) => resolve(!err))
  })
}
let seq = 0
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'" // shell 单引号转义
const TERM_AUDIT = process.env.WT_AUDIT ?? '/tmp/web-agents-term-audit.log'
const audit = (line) => { try { fs.appendFileSync(TERM_AUDIT, `${new Date().toISOString()} ${line}\n`) } catch {} }

class TermSession {
  constructor(termId, cwd, cols, rows) {
    this.id = termId; this.cols = cols; this.rows = rows
    this.name = 'wt-' + termId
    this.fifo = `/tmp/${this.name}.fifo`
    this.subs = new Set() // sockets
    this.ready = new Promise((resolve) => { this.markReady = resolve })
    this.inputQueue = createTerminalInputQueue((bytes, done) => {
      this.ready.then(() => {
        if (this.closed) return done()
        tx(['send-keys', '-t', this.name, '-H', ...bytes.toString('hex').match(/../g)], done)
      })
    }, { onError: (error) => {
      for (const sock of this.subs) if (!sock.destroyed) sock.write(encodeFrame(Buffer.from(`\r\n[终端输入失败：${error.message}]\r\n`)))
    } })
    this.lastActive = Date.now()
    this.keep = false // 「保留」标记：豁免空闲回收（长跑任务用）
    this.keepSet = false // 用户是否已显式设过 keep——设过就别让下面异步的 @keep 回读把它覆盖回去（复核 CONFIRMED 的竞态）
    audit(`open ${termId} cwd=${cwd || os.homedir()}`)
    try { fs.unlinkSync(this.fifo) } catch {}
    // 先确保专用 tmux server 就绪（在 agent cgroup 之外）——否则 new-session 会把 server 起在 agent
    // cgroup 内、重启即丢。就绪后再 mkfifo + 建/复用会话。
    ensureTmuxServer().then(() => execFile('mkfifo', [this.fifo], () => {
      // 起 detached tmux 会话（-x/-y 定尺寸，-c 定 cwd）；若同名会话已存在（复用上次遗留的）则 new-session
      // 失败被忽略，下面 pipe-pane 直接接到既有会话，实现「复用原会话」。再把 pane 输出接到 fifo。
      tx(['new-session', '-d', '-s', this.name, '-x', String(cols), '-y', String(rows), '-c', cwd || os.homedir()], () => {
        // 复用既有会话时恢复其 @keep 标记（跨 agent 重启保留「保留」态）
        tx(['display-message', '-t', this.name, '-p', '#{@keep}'], (e, v) => { if (!e && !this.keepSet && String(v).trim() === '1') this.keep = true })
        tx(['set-option', '-t', this.name, 'window-size', 'manual'], () => {
          // 复用既有会话：pane 可能还是上次的尺寸，强制 resize 到本次客户端尺寸，满屏程序(top/vim)才能按当前
          // xterm 尺寸重绘、与随后 capture-pane 快照对齐；新建会话 new-session 已按 -x/-y 建好，此处等价 noop。
          tx(['resize-window', '-t', this.name, '-x', String(cols), '-y', String(rows)], () => {})
        })
        // ⚠️ 不加 -o：agent 重启后复用存活的会话时，旧 pipe-pane 可能还连着已失效的 fifo，-o「已在管就啥都不做」
        // 会导致新 fifo 收不到输出→终端空白。不加 -o = 关掉旧管、重开到新 fifo，复用才有实时输出。
        tx(['pipe-pane', '-t', this.name, `cat > ${shq(this.fifo)}`], () => {
          // 持久打开 fifo 读端 → 广播给当前订阅者（重连不重放历史）
          this.reader = fs.createReadStream(this.fifo)
          this.reader.on('data', (chunk) => {
            this.lastActive = Date.now()
            const frame = encodeFrame(chunk, 0x2)
            for (const s of this.subs) {
              // A stalled viewer must not accumulate unbounded output or stall other viewers.
              if (s.writableLength > 1024 * 1024) { s.destroy(); continue }
              if (!s.destroyed) s.write(frame)
            }
          })
          // pane 死亡（shell 退出 / 外部 kill-session）→ pipe-pane 的 cat 关闭 → fifo EOF/err →
          // 回收本会话（否则内存 Map 残留僵尸，占满并发上限致终端不可用）
          this.reader.on('end', () => this.close())
          this.reader.on('error', () => this.close())
          this.markReady()
        })
      })
    }))
  }
  input(str) {
    this.lastActive = Date.now()
    if (/[\r\n]/.test(str)) audit(`in ${this.id} ${str.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
    this.inputQueue.push(str)
  }
  resize(cols, rows) {
    cols = Math.max(2, Math.min(500, Math.floor(cols)))
    rows = Math.max(2, Math.min(300, Math.floor(rows)))
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || (cols === this.cols && rows === this.rows)) return
    this.cols = cols; this.rows = rows
    tx(['resize-window', '-t', this.name, '-x', String(cols), '-y', String(rows)], () => {})
  }
  snapshot(sock) {
    // ⚠️ capture-pane -p 以 LF(\n) 连接各行，直接写进 xterm 会「只下移不回车」→ 多行快照阶梯式错位
    //（复用带 top/vim 等满屏程序的会话时整屏乱码）。必须把 \n 规范成 \r\n。单行提示符看不出，多行才暴露。
    tx(['capture-pane', '-p', '-e', '-t', this.name], (e, out) => {
      if (!e && out) sock.write(encodeFrame(Buffer.from(out.replace(/\r?\n/g, '\r\n'), 'utf8'), 0x2))
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.inputQueue.close()
    this.markReady()
    audit(`close ${this.id}`)
    try { this.reader?.destroy() } catch {}
    tx(['kill-session', '-t', this.name], () => {})
    try { fs.unlinkSync(this.fifo) } catch {}
    for (const s of this.subs) { try { s.end() } catch {} }
    sessions.delete(this.id)
  }
}

export function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/api/term/ws') { socket.destroy(); return }
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  socket.setNoDelay(true)
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n')
  const cols = Math.max(2, Math.min(500, +url.searchParams.get('cols') || 80))
  const rows = Math.max(2, Math.min(300, +url.searchParams.get('rows') || 24))
  const cwd = url.searchParams.get('cwd') || os.homedir()
  let termId = url.searchParams.get('term') || `t-${Date.now().toString(36)}-${seq++}`
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(termId)) { try { socket.end() } catch {} ; return }
  let sess = sessions.get(termId)
  if (!sess && sessions.size >= MAX_TERMS) {
    socket.write(encodeFrame(Buffer.from(`\r\n[已达并发上限 ${MAX_TERMS}，请关闭其他终端后重试]\r\n`), 0x2))
    setTimeout(() => { try { socket.end() } catch {} }, 50); return
  }
  if (!sess) { sess = new TermSession(termId, cwd, cols, rows); sessions.set(termId, sess) }
  sess.subs.add(socket)
  sess.ready.then(() => { if (!sess.closed && !socket.destroyed) sess.snapshot(socket) })
  let buf = Buffer.alloc(0)
  const feed = (chunk) => {
    try {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = decodeFrames(buf); buf = rest
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(); return }
        if (f.opcode === 0x9) { socket.write(encodeFrame(f.payload, 0xA)); continue } // ping→pong
        if (f.opcode === 0x1 || f.opcode === 0x2) {
          const msg = f.payload.toString('utf8')
          if (msg[0] === 'i') sess.input(msg.slice(1))
          else if (/^p\d{1,16}$/.test(msg)) socket.write(encodeFrame(Buffer.from(msg), 0x1))
          else if (msg[0] === 'r') { const [c, r] = msg.slice(1).split(',').map(Number); if (c && r) sess.resize(c, r) }
          else if (msg[0] === 'x') sess.close()
        }
      }
    } catch { try { socket.end() } catch {}; sess.subs.delete(socket) }
  }
  if (head && head.length) feed(head)
  socket.on('data', feed)
  const drop = () => { sess.subs.delete(socket) }
  socket.on('close', drop); socket.on('error', drop)
}
