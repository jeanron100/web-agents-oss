/** 复制文本到剪贴板。
 *  优先用 Clipboard API（需安全上下文：https 或 localhost）；非安全上下文（如内网 http 直连、
 *  自签证书被浏览器判定不安全等场景）或权限被拒时，回退到 textarea + execCommand('copy')。
 *  返回是否复制成功，调用方据此决定要不要展示"已复制"反馈。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 少数浏览器策略下 writeText 会 reject（如未聚焦文档），继续走 fallback 而不是直接判失败
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // 移出可视区域但保持可 focus/select，避免触发滚动或被辅助功能读出
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
