// Coalesce a short burst into one bounded tmux command and serialize commands.
// Concurrent send-keys processes can reorder keystrokes; huge pastes exceed ARG_MAX.
export function createTerminalInputQueue(send, { delayMs = 8, chunkBytes = 4096, maxBytes = 1024 * 1024, onError = () => {} } = {}) {
  let pending = Buffer.alloc(0), timer = null, busy = false, closed = false
  const schedule = () => {
    if (!closed && !busy && !timer && pending.length) timer = setTimeout(flush, delayMs)
  }
  const flush = () => {
    timer = null
    if (closed || busy || !pending.length) return
    const chunk = pending.subarray(0, chunkBytes)
    pending = pending.subarray(chunk.length)
    busy = true
    send(chunk, (error) => {
      busy = false
      if (error && !closed) onError(error)
      schedule()
    })
  }
  return {
    push(text) {
      if (closed) return false
      const bytes = Buffer.from(text, 'utf8')
      if (pending.length + bytes.length > maxBytes) { onError(new Error('输入过长，请分段粘贴')); return false }
      pending = Buffer.concat([pending, bytes]); schedule(); return true
    },
    close() { closed = true; clearTimeout(timer); timer = null; pending = Buffer.alloc(0) },
  }
}
