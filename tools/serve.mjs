#!/usr/bin/env node
// 本地工坊服务：静态托管整个项目 + 一个 /api/build 接口。
// 浏览器不能直接调用 macOS 的 say / ffmpeg，所以由这个进程代劳。
//
//   node tools/serve.mjs [--port 5180] [--no-open]
//
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 5180
const OPEN = !argv.includes('--no-open')
const NO_EMBED = argv.includes('--no-embed')   // 迭代时用，跳过 base64 内嵌

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aiff': 'audio/aiff',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 生成音频：把 story 落盘成 stories/<id>.json，再跑 tools/build.mjs */
function runBuild(id) {
  return new Promise((resolve) => {
    const args = ['tools/build.mjs', `stories/${id}.json`]
    if (NO_EMBED) args.push('--no-embed')
    const child = spawn(process.execPath, args, { cwd: ROOT })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
    child.on('error', (e) => resolve({ code: -1, out: String(e.message) }))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // ---------- API ----------
  if (url.pathname === '/api/build' && req.method === 'POST') {
    let story
    try { story = JSON.parse(await readBody(req)) }
    catch (e) { return json(res, 400, { ok: false, error: '无法解析 JSON: ' + e.message }) }

    // id 会被拼进文件路径，必须严格消毒
    const id = String(story.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    if (!id) return json(res, 400, { ok: false, error: '缺少合法的 id（请填英文标题）' })
    story.id = id

    try {
      fs.mkdirSync(path.join(ROOT, 'stories'), { recursive: true })
      fs.writeFileSync(path.join(ROOT, 'stories', `${id}.json`), JSON.stringify(story, null, 2))
    } catch (e) {
      return json(res, 500, { ok: false, error: '写入 story 失败: ' + e.message })
    }

    const t0 = Date.now()
    const { code, out } = await runBuild(id)
    const log = out.split('\n').slice(-14).join('\n')
    if (code !== 0) return json(res, 500, { ok: false, error: '构建失败', log })

    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'audio', id, 'manifest.json'), 'utf8')) } catch {}
    return json(res, 200, {
      ok: true, id, log,
      segments: manifest ? manifest.cues.length : 0,
      duration: manifest ? Math.floor(manifest.duration / 60) + ':' + String(Math.round(manifest.duration % 60)).padStart(2, '0') : '?',
      ms: Date.now() - t0,
    })
  }

  if (url.pathname === '/api/health') return json(res, 200, { ok: true, root: ROOT })

  // ---------- 静态文件 ----------
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = path.join(ROOT, rel)

  // 防目录穿越
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden')
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found') }

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' }

    // ⚠️ 媒体文件必须支持 Range：否则浏览器无法 seek，进度条 / 跳句 / 两轨同步全都失效。
    const range = req.headers.range
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10)
      let end = m[2] === '' ? null : parseInt(m[2], 10)
      if (start === null && end === null) { res.writeHead(416, base); return res.end() }
      if (start === null) { start = Math.max(0, st.size - end); end = st.size - 1 }   // bytes=-N
      else { if (end === null || end >= st.size) end = st.size - 1 }
      if (start > end || start >= st.size) {
        res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` })
        return res.end()
      }
      res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }

    res.writeHead(200, { ...base, 'content-length': st.size })
    fs.createReadStream(file).pipe(res)
  })
})

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`
  console.log(`\n  🎙️  双语有声绘本工坊\n`)
  console.log(`     创作台  ${url}`)
  console.log(`     播放器  ${url}dist/food-chain.html\n`)
  console.log(`     Ctrl+C 退出\n`)
  if (OPEN) spawn('open', [url], { stdio: 'ignore' }).on('error', () => {})
})
