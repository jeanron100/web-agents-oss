// 事件 payload 的「上线」序列化：把内联的 base64 图片换成可懒加载的 URL 引用。
//
// ── 为什么存在 ──
// scanFile 会把 JSONL 里贴的截图以 base64 内联到 user 事件上（`imagesOf`）。那是为**服务端内部**的
// 归档器（buildArchivePayload → KB markdown 内联截图）准备的——归档器跟扫描器在同一个进程里，
// 拿内存对象即可。
//
// 但 /events 和 /stream 直接把同一个对象 JSON 出去了，于是这些 base64 **每次打开对话流都完整重传一遍**，
// 而前端 ChatMessage 只读 `imageCount` 画个徽标、**从不使用 event.images** —— 收到就扔。
// 实测（website_operator，14MB JSONL）：payload 1.41MB，其中 **1.35MB（96%）是 12 条 user 事件里的
// base64 截图**，真正的文字+工具事件只有 43KB。base64 的 JPEG 还压不动（gzip 后仍有 916KB），
// 手机上首屏就要 8~10 秒；同一个界面的 Codex 会话（无图，10KB）秒开。用户报的就是这个。
//
// ── 做法 ──
// 在 **HTTP 出口**（且仅在出口）把 `images:[{name,media_type,base64}]` 换成
// `[{name,media_type,bytes,url}]`，url 指向 `/api/session/:id/image/:eventId/:idx`。
// 浏览器按需拉、`loading="lazy"` 只在滚到时拉、`immutable` 后永久走缓存。
// 内部调用方（归档/digest）走 eventsPayload 原对象，base64 一如既往。
//
// ⚠️ **必须不可变**：eventsPayload 返回的是 `cachedScan` 缓存里的**同一个对象**。就地删 base64
// 会把缓存里的图片永久抹掉 → 归档器再也拿不到截图（而且只在缓存失效前复现，极难查）。
// 这里全程复制，一个字段都不改原对象。event-wire.test.mjs 里有专门守这一条的用例。

/** 事件里的图片是否还带着 base64（老 agent / 内部对象）。 */
const hasInlineImages = (e) => Array.isArray(e?.images) && e.images.some((i) => i && i.base64)

/**
 * 把 payload 序列化成「可上线」的形状：剥掉 base64，换成 URL 引用。
 * 非图片事件、以及不带图的事件，**原样按引用透传**（不复制，省 GC）。
 * @param {object|null} payload eventsPayload 的返回值
 * @param {string} sessionId    用于拼图片 URL
 * @returns {object|null} 新对象；入参不被修改
 */
export function toWire(payload, sessionId) {
  if (!payload || !Array.isArray(payload.events)) return payload
  if (!payload.events.some(hasInlineImages)) return payload // 绝大多数会话无图：零开销直接返回原对象

  const events = payload.events.map((e) => {
    if (!hasInlineImages(e)) return e
    const images = e.images.map((img, idx) => {
      const { base64, ...rest } = img
      if (!base64) return img
      return {
        ...rest,
        bytes: Math.floor((base64.length * 3) / 4), // 供前端预留占位尺寸/显示体积
        url: `/api/session/${encodeURIComponent(sessionId)}/image/${encodeURIComponent(e.id)}/${idx}`,
      }
    })
    return { ...e, images, imageCount: e.imageCount ?? images.length }
  })
  return { ...payload, events }
}

/**
 * 按 (eventId, idx) 从事件数组里取出一张图的原始字节。
 * @returns {{buf: Buffer, mediaType: string, name: string}|null}
 */
export function findImage(events, eventId, idx) {
  if (!Array.isArray(events)) return null
  const e = events.find((x) => String(x?.id) === String(eventId))
  const img = e && Array.isArray(e.images) ? e.images[Number(idx)] : null
  if (!img || !img.base64) return null
  return {
    buf: Buffer.from(img.base64, 'base64'),
    mediaType: img.media_type || 'application/octet-stream',
    name: img.name || `img-${idx}`,
  }
}
