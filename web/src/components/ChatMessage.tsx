import { useEffect, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ChatEvent, Engine, EventImage } from '../types'
import { clock } from '../lib/format'
import { imageHint } from '../lib/image-cost'
import { copyToClipboard } from '../lib/clipboard'
import { Markdown } from './Markdown'

const LONG = 1500 // 超过则折叠，给"展开全文"，避免长内容糊屏
const ENGINE_META: Record<Engine, { glyph: string; label: string }> = {
  claude: { glyph: 'C', label: 'Claude' },
  codex: { glyph: 'X', label: 'Codex' },
  kimi: { glyph: 'K', label: 'Kimi' },
}

// 会话持久化图片查看器（灯箱）：点击"🖼 N 张图片"徽标后拉取该会话已落盘的全部 Web 上传图片。
// ⚠️ 这是**会话级**集合，不是本条消息的精确映射——只在事件不带 images[] 时作为回退（老 agent）。
// 新路径见下面的 InlineImages：后端 toWire 现在给每条消息带上了自己那几张图的 URL。
type SessionImage = { name: string; media_type: string; base64: string }

/** 本条消息自己的截图：**点击才加载** + 点开看大图。
 *  URL 指向 /api/session/:id/image/:eventId/:idx，immutable 只拉一次。
 *  （以前这些图是 base64 内联在事件里全量下发的，占 payload 96% 且从不被使用。）
 *
 * ★★ 2026-09-11 事故：原实现是 `<img src={url} loading="lazy">`，注释写的是「懒加载缩略图」，
 *   但 ① `loading="lazy"` 只延迟到**进入视口**，滚到就拉；② 服务端**根本没有缩略图**，
 *   拉的是全尺寸原图。用户打开一个含两张截图的会话（461,767 + 496,156 = **936 KB**），
 *   而跨境隧道实测只有 **~11 KB/s** ⇒ 独占链路 ~87 秒 ⇒ `/api/state`(54KB) 排队等不到
 *   ⇒ 前端 20s 超时 abort ⇒ nginx 记 499 ⇒ 连续失败 ⇒ 弹「与服务器失联 71 秒」。
 *   实证：隧道 SSH 连接的 **Send-Q 从 192,632 涨到 655,548 字节**，图片全堵在发送队列里；
 *   而 `ServerAliveInterval` 没触发重连，因为**保活是小包挤得过去**、大流量才塞死。
 *   ⚠️ **注释里的词（"缩略图"）和代码做的事不是一回事**——这类误导比没注释更贵。
 *
 * ⇒ 现在默认只画占位按钮，**点击才设 src**；按钮上写清「451 KB · 约 41 秒」，
 *   让用户在点之前就知道代价（bytes 是服务端 toWire 早就带上的，一直没人用）。
 */
function InlineImages({ images }: { images: EventImage[] }) {
  const [zoom, setZoom] = useState<EventImage | null>(null)
  // 已被用户点开加载的图（按 url 记）。刻意不做"自动加载小图"——
  // 阈值多少都是猜，而链路状况随时在变；把选择权交给用户，代价写在按钮上。
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const open = (url: string) => setOpened((prev) => (prev.has(url) ? prev : new Set(prev).add(url)))
  return (
    <>
      <div className="chat-imgs">
        {images.map((img) => (opened.has(img.url) ? (
          <button key={img.url} className="chat-imgs__item" onClick={(e) => { e.stopPropagation(); setZoom(img) }} title={img.name}>
            <img src={img.url} alt={img.name} decoding="async" />
          </button>
        ) : (
          <button
            key={img.url} className="chat-imgs__ph"
            onClick={(e) => { e.stopPropagation(); open(img.url) }}
            title={`点击加载 ${img.name}`}
          >
            <span className="chat-imgs__phicon">🖼</span>
            <span className="chat-imgs__phtext">{imageHint(img) || '图片'}</span>
            <span className="chat-imgs__phcta">点击加载</span>
          </button>
        )))}
      </div>
      {zoom && createPortal(
        <div className="img-lightbox" onClick={() => setZoom(null)}>
          <button className="icon-btn img-lightbox__close" onClick={() => setZoom(null)} title="关闭">✕</button>
          <div className="img-lightbox__grid">
            <img className="img-lightbox__img" src={zoom.url} alt={zoom.name} />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function ImageLightbox({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [images, setImages] = useState<SessionImage[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`/api/session/${sessionId}/images`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d) => { if (alive) setImages(Array.isArray(d?.images) ? d.images : []) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [sessionId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loading = images === null && !failed
  // 取到了但为空 = 图片未持久化在本机（如终端里接管的会话，截图仅存于 JSONL 历史）——与真正的加载失败区分开
  const notPersisted = !failed && images !== null && images.length === 0

  return createPortal(
    <div className="img-lightbox" onClick={onClose}>
      <button className="icon-btn img-lightbox__close" onClick={onClose} title="关闭">✕</button>
      {loading && <div className="img-lightbox__msg">加载中…</div>}
      {failed && <div className="img-lightbox__msg">图片加载失败</div>}
      {notPersisted && <div className="img-lightbox__msg">该会话截图未持久化，暂无法查看</div>}
      {images && images.length > 0 && (
        <div className="img-lightbox__grid">
          {images.map((img) => (
            <img
              key={img.name}
              className="img-lightbox__img"
              src={`data:${img.media_type};base64,${img.base64}`}
              alt={img.name}
              onClick={onClose}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}

export function ChatMessage({ event, engine, queueState, onFileLink }: { event: ChatEvent; engine: Engine; queueState?: 'processing' | 'queued'; onFileLink?: (href: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [showImages, setShowImages] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = event.type === 'user' || event.type === 'assistant' ? event.text : ''
  const streaming = event.type === 'assistant' && event.streaming
  const longText = !streaming && text.length > LONG
  const collapsed = longText && !expanded
  const toggle = longText ? (
    <button className="chat-collapse-btn" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}>
      {expanded ? '收起 ▴' : `展开全文（约 ${Math.round(text.length / 1000)}k 字）▾`}
    </button>
  ) : null

  // 复制本条消息的原始文本（event.text，非 Markdown 渲染后的 DOM 文本）到剪贴板，
  // 交互参照 Cursor/VS Code：hover 消息出现图标 → 点击复制 → 图标短暂变对勾反馈。
  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation()
    copyToClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const copyBtn = (
    <button
      type="button"
      className={`copy-btn ${copied ? 'copy-btn--done' : ''}`}
      onClick={handleCopy}
      title={copied ? '已复制' : '复制消息'}
      aria-label={copied ? '已复制' : '复制消息'}
    >
      {copied ? '✓' : '📋'}
    </button>
  )

  switch (event.type) {
    case 'user':
      return (
        <div className="chat-msg chat-msg--user">
          <div>
            {/* 「处理中」≠「排队中」：消息 POST 后**同一秒**就进了 Claude 的输入队列（实测 JSONL 里
                enqueue/dequeue 同毫秒配对），最早那条一直在被处理。此前一律标「排队中」，用户会盯着
                一条写着"排队中"的消息看一分多钟，以为它压根没发出去。只有它后面压着的才是真排队。 */}
            <div className="chat-msg__time">
              你 {clock(event.ts)}
              {event.delivery && <span className="chat-queued">{{ sending: '发送中…', accepted: '已送达', steered: '已追加到当前任务', queued: '已送达 · 排队中', unknown: '送达待确认', failed: '未送达', cancelled: '已取消' }[event.delivery]}</span>}
              {event.deliveryReason && <span className="chat-queued">{event.deliveryReason}</span>}
              {!event.delivery && queueState === 'processing' && <span className="chat-queued chat-queued--now">⚙ 处理中</span>}
              {!event.delivery && queueState === 'queued' && <span className="chat-queued">⏳ 排队中</span>}
              {copyBtn}
            </div>
            <div className={`chat-bubble ${collapsed ? 'chat-bubble--collapsed' : ''}`}>
              {/* 新后端：本条消息自己的图，按需懒加载。老后端（无 images[]）：回退到会话级灯箱徽标。 */}
              {event.images?.length ? (
                <InlineImages images={event.images} />
              ) : event.imageCount ? (
                <button
                  className="chat-bubble__img"
                  onClick={(e) => { e.stopPropagation(); setShowImages(true) }}
                >
                  🖼 {event.imageCount} 张图片
                </button>
              ) : null}
              {event.text}
            </div>
            {toggle}
          </div>
          {showImages && <ImageLightbox sessionId={event.sessionId} onClose={() => setShowImages(false)} />}
        </div>
      )
    case 'assistant':
      return (
        <div className="chat-msg">
          <div className="chat-msg__meta">
            <span className={`chat-msg__avatar chat-msg__avatar--${engine}`}>
              {ENGINE_META[engine].glyph}
            </span>
            <span>{ENGINE_META[engine].label}</span>
            <span>{clock(event.ts)}</span>
            {copyBtn}
          </div>
          <div className={`chat-msg__body md ${streaming ? 'cursor-blink' : ''} ${collapsed ? 'chat-msg__body--collapsed' : ''}`}>
            <Markdown text={event.text} onFileLink={onFileLink} />
          </div>
          {toggle}
        </div>
      )
    case 'file_op':
      return (
        <div className="tool-card">
          <span className="tool-card__verb">{event.verb}</span>
          <span className="tool-card__path">{event.path}</span>
          <span className="diff-stat">
            {event.additions != null && <span className="add">+{event.additions} </span>}
            {event.deletions != null && <span className="del">−{event.deletions}</span>}
          </span>
        </div>
      )
    case 'turn_end':
      return (
        <div className="turn-end">
          <span>回合结束</span>
          <span>{event.durationSec}s</span>
          <span>{(event.tokens / 1000).toFixed(1)}k tokens</span>
          <span>${event.cost.toFixed(2)}</span>
        </div>
      )
  }
}
