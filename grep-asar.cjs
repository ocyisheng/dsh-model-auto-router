const fs = require('fs')
const b = fs.readFileSync('D:\\Program Files (x86)\\DeepSeekHarness\\resources\\app.asar')
const needles = ['自动识图', '区域受限', 'region-limited', 'deepseek-vision', 'vision-chain', '地区受限', '区域限制']
const safe = s => s.replace(/[^ -~一-鿿:,"{}\[\]]/g, '.')
for (const n of needles) {
  const nb = Buffer.from(n, 'utf8')
  let pos = -1, hits = 0
  while ((pos = b.indexOf(nb, pos + 1)) >= 0 && hits < 3) {
    hits++
    const ctx = safe(b.slice(Math.max(0, pos - 140), pos + 140).toString('utf8'))
    console.log(`[${n}]@${pos}: ${ctx}`)
  }
  if (hits === 0) console.log(`[${n}] NOT FOUND`)
}
