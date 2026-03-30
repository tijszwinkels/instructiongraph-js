import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { canonicalJSON } from '../src/canonical.js'

describe('canonicalJSON', () => {
  it('handles null and undefined', () => {
    assert.equal(canonicalJSON(null), 'null')
    assert.equal(canonicalJSON(undefined), 'null')
  })

  it('handles primitives', () => {
    assert.equal(canonicalJSON(true), 'true')
    assert.equal(canonicalJSON(false), 'false')
    assert.equal(canonicalJSON(42), '42')
    assert.equal(canonicalJSON(3.14), '3.14')
    assert.equal(canonicalJSON('hello'), '"hello"')
  })

  it('handles strings with special chars', () => {
    assert.equal(canonicalJSON('he"llo'), '"he\\"llo"')
    assert.equal(canonicalJSON('back\\slash'), '"back\\\\slash"')
    assert.equal(canonicalJSON('new\nline'), '"new\\nline"')
  })

  it('handles arrays', () => {
    assert.equal(canonicalJSON([1, 2, 3]), '[1,2,3]')
    assert.equal(canonicalJSON([]), '[]')
    assert.equal(canonicalJSON([null, 'a', true]), '[null,"a",true]')
  })

  it('sorts object keys', () => {
    assert.equal(canonicalJSON({ b: 2, a: 1 }), '{"a":1,"b":2}')
    assert.equal(canonicalJSON({ z: 'z', a: 'a', m: 'm' }), '{"a":"a","m":"m","z":"z"}')
  })

  it('handles nested objects', () => {
    const obj = { b: { d: 4, c: 3 }, a: 1 }
    assert.equal(canonicalJSON(obj), '{"a":1,"b":{"c":3,"d":4}}')
  })

  it('handles mixed nested structures', () => {
    const obj = { arr: [{ z: 1, a: 2 }], val: 'x' }
    assert.equal(canonicalJSON(obj), '{"arr":[{"a":2,"z":1}],"val":"x"}')
  })

  it('matches jq -cS output', () => {
    const testCases = [
      { b: 2, a: 1, c: { z: 26, a: 1 } },
      { type: 'POST', content: { title: 'Hello', body: 'World' }, id: '123' },
      { in: ['dataverse001'], pubkey: 'AxyU5_test', relations: { author: [{ ref: 'abc.def' }] } },
    ]
    for (const obj of testCases) {
      const jsResult = canonicalJSON(obj)
      const jqResult = execSync(
        `echo '${JSON.stringify(obj)}' | jq -cS '.'`,
        { encoding: 'utf-8' }
      ).trim()
      assert.equal(jsResult, jqResult, `Mismatch for ${JSON.stringify(obj)}`)
    }
  })
})
