import fs from 'node:fs'
import path from 'node:path'

const asar = 'D:\\Program Files (x86)\\DeepSeekHarness\\resources\\app.asar'
const out = 'C:\\Temp\\dsh-asar'

const buf = fs.readFileSync(asar)
const marker = Buffer.from('{"files":')
const idx = buf.indexOf(marker)
if (idx < 0) throw new Error('header marker not found')
// The header length field is stored 4 bytes before the marker (uint32LE) in
// standard asar; here there is a 12-byte custom prefix, so we trust the JSON
// length we can measure from the parsed string.
const headerStr = buf.slice(idx).toString('utf8')
const header = JSON.parse(headerStr)
const dataStart = idx + Buffer.byteLength(headerStr, 'utf8')

function walk(node, dir) {
  if (!node || !node.files) return
  for (const [name, child] of Object.entries(node.files)) {
    const childPath = path.join(dir, name)
    if (child.files) {
      walk(child, childPath)
    } else if (child.size > 0) {
      const start = dataStart + (child.offset ? Number(child.offset) : 0)
      const data = buf.slice(start, start + child.size)
      const target = path.join(out, childPath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data)
    }
  }
}

walk(header.files[''], '')
console.log('extracted to', out)
