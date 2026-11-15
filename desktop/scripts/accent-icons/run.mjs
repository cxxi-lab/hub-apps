// Renders the icon in each accent (resources/icons/<accent>/): the hub mark with the accent's logo gradient
// (hub-ui styles/theme.css, --color-brand-300/500, as hex), drawn by Chromium. Run with the dev app open
// (its DevTools port, 9222): node scripts/accent-icons/run.mjs scripts/accent-icons/render.js resources/icons
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = targets.find(t => t.type === 'page' && t.url.includes('localhost:5174/'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
const res = await new Promise(r => { ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) r(m.result) }); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: readFileSync(process.argv[2], 'utf8'), returnByValue: true, awaitPromise: true } })) })
const out = res.result.value
const root = process.argv[3]
for (const [name, sizes] of Object.entries(out)) {
  mkdirSync(`${root}/${name}`, { recursive: true })
  for (const [size, b64] of Object.entries(sizes)) writeFileSync(`${root}/${name}/${size}x${size}.png`, Buffer.from(b64, 'base64'))
}
console.log(Object.keys(out).join(' '))
process.exit(0)
