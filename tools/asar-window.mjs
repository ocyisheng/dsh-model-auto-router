// One-off probe: print a byte window of app.asar around given offsets.
import { readFileSync } from 'node:fs'

const asar = 'D:/Program Files (x86)/DeepSeekHarness/resources/app.asar'
const buf = readFileSync(asar)

const offset = Number(process.argv[2])
const before = Number(process.argv[3] ?? 1500)
const after = Number(process.argv[4] ?? 3000)
const start = Math.max(0, offset - before)
const end = Math.min(buf.length, offset + after)
console.log(buf.subarray(start, end).toString('utf8'))
