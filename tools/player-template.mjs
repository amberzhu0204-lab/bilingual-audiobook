// 读取 tools/player.template.html，注入 manifest 与音频地址，返回完整的播放器 HTML。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'player.template.html')

// 内嵌进 <script> 时要转义：< 防止 "</script>" 提前闭合，U+2028/2029 是 JS 的换行符
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)

const safeJson = (obj) => JSON.stringify(obj)
  .replace(/</g, '\\u003c')
  .split(LS).join('\\u2028')
  .split(PS).join('\\u2029')

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))

export function renderPlayerHtml(manifest, { audioSrc, ambSrc = null }) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8')
  const title = [manifest.title, manifest.titleEn].filter(Boolean).join(' · ')
  return tpl
    .replace('__TITLE__', escapeHtml(title))
    .replace('/*__MANIFEST__*/ null', safeJson(manifest))
    .replace('__AUDIO_SRC__', audioSrc)
    .replace('__AMB_SRC__', ambSrc || '')
    .replace('__AUDIO_ATTR__', '')
}
