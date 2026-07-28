#!/usr/bin/env node
/**
 * Test-support: a stand-in for the `fdev` binary, so the CLI's whole flow can
 * be exercised offline — no Freenet node, no network, no shared node touched.
 *
 * Behaviour is driven by a JSON state file named in FAKE_FDEV_STATE:
 *
 *   {
 *     "contracts":   { "<contract-id>": <state> },   // what the node holds
 *     "failUpdate":  ["<contract-id>", ...],         // pokes that get rejected
 *     "failPublish": ["<wasm basename>", ...],       // PUTs that fail
 *     "swallowPublish": ["<wasm basename>", ...],    // PUTs accepted, state
 *                                                    //   never stored — the
 *                                                    //   real "placement did
 *                                                    //   not stick" failure
 *     "hang":        ["<contract-id>", ...],         // GETs that never answer
 *     "calls":       []                              // appended, for assertions
 *   }
 *
 * PUTs are stored under the id they address, so a publish followed by the
 * flow's GET-back gate behaves like a real node. Deriving that id uses this
 * repo's own addressing module: the fixture is therefore NOT independent
 * evidence that ids are correct — the golden-vector unit tests and the live
 * e2e cover that. What this fixture is evidence for is flow orchestration:
 * call order, the DEV-2 probe/create/poke arms, per-target reporting, output
 * formatting and exit codes.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { contractId } from '../src/freenet/addressing.js'
import { blake3 } from '../src/freenet/blake3.js'

const statePath = process.env.FAKE_FDEV_STATE
if (!statePath) {
  process.stderr.write('fake-fdev: FAKE_FDEV_STATE is not set\n')
  process.exit(2)
}

const state = JSON.parse(readFileSync(statePath, 'utf-8'))
state.calls ??= []
state.contracts ??= {}

const argv = process.argv.slice(2)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}

const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2))
const fail = (msg, code = 1) => {
  save()
  process.stderr.write(`[31mError: ${msg}[0m\n`)
  process.exit(code)
}

const idFor = (wasmPath, paramsPath) =>
  contractId(blake3(new Uint8Array(readFileSync(wasmPath))), new Uint8Array(readFileSync(paramsPath)))

// `fdev -p PORT execute get <ID> --output F --timeout S`
if (argv[2] === 'execute' && argv[3] === 'get') {
  const id = argv[4]
  state.calls.push({ op: 'get', id, timeout: valueOf('--timeout') })
  if (state.hang?.includes(id)) {
    save()
    // Outlive any timeout the caller set, so the caller's bound is what fires.
    setTimeout(() => process.exit(0), 10 * 60_000)
  } else if (!(id in state.contracts)) {
    fail(`contract not found: ${id}`)
  } else {
    writeFileSync(valueOf('--output'), JSON.stringify(state.contracts[id]))
    save()
    process.exit(0)
  }
}

// `fdev -p PORT execute update <ID> <DELTA> --timeout S`
else if (argv[2] === 'execute' && argv[3] === 'update') {
  const id = argv[4]
  const payload = JSON.parse(readFileSync(argv[5], 'utf-8'))
  state.calls.push({ op: 'update', id, payload })
  if (state.failUpdate?.includes(id)) fail(`InvalidUpdateWithInfo: contract rejected the poke for ${id}`)
  save()
  process.exit(0)
}

// `fdev -p PORT publish --code W --parameters P --timeout S contract --state S`
else if (argv[2] === 'publish') {
  const wasmPath = valueOf('--code')
  const id = idFor(wasmPath, valueOf('--parameters'))
  const published = JSON.parse(readFileSync(valueOf('--state'), 'utf-8'))
  state.calls.push({ op: 'publish', id, wasm: basename(wasmPath) })
  if (state.failPublish?.includes(basename(wasmPath))) fail('put timed out after 1 peer attempt(s)')
  // A real node's merge is LWW; first write wins here unless it is an index
  // being (re)created, which unions — close enough for flow assertions.
  if (!state.swallowPublish?.includes(basename(wasmPath))) state.contracts[id] ??= published
  save()
  process.stdout.write(`response_key: ${id}\n`)
  process.exit(0)
}

else fail(`fake-fdev: unsupported invocation: ${argv.join(' ')}`, 2)
