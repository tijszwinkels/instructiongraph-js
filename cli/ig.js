#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

import { createClient, verifyItemSignature } from '../src/index.js'

function usage() {
  console.error(`Usage:
  ig get <ref>
  ig search [--by PUBKEY] [--type TYPE] [--limit N] [--cursor CURSOR] [--include-inbound-counts]
  ig sign <spec.json>
  ig create <spec.json>
  ig verify <file.json>
  ig auth
  ig logout`)
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function parseFlags(args) {
  const options = {}
  const positionals = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }

    const name = arg.slice(2)
    if (name === 'include-inbound-counts') {
      options.includeInboundCounts = true
      continue
    }

    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`)
    }
    index += 1

    switch (name) {
      case 'by':
        options.by = value
        break
      case 'type':
        options.type = value
        break
      case 'limit':
        options.limit = Number.parseInt(value, 10)
        break
      case 'cursor':
        options.cursor = value
        break
      default:
        throw new Error(`Unknown option: --${name}`)
    }
  }

  return { options, positionals }
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command) {
    usage()
    process.exitCode = 1
    return
  }

  switch (command) {
    case 'get': {
      const ref = rest[0]
      if (!ref) throw new Error('Usage: ig get <ref>')
      const object = await createClient().get(ref)
      if (!object) {
        throw new Error(`Object not found: ${ref}`)
      }
      printJson(object)
      return
    }

    case 'search': {
      const { options, positionals } = parseFlags(rest)
      if (positionals.length > 0) throw new Error('Usage: ig search [--by PUBKEY] [--type TYPE] [--limit N] [--cursor CURSOR] [--include-inbound-counts]')
      printJson(await createClient().search(options))
      return
    }

    case 'sign': {
      const specPath = rest[0]
      if (!specPath) throw new Error('Usage: ig sign <spec.json>')
      printJson(await createClient().sign(await readJsonFile(specPath)))
      return
    }

    case 'create': {
      const specPath = rest[0]
      if (!specPath) throw new Error('Usage: ig create <spec.json>')
      process.stdout.write(`${await createClient().create(await readJsonFile(specPath))}\n`)
      return
    }

    case 'verify': {
      const filePath = rest[0]
      if (!filePath) throw new Error('Usage: ig verify <file.json>')
      const ok = await verifyItemSignature(await readJsonFile(filePath))
      if (!ok) {
        console.error('Invalid signature')
        process.exitCode = 1
        return
      }
      process.stdout.write('Verified OK\n')
      return
    }

    case 'auth': {
      printJson(await createClient().authenticate())
      return
    }

    case 'logout': {
      printJson(await createClient().logout())
      return
    }

    default:
      usage()
      throw new Error(`Unknown command: ${command}`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
