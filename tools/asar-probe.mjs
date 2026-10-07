// One-off probe: search the DSH app.asar bundle for how compaction/session-title
// model calls relate to the `agent/request` waterfall.
import { readFileSync } from 'node:fs'

const asar = 'D:/Program Files (x86)/DeepSeekHarness/resources/app.asar'
const buf = readFileSync(asar)

function findNeedle(needle, limit = 12) {
  const out = []
  const n = Buffer.from(needle, 'utf8')
  let from = 0
  while (out.length < limit) {
    const i = buf.indexOf(n, from)
    if (i < 0) break
    out.push(i)
    from = i + 1
  }
  return out
}

const needles = process.argv.slice(2)
if (needles.length === 0) needles.push("'agent/request'")
for (const needle of needles) {
  const hits = findNeedle(needle)
  console.log(`\n=== ${needle}: ${hits.length} hit(s) ===`)
  for (const i of hits.slice(0, 8)) {
    const start = Math.max(0, i - 200)
    const end = Math.min(buf.length, i + 300)
    console.log('--- @' + i + ' ---')
    console.log(JSON.stringify(buf.subarray(start, end).toString('utf8')))
  }
}
