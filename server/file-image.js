import fs from 'node:fs'
import path from 'node:path'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Opens only regular files whose resolved location remains in this session's project. */
export function openProjectFile(cwd, rel) {
  if (!cwd || !rel) return null
  let fd
  try {
    const base = path.resolve(cwd), abs = path.resolve(base, rel)
    if (!abs.startsWith(base + path.sep)) return null
    const realBase = fs.realpathSync(base), realFile = fs.realpathSync(abs)
    if (!realFile.startsWith(realBase + path.sep)) return null
    fd = fs.openSync(realFile, 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) { fs.closeSync(fd); return null }
    return { fd, stat }
  } catch { if (fd !== undefined) fs.closeSync(fd); return null }
}

/** Use file signatures, not a filename alone, before serving image bytes. */
export function imageMime(buf, filename) {
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon'
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(buf.subarray(8, 32).toString('ascii'))) return 'image/avif'
  if (path.extname(filename).toLowerCase() === '.svg' && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, ''))) return 'image/svg+xml'
  return null
}

/** Caller owns the returned stream; no whole-image buffering or base64 conversion. */
export function openProjectImage(cwd, rel) {
  const file = openProjectFile(cwd, rel)
  if (!file) return null
  const { fd, stat } = file
  try {
    const header = Buffer.alloc(Math.min(4096, stat.size))
    fs.readSync(fd, header, 0, header.length, 0)
    const mediaType = imageMime(header, rel)
    if (!mediaType) { fs.closeSync(fd); return null }
    if (stat.size > MAX_IMAGE_BYTES) { fs.closeSync(fd); return { error: 'toolarge' } }
    return { mediaType, size: stat.size, stream: fs.createReadStream('', { fd, start: 0, end: stat.size - 1, autoClose: true }) }
  } catch { fs.closeSync(fd); return null }
}
