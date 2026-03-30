import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

import { canonicalJSON } from '../src/canonical.js'

const execFile = promisify(execFileCb)

test('canonicalJSON sorts keys recursively and stays compact', () => {
  const value = {
    z: 1,
    a: {
      y: true,
      x: [3, 'two', null],
    },
    m: 'hello',
  }

  assert.equal(
    canonicalJSON(value),
    '{"a":{"x":[3,"two",null],"y":true},"m":"hello","z":1}',
  )
})

test('canonicalJSON matches jq -cS output for nested data', async () => {
  const input = JSON.stringify({
    b: 2,
    a: { d: [3, { z: 1, a: 2 }], c: 'x' },
    n: null,
  })

  const { stdout } = await execFile('bash', ['-lc', `printf '%s' '${input.replace(/'/g, `'"'"'`)}' | jq -cS .`])
  assert.equal(canonicalJSON(JSON.parse(input)), stdout.trim())
})

test('canonicalJSON renders undefined like existing browser implementation', () => {
  assert.equal(canonicalJSON(undefined), 'null')
})
