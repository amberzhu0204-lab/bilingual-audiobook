#!/usr/bin/env node
// 把本机可用的语音、氛围、音效导出成静态 JSON，供创作台 (index.html) 读取。
// 创作台是纯静态页面，跑不了 `say -v '?'`，所以信息在构建期固化下来。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listVoices, BEDS, STINGS, RECOMMENDED_EN, RECOMMENDED_ZH } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const voices = await listVoices()
const zh = voices.filter((v) => v.locale.startsWith('zh'))
const en = voices.filter((v) => v.locale.startsWith('en'))

// macOS 里有一堆「趣味音」不属于朗读用的正常嗓音，先排到后面
const NOVELTY = new Set(['Bad News', 'Good News', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Jester',
  'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Bahh', 'Albert', 'Fred', 'Junior'])

const order = (list, rec) => [...list].sort((a, b) => {
  const ra = rec.indexOf(a.name), rb = rec.indexOf(b.name)
  const na = NOVELTY.has(a.name), nb = NOVELTY.has(b.name)
  if (na !== nb) return na ? 1 : -1
  if (ra !== -1 || rb !== -1) return (ra === -1 ? 999 : ra) - (rb === -1 ? 999 : rb)
  return a.name.localeCompare(b.name)
})

fs.writeFileSync(path.join(ROOT, 'voices.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  host: `${process.platform} ${process.arch}`,
  recommended: { en: RECOMMENDED_EN, zh: RECOMMENDED_ZH },
  en: order(en, RECOMMENDED_EN),
  zh: order(zh, RECOMMENDED_ZH),
}, null, 2))

fs.writeFileSync(path.join(ROOT, 'catalog.json'), JSON.stringify({
  beds: Object.entries(BEDS).map(([key, v]) => ({ key, label: v.label, emoji: v.emoji })),
  stings: Object.entries(STINGS).map(([key, v]) => ({ key, label: v.label, emoji: v.emoji })),
}, null, 2))

console.log(`voices.json  en:${en.length} zh:${zh.length}`)
console.log(`catalog.json beds:${Object.keys(BEDS).length} stings:${Object.keys(STINGS).length}`)
