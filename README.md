# @instructiongraph/ig

Zero-dependency JavaScript library for [InstructionGraph](https://dataverse001.net) — works in browsers and Node.js 18+.

## Quick Start

```js
import { createClient, createHubStore } from '@instructiongraph/ig'

// Read-only
const ig = createClient({
  store: createHubStore({ url: 'https://dataverse001.net' })
})

const post = await ig.get('AxyU5_...346bef5e...')
const feed = await ig.search({ type: 'POST', limit: 20 })

// With identity (for writing)
const ig = createClient({
  store: createHubStore({ url: 'https://dataverse001.net' }),
  identity: { type: 'credentials', username: 'alice', password: 'secret' }
})

const ref = await ig.create({
  type: 'POST',
  content: { title: 'Hello', body: 'World' }
})
```

## Status

🚧 Under construction — see `HANDOFF.md` for implementation plan.
