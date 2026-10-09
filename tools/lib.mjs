// Shared helpers: tool discovery, process running, audio primitives, SFX recipes.
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const pexec = promisify(execFile)

// ---------------------------------------------------------------- tool discovery
function findBin(name, extra = []) {
  const candidates = [
    process.env[`${name.toUpperCase()}_PATH`],
    ...extra,
    path.join(os.homedir(), '.local/bin', name),
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
    '/usr/bin/' + name,
  ].filter(Boolean)
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c } catch {}
  }
  // fall back to PATH lookup
  try { return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() } catch {}
  throw new Error(`找不到 ${name}。macOS 请先安装：brew install ffmpeg`)
}

export const FFMPEG = findBin('ffmpeg')
export const FFPROBE = findBin('ffprobe')

/** 运行子进程，stdout/stderr 原样返回；失败时抛出含 stderr 的错误 */
export async function run(bin, args, opts = {}) {
  try {
    return await pexec(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts })
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().split('\n').slice(-6).join('\n')
    throw new Error(`${path.basename(bin)} 失败:\n${msg}`)
  }
}

export const ff = (args) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args])
export const ffQuiet = (args) => run(FFMPEG, ['-hide_banner', '-loglevel', 'quiet', ...args])

export async function probeDuration(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ])
  const d = parseFloat(stdout.trim())
  if (!Number.isFinite(d)) throw new Error(`无法读取时长: ${file}`)
  return d
}

// ---------------------------------------------------------------- TTS voices
/** 解析 `say -v '?'`，返回 [{name, locale, sample}] */
export async function listVoices() {
  const { stdout } = await run('/usr/bin/say', ['-v', '?'])
  const out = []
  for (const line of stdout.split('\n')) {
    // 形如: "Tingting            zh_CN    # 你好！我叫婷婷。"
    const m = line.match(/^(.*?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#\s*(.*)$/)
    if (m) out.push({ name: m[1].trim(), locale: m[2], sample: m[3].trim() })
  }
  return out
}

// Female/child-friendly narration voices we recommend, best first.
export const RECOMMENDED_EN = ['Samantha', 'Ava', 'Allison', 'Susan', 'Kathy', 'Zoe', 'Nicky', 'Flo (英语（美国）)', 'Sandy (英语（美国）)']
export const RECOMMENDED_ZH = ['Tingting', 'Meijia', 'Sinji', 'Flo (中文（中国大陆）)', 'Sandy (中文（中国大陆）)', 'Shelley (中文（中国大陆）)']

/**
 * 用 macOS `say` 合成一段语音到文件。
 * 注意：say 的 -o 是「追加」，所以必须先删除目标文件。
 */
export async function sayToWav({ text, voice, rate = 175, out, sampleRate = 44100 }) {
  if (!text || !text.trim()) throw new Error('sayToWav: 文本为空')
  const tmp = out.replace(/\.wav$/, '.aiff')
  for (const f of [tmp, out]) { try { fs.unlinkSync(f) } catch {} }
  await run('/usr/bin/say', [
    '-v', voice,
    '-r', String(Math.max(80, Math.min(400, Math.round(rate)))),
    '-o', tmp,
    text,
  ])
  // AIFF -> 归一化 wav（响度统一，保证中英音量一致、段落之间不忽大忽小）
  await ff([
    '-i', tmp,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', String(sampleRate), '-ac', '1', '-c:a', 'pcm_s16le',
    out, '-y',
  ])
  try { fs.unlinkSync(tmp) } catch {}
  return out
}

// ---------------------------------------------------------------- silence
const silenceCache = new Map()
/** 生成（并缓存）指定时长的静音 wav */
export async function silence(seconds, dir, sampleRate = 44100) {
  const key = `${seconds.toFixed(3)}@${sampleRate}`
  if (silenceCache.has(key)) return silenceCache.get(key)
  const file = path.join(dir, `_silence_${key.replace(/[^\d.@]/g, '_')}.wav`)
  await ff([
    '-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=mono`,
    '-t', seconds.toFixed(3), '-c:a', 'pcm_s16le', file, '-y',
  ])
  silenceCache.set(key, file)
  return file
}

// ---------------------------------------------------------------- SFX recipes
// 背景氛围床：按「实际需要的时长」现场生成，因此不会有循环接缝的咔哒声。
export const BEDS = {
  meadow: {
    label: '草甸微风', emoji: '🌿',
    lavfi: (d) => `anoisesrc=c=pink:r=44100:a=0.30:d=${d}`,
    af: 'highpass=f=320,lowpass=f=2400,tremolo=f=0.13:d=0.35,volume=1.1',
  },
  forest: {
    label: '树林', emoji: '🌳',
    lavfi: (d) => `anoisesrc=c=pink:r=44100:a=0.26:d=${d}`,
    af: 'highpass=f=260,lowpass=f=1900,tremolo=f=0.11:d=0.30,volume=1.2',
  },
  ocean: {
    label: '海浪', emoji: '🌊',
    lavfi: (d) => `anoisesrc=c=brown:r=44100:a=0.85:d=${d}`,
    af: 'highpass=f=70,lowpass=f=760,tremolo=f=0.14:d=0.80,volume=1.25',
  },
  pond: {
    label: '池塘', emoji: '💧',
    lavfi: (d) => `anoisesrc=c=pink:r=44100:a=0.22:d=${d}`,
    af: 'highpass=f=420,lowpass=f=1500,tremolo=f=0.22:d=0.45,volume=1.0',
  },
  rain: {
    label: '下雨', emoji: '🌧️',
    lavfi: (d) => `anoisesrc=c=pink:r=44100:a=0.70:d=${d}`,
    af: 'highpass=f=240,lowpass=f=4300,volume=0.55',
  },
  space: {
    label: '太空', emoji: '🪐',
    lavfi: (d) => `sine=f=54.5:r=44100:d=${d}`,
    lavfi2: (d) => `sine=f=55.2:r=44100:d=${d}`,
    af: 'lowpass=f=900,volume=1.6',
  },
  night: {
    label: '夜晚', emoji: '🌙',
    lavfi: (d) => `anoisesrc=c=brown:r=44100:a=0.45:d=${d}`,
    af: 'lowpass=f=340,tremolo=f=0.10:d=0.30,volume=1.2',
  },
}

export const STINGS = {
  pop: {
    label: '啵', emoji: '🫧',
    args: (o) => ['-f', 'lavfi', '-i', 'sine=f=740:d=0.16:r=44100',
      '-af', 'afade=t=in:d=0.01,afade=t=out:st=0.05:d=0.11,volume=0.5', ...o],
  },
  chime: {
    label: '叮咚', emoji: '🔔',
    args: (o) => ['-f', 'lavfi', '-i', 'sine=f=1046.5:d=1.1:r=44100',
      '-f', 'lavfi', '-i', 'sine=f=1568:d=1.1:r=44100',
      '-filter_complex', '[0][1]amix=inputs=2,afade=t=in:d=0.01,afade=t=out:st=0.15:d=0.9,aecho=0.8:0.7:60:0.3,volume=0.34', ...o],
  },
  whoosh: {
    label: '嗖', emoji: '💨',
    args: (o) => ['-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=44100:a=0.6:d=0.5',
      '-af', 'lowpass=f=2600,highpass=f=300,afade=t=in:d=0.16,afade=t=out:st=0.18:d=0.3,volume=0.5', ...o],
  },
  drip: {
    label: '水滴', emoji: '💧',
    args: (o) => ['-f', 'lavfi', '-i', 'sine=f=1500:d=0.3:r=44100',
      '-af', 'afade=t=in:d=0.005,afade=t=out:st=0.04:d=0.25,aecho=0.8:0.6:45:0.35,volume=0.45', ...o],
  },
  twinkle: {
    label: '星星闪', emoji: '✨',
    args: (o) => ['-f', 'lavfi', '-i', 'sine=f=2093:d=0.7:r=44100',
      '-af', 'tremolo=f=9:d=0.9,afade=t=in:d=0.01,afade=t=out:st=0.2:d=0.45,volume=0.3', ...o],
  },
  heartbeat: {
    label: '心跳', emoji: '💓',
    args: (o) => ['-f', 'lavfi', '-i', 'sine=f=62:d=0.9:r=44100',
      '-af', 'tremolo=f=1.9:d=0.95,lowpass=f=180,afade=t=out:st=0.6:d=0.3,volume=1.4', ...o],
  },
}

/** 用 volumedetect 量出 mean/max 音量（dB） */
async function measureLevels(file) {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)
  const max = stderr.match(/max_volume:\s*(-?[\d.]+) dB/)
  return {
    mean: mean ? parseFloat(mean[1]) : null,
    max: max ? parseFloat(max[1]) : null,
  }
}

/**
 * 渲染一条氛围床到 out（时长精确为 seconds）。
 *
 * 各条 bed 的原始响度差别很大（海浪比池塘响十几个 dB），所以渲染后统一
 * 校准到 targetDb 的均值，这样「同一档背景音量」在换场景时听感才是连贯的。
 * 同时按峰值限制增益，避免噪声被推爆。
 */
export async function renderBed(name, seconds, out, { targetDb = -18 } = {}) {
  const bed = BEDS[name]
  if (!bed) throw new Error(`未知氛围: ${name}`)
  const d = Math.max(1, seconds).toFixed(3)
  const tail = ['-t', d, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le']

  const raw = out.replace(/\.wav$/, '.raw.wav')
  if (bed.lavfi2) {
    // 两路叠加以产生缓慢拍频（太空的呼吸感）
    await ff([
      '-f', 'lavfi', '-i', bed.lavfi(d),
      '-f', 'lavfi', '-i', bed.lavfi2(d),
      '-filter_complex', `[0][1]amix=inputs=2,${bed.af}[out]`,
      '-map', '[out]', ...tail, raw, '-y',
    ])
  } else {
    await ff(['-f', 'lavfi', '-i', bed.lavfi(d), '-af', bed.af, ...tail, raw, '-y'])
  }

  if (targetDb === null) { fs.renameSync(raw, out); return out }

  const { mean, max } = await measureLevels(raw)
  if (mean === null) { fs.renameSync(raw, out); return out }

  // 留 2dB 余量；环境音床不需要压限，超过就少推一点
  const ceiling = -2 - (max ?? 0)
  const gain = Math.max(-24, Math.min(24, Math.min(targetDb - mean, ceiling)))
  await ff(['-i', raw, '-af', `volume=${gain.toFixed(2)}dB`, '-ar', '44100', '-ac', '1',
    '-c:a', 'pcm_s16le', out, '-y'])
  fs.unlinkSync(raw)
  return out
}

/** 渲染一条音效到 wav 文件 */
export async function renderSting(name, out) {
  const sting = STINGS[name]
  if (!sting) throw new Error(`未知音效: ${name}`)
  await ff([...sting.args(['-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', out, '-y'])])
  return out
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** 短暂等待，避免 say/ffmpeg 并发过高 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 简单并发池 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}
