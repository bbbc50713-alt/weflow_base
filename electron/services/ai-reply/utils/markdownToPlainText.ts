/**
 * 简单 Markdown 转纯文本工具
 * 保留换行、标点和 emoji，去除 Markdown 格式
 */
export function markdownToPlainText(md: string): string {
  if (!md || typeof md !== 'string') {
    return md || ''
  }

  let text = md

  // 1. 保留 emoji 不受影响

  // 2. 去除标题 #、## 等 → 保留文本，去掉 #
  text = text.replace(/^(#{1,6})\s+/gm, '')

  // 3. 去除粗体 **text** 或 __text__ → 保留 text
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')

  // 4. 去除斜体 *text* 或 _text_ → 保留 text
  // (注意：要先处理粗体后再处理斜体，避免冲突)
  text = text.replace(/\*([^*]+)\*/g, '$1')
  text = text.replace(/_([^_]+)_/g, '$1')

  // 5. 去除行内代码 `code` → 保留 code
  text = text.replace(/`([^`]+)`/g, '$1')

  // 6. 去除代码块 ```...``` → 保留内容
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    const content = match.replace(/```[^\n]*\n?/, '').replace(/```$/, '')
    return content.trim()
  })

  // 7. 去除链接 [text](url) → 保留 text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // 8. 去除引用 > text → 保留 text
  text = text.replace(/^>\s+/gm, '')

  // 9. 去除分割线 ---、***、___ 等
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, '')

  // 10. 去除列表 - 、* 、数字.
  text = text.replace(/^[-*]\s+/gm, '')
  text = text.replace(/^\d+\.\s+/gm, '')

  // 11. 去除表格（简单处理）
  // 去除 | ... | 格式
  text = text.replace(/^\|.*\|$/gm, (line) => line.replace(/\|/g, ' ').trim())
  text = text.replace(/^\s*[-:|]+\s*$/gm, '')

  // 12. 清理多余的空行（不超过 2 个
  text = text.replace(/\n{3,}/g, '\n\n')

  // 13. 去除行首尾的空格和换行
  text = text.trim()

  return text
}
