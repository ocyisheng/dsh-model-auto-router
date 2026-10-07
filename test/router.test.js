/**
 * `node --test` entry point.
 *
 * The behavioural suite lives in `src/selftest.js` so that the exact same cases
 * can also run inside the DSH host (`selfTest: true`) and in a browser
 * (`node tools/build-harness.mjs`). This file only adapts it to the node:test
 * reporter — there is deliberately no second copy of the expectations.
 */

import test from 'node:test'

import { runSelfTest } from '../src/selftest.js'

const { results } = runSelfTest()

for (const result of results) {
  const name = result.name
  if (result.ok) {
    test(name, () => {})
  } else {
    // A throwing test gives node:test the failure message and the diff.
    test(name, () => { throw new Error(result.error) })
  }
}