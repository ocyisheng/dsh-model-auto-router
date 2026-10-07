/**
 * Report dead code and unused copy in the client bundle.
 *
 * A hand-written bundle has no compiler to notice an orphan, and the parity test
 * only checks that zh and en agree — not that a key is still reachable. This
 * finds both so the file does not accumulate the previous design's leftovers.
 *
 * Usage: node tools/dead-code.mjs
 */

import { readFileSync } from 'node:fs'

const source = readFileSync('client.js', 'utf8')

// The dictionaries are the only place a quoted key appears as `'key':`, so the
// region between DICT and its closing brace is excluded from the search.
const dictStart = source.indexOf('const DICT = {')
const dictEnd = source.indexOf('\n    }\n', dictStart)
const body = source.slice(0, dictStart) + source.slice(dictEnd)

const dict = source.slice(dictStart, dictEnd)
const keys = [...dict.matchAll(/^\s*'?([a-zA-Z][\w.]*)'?:/gm)].map(match => match[1])
const unique = [...new Set(keys)].sort()

const unusedKeys = unique.filter(key => !body.includes(`'${key}'`))

// Named functions and consts declared once and never referenced again.
const declared = [...source.matchAll(/^    (?:const|function) ([A-Za-z_$][\w$]*)/gm)].map(match => match[1])
const unusedNames = [...new Set(declared)].filter(name => {
  const uses = (source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
  return uses <= 1
})

console.log(`dictionary keys: ${unique.length}`)
console.log(unusedKeys.length === 0 ? 'no unused copy' : `unused copy (${unusedKeys.length}):\n  ${unusedKeys.join('\n  ')}`)
console.log(unusedNames.length === 0 ? 'no unused declarations' : `unused declarations (${unusedNames.length}):\n  ${unusedNames.join('\n  ')}`)
