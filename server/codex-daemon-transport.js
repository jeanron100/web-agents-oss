// Adapt the local Codex daemon's WebSocket transport to the driver's JSONL streams.
// Disconnecting this client must never terminate the daemon or its other clients.
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import WebSocket from 'ws'

export function connectCodexDaemon(socketPath) {
  const transport = new EventEmitter()
  transport.stdout = new PassThrough()
  transport.stderr = new PassThrough()
  const ws = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 10000 })
  let queued = []
  let buffer = ''
  transport.stdin = new Writable({
    write(chunk, encoding, done) {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!message.trim()) continue
        if (ws.readyState === WebSocket.OPEN) ws.send(message)
        else if (ws.readyState === WebSocket.CONNECTING) queued.push(message)
        else { done(new Error('Codex 常驻服务连接已断开')); return }
      }
      done()
    },
  })
  transport.stdin.on('error', error => transport.emit('error', error))
  ws.on('open', () => { for (const message of queued) ws.send(message); queued = [] })
  ws.on('message', data => transport.stdout.write(data.toString() + '\n'))
  ws.on('error', error => transport.emit('error', error))
  ws.on('close', () => {
    queued = []
    transport.stdin.destroy(); transport.stdout.end(); transport.stderr.end()
    transport.emit('exit')
  })
  transport.kill = () => ws.close()
  return transport
}
