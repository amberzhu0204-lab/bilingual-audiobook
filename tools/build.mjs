#!/usr/bin/env node
// 把一份 story JSON 编译成：真实音频文件 + 时间轴 manifest + 可分享的单文件播放器。
//
//   node tools/build.mjs stories/food-chain.json
//   node tools/build.mjs stories/food-chain.json --no-embed    # 跳过 base64 内嵌，快很多
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ff, probeDuration, sayToWav, silence, renderBed, renderSting, pool,
  BEDS, STINGS, slug,
} from './lib.mjs'
import { renderPlayerHtml } from './player-template.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const storyPath = args.find((a) => !a.startsWith('--'))
const EMBED = !args.includes('--no-embed')
const SILENT = args.includes('--silent') || args.includes('-q')

if (!storyPath) {
  console.error('用法: node tools/build.mjs stories/<id>.json [--no-embed]')
  process.exit(1)
}

const log = (...a) => { if (!SILENT) console.log(...a) }
const t0 = Date.now()

/** 把秒数变成 1:05.3 这种可读形式 */
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`

// ------------------------------------------------------------------ load story
const story = JSON.parse(fs.readFileSync(path.resolve(ROOT, storyPath), 'utf8'))
const id = story.id || slug(story.title || 'story')
const S = {
  enVoice: 'Samantha', zhVoice: 'Tingting',
  enRate: 160, zhRate: 168,
  gapWithinSegment: 0.65,
  gapBetweenSegments: 1.10,
  ambience: 'meadow', ambienceVolume: -20, bedTargetDb: -18,
  stingVolume: -13,
  leadIn: 1.2, tailOut: 2.2,
  ...(story.settings || {}),
}
const segments = (story.segments || []).filter((s) => (s.en || '').trim() || (s.zh || '').trim())
if (!segments.length) { console.error('story.segments 为空'); process.exit(1) }

const workDir = path.join(ROOT, 'audio', id)
const tmpDir = path.join(workDir, '.tmp')
fs.rmSync(tmpDir, { recursive: true, force: true })
fs.mkdirSync(tmpDir, { recursive: true })

log(`\n🎧  《${story.title}》  ${segments.length} 段`)
log(`    EN ${S.enVoice} @${S.enRate}   ZH ${S.zhVoice} @${S.zhRate}   氛围 ${S.ambience}`)

// ------------------------------------------------------------------ 1. synthesize
log('\n[1/5] 合成语音 …')
const clips = await pool(segments, 4, async (seg, i) => {
  const n = String(i + 1).padStart(3, '0')
  const out = { en: null, zh: null, enDur: 0, zhDur: 0 }
  if ((seg.en || '').trim()) {
    const f = path.join(tmpDir, `s${n}_en.wav`)
    await sayToWav({ text: seg.en, voice: seg.enVoice || S.enVoice, rate: seg.enRate || S.enRate, out: f })
    out.en = f; out.enDur = await probeDuration(f)
  }
  if ((seg.zh || '').trim()) {
    const f = path.join(tmpDir, `s${n}_zh.wav`)
    await sayToWav({ text: seg.zh, voice: seg.zhVoice || S.zhVoice, rate: seg.zhRate || S.zhRate, out: f })
    out.zh = f; out.zhDur = await probeDuration(f)
  }
  return out
})
log(`      完成 ${clips.length} 段，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// ------------------------------------------------------------------ 2. timeline
let t = S.leadIn
const cues = []
const parts = []          // 拼接序列
const regions = []        // 氛围区段
const stings = []         // 一次性音效

if (S.leadIn > 0) parts.push({ file: await silence(S.leadIn, tmpDir), dur: S.leadIn })

let curAmb = S.ambience
for (let i = 0; i < segments.length; i++) {
  const seg = segments[i]
  const c = clips[i]
  const afterGap = Number.isFinite(seg.pauseAfter) ? seg.pauseAfter : S.gapBetweenSegments
  const within = Number.isFinite(seg.gapWithin) ? seg.gapWithin : S.gapWithinSegment
  // 未标注 ambience 的段落沿用上一段的氛围，作者只需在「换场景」处写一次
  const amb = seg.ambience === undefined ? curAmb : seg.ambience
  curAmb = amb

  const cue = {
    i, section: seg.section || null,
    start: t, en: seg.en || '', zh: seg.zh || '',
    ambience: amb, sting: seg.sting || null,
  }

  if (seg.sting && STINGS[seg.sting]) stings.push({ name: seg.sting, at: t })

  if (c.en) {
    cue.enStart = t; t += c.enDur; cue.enEnd = t
    parts.push({ file: c.en, dur: c.enDur })
  }
  if (c.zh) {
    if (c.en) { parts.push({ file: await silence(within, tmpDir), dur: within }); t += within }
    cue.zhStart = t; t += c.zhDur; cue.zhEnd = t
    parts.push({ file: c.zh, dur: c.zhDur })
  }
  if (afterGap > 0) { parts.push({ file: await silence(afterGap, tmpDir), dur: afterGap }); t += afterGap }
  cue.end = t
  cues.push(cue)

  // 氛围区段（连续同氛围合并）
  const prev = regions[regions.length - 1]
  if (prev && prev.ambience === amb) prev.end = t
  else regions.push({ ambience: amb, start: cue.start, end: t })
}
if (S.tailOut > 0) {
  parts.push({ file: await silence(S.tailOut, tmpDir), dur: S.tailOut })
  t += S.tailOut
  if (regions.length) regions[regions.length - 1].end = t
}
const total = t
log(`\n[2/5] 时间轴 ${mmss(total)}  (${cues.length} 句, ${regions.filter(r=>r.ambience).length} 个氛围区段)`)

// ------------------------------------------------------------------ 3. narration track
const listFile = path.join(tmpDir, 'concat.txt')
fs.writeFileSync(listFile, parts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n'))
const narration = path.join(tmpDir, 'narration.wav')
await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', narration, '-y'])

// ------------------------------------------------------------------ 4. tracks
// 主轨（人声 + 音效）与氛围轨分开编码：播放器才能独立开关背景音。
log('[3/5] 混音 …')
const XFADE = 1.5
const hasAmbience = regions.some((r) => r.ambience)
let bedFile = null

if (hasAmbience) {
  const bedParts = []
  for (const r of regions) {
    const dur = Math.max(1, r.end - r.start) + XFADE * 2
    // 没有氛围的区段用等长静音占位，保证后面的区段不会错位
    if (!r.ambience) {
      bedParts.push(await silence(dur, tmpDir))
      continue
    }
    const f = path.join(tmpDir, `bed_${slug(r.ambience)}_${Math.round(r.start)}.wav`)
    await renderBed(r.ambience, dur, f, { targetDb: S.bedTargetDb })
    bedParts.push(f)
  }
  bedFile = path.join(tmpDir, 'bed.wav')
  if (bedParts.length === 1) {
    fs.copyFileSync(bedParts[0], bedFile)
  } else {
    const ins = bedParts.flatMap((f) => ['-i', f])
    let chain = ''
    let last = '[0]'
    for (let i = 1; i < bedParts.length; i++) {
      const out = i === bedParts.length - 1 ? '[bedout]' : `[x${i}]`
      chain += `${last}[${i}]acrossfade=d=${XFADE}:c1=tri:c2=tri${out};`
      last = out
    }
    await ff([...ins, '-filter_complex', chain.replace(/;$/, ''), '-map', '[bedout]',
      '-t', total.toFixed(3), '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', bedFile, '-y'])
  }
}

// 一次性音效：延迟到时间点
const stingFiles = []
for (const st of stings) {
  const raw = path.join(tmpDir, `sting_${st.name}_${Math.round(st.at * 100)}.wav`)
  await renderSting(st.name, raw)
  const delayed = raw.replace(/\.wav$/, '_d.wav')
  await ff(['-i', raw, '-af', `adelay=${Math.round(st.at * 1000)}|${Math.round(st.at * 1000)}`,
    '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', delayed, '-y'])
  stingFiles.push(delayed)
}

const FADE_IN = 0.6
const FADE_OUT = 1.6

// --- 主轨：人声 + 一次性音效
const mainTrack = path.join(tmpDir, 'main.wav')
if (stingFiles.length) {
  const ins = ['-i', narration]
  stingFiles.forEach((f) => ins.push('-i', f))
  const chains = stingFiles.map((_, k) => `[${k + 1}:a]volume=${S.stingVolume}dB[st${k}]`)
  const mixIns = ['[0:a]', ...stingFiles.map((_, k) => `[st${k}]`)].join('')
  await ff([...ins, '-filter_complex',
    `${chains.join(';')};${mixIns}amix=inputs=${stingFiles.length + 1}:duration=first:normalize=0[out]`,
    '-map', '[out]', '-t', total.toFixed(3),
    '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', mainTrack, '-y'])
} else {
  fs.copyFileSync(narration, mainTrack)
}

// --- 氛围轨：按设置音量烘焙好，播放器可整轨开关
let ambTrack = null
if (bedFile) {
  ambTrack = path.join(tmpDir, 'amb.wav')
  await ff(['-i', bedFile, '-af',
    `volume=${S.ambienceVolume}dB,afade=t=in:st=0:d=${FADE_IN},` +
    `afade=t=out:st=${Math.max(0, total - FADE_OUT).toFixed(2)}:d=${FADE_OUT}`,
    '-t', total.toFixed(3), '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', ambTrack, '-y'])
}

// ------------------------------------------------------------------ 5. encode + manifest
log('[4/5] 编码 m4a …')
// 人声要清楚，给足码率；氛围只是噪声床，48k 足够，省下的体积直接体现在单文件播放器上
const enc = (src, dst, kbps) => ff(['-i', src, '-c:a', 'aac', '-b:a', `${kbps}k`, '-ar', '22050', '-ac', '1',
  '-movflags', '+faststart', dst, '-y'])

const audioFile = path.join(workDir, `${id}.m4a`)
await enc(mainTrack, audioFile, S.audioBitrate || 96)
const size = fs.statSync(audioFile).size

let ambAudioFile = null
if (ambTrack) {
  ambAudioFile = path.join(workDir, `${id}.amb.m4a`)
  await enc(ambTrack, ambAudioFile, S.ambienceBitrate || 48)
}
log(`      人声 ${(size / 1024 / 1024).toFixed(2)} MB` +
  (ambAudioFile ? ` + 氛围 ${(fs.statSync(ambAudioFile).size / 1024 / 1024).toFixed(2)} MB` : '') +
  `  ${mmss(total)}`)

const manifest = {
  id, title: story.title, titleEn: story.titleEn || '', subtitle: story.subtitle || '',
  cover: story.cover || '📖', accent: story.accent || '#2f7d5d',
  duration: Number(total.toFixed(3)),
  settings: S,
  voices: { en: S.enVoice, zh: S.zhVoice },
  regions: regions.map((r) => ({ ...r, start: +r.start.toFixed(3), end: +r.end.toFixed(3) })),
  cues: cues.map((c) => Object.fromEntries(
    Object.entries(c).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))),
  audio: `${id}.m4a`,
  ambienceAudio: ambAudioFile ? `${id}.amb.m4a` : null,
  builtAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

// ------------------------------------------------------------------ 6. player bundles
log('[5/5] 生成播放器 …')
const distDir = path.join(ROOT, 'dist')
fs.mkdirSync(distDir, { recursive: true })

// (a) 流式版：音频与 html 分离，供站点 / GitHub Pages 用
const streamHtml = renderPlayerHtml(manifest, {
  audioSrc: `../audio/${id}/${id}.m4a`,
  ambSrc: ambAudioFile ? `../audio/${id}/${id}.amb.m4a` : null,
})
fs.writeFileSync(path.join(distDir, `${id}.html`), streamHtml)

// (b) 自包含版：音频 base64 内嵌，单文件可 AirDrop / 双击播放 / 离线
let embedHtml = null
if (EMBED) {
  const dataUri = (f) => `data:audio/mp4;base64,${fs.readFileSync(f).toString('base64')}`
  embedHtml = renderPlayerHtml(manifest, {
    audioSrc: dataUri(audioFile),
    ambSrc: ambAudioFile ? dataUri(ambAudioFile) : null,
  })
  fs.writeFileSync(path.join(distDir, `${id}.standalone.html`), embedHtml)
}

// 站点索引
const idxPath = path.join(ROOT, 'stories', 'index.json')
let index = []
try { index = JSON.parse(fs.readFileSync(idxPath, 'utf8')) } catch {}
index = index.filter((e) => e.id !== id)
index.push({ id, title: manifest.title, titleEn: manifest.titleEn, cover: manifest.cover,
  duration: manifest.duration, segments: cues.length, builtAt: manifest.builtAt })
index.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
fs.writeFileSync(idxPath, JSON.stringify(index, null, 2))

fs.rmSync(tmpDir, { recursive: true, force: true })

log(`\n✅ 完成  总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
log(`   音频      audio/${id}/${id}.m4a`)
log(`   时间轴    audio/${id}/manifest.json`)
log(`   播放器    dist/${id}.html`)
if (EMBED) log(`   单文件    dist/${id}.standalone.html  ← 可直接发给孩子/老人`)
