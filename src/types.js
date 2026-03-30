/**
 * JSDoc type definitions for instructiongraph-js.
 * No runtime code — import for IDE autocompletion only.
 */

/**
 * @typedef {Object} Signer
 * @property {string} pubkey - compressed P-256 pubkey, base64url, 44 chars
 * @property {(data: Uint8Array) => Promise<string>} sign - returns base64 DER signature
 */

/**
 * @typedef {Object} Keypair
 * @property {string} pubkey - compressed P-256 pubkey, base64url, 44 chars
 * @property {CryptoKey} privateKey - Web Crypto ECDSA private key
 */

/**
 * @typedef {Object} Item
 * @property {string} id - UUID
 * @property {string} pubkey - compressed P-256 pubkey, base64url
 * @property {string} ref - composite key: pubkey.id
 * @property {string[]} in - realm membership
 * @property {string} created_at - ISO 8601
 * @property {string} [updated_at] - ISO 8601
 * @property {number} [revision] - monotonic counter
 * @property {string} [type] - application-level type hint
 * @property {string} [name] - human-readable label
 * @property {string} [instruction] - self-describing text
 * @property {Object} [rights] - licensing info
 * @property {string} [rights.license] - SPDX identifier
 * @property {boolean} [rights.ai_training_allowed]
 * @property {Object<string, RelationEntry[]>} [relations] - named relation arrays
 * @property {Object} [content] - free-form payload
 */

/**
 * @typedef {Object} RelationEntry
 * @property {string} ref - composite key of target
 * @property {number} [revision] - pin to specific revision
 * @property {string} [title]
 * @property {string} [name]
 * @property {string} [summary]
 * @property {string} [url]
 * @property {string} [instruction]
 */

/**
 * @typedef {Object} Envelope
 * @property {string} is - must be "instructionGraph001"
 * @property {string} signature - base64 DER ECDSA signature
 * @property {Item} item - signed payload
 */

/**
 * @typedef {Object} SearchQuery
 * @property {string} [by] - filter by pubkey
 * @property {string} [type] - filter by type
 * @property {number} [limit]
 * @property {string} [cursor]
 * @property {boolean} [includeInboundCounts]
 */

/**
 * @typedef {Object} SearchResult
 * @property {Envelope[]} items
 * @property {string|null} cursor - for next page, null if no more
 */

/**
 * @typedef {Object} InboundQuery
 * @property {string} [relation] - filter by relation name
 * @property {string} [from] - filter by source pubkey
 * @property {string} [type] - filter by source type
 * @property {number} [limit]
 * @property {string} [cursor]
 * @property {boolean} [includeInboundCounts]
 */

/**
 * @typedef {Object} Store
 * @property {(ref: string) => Promise<Envelope|null>} get
 * @property {(signedObj: Envelope) => Promise<{ok: boolean, status?: number, error?: string}>} put
 * @property {(query: SearchQuery) => Promise<SearchResult>} search
 * @property {(ref: string, opts?: InboundQuery) => Promise<SearchResult>} inbound
 */

/**
 * @typedef {Object} IdentityConfig
 * @property {'pem'|'pem-file'|'credentials'|'signer'} type
 * @property {string} [pem] - PEM string (type=pem)
 * @property {string} [path] - path to PEM file (type=pem-file)
 * @property {string} [username] - (type=credentials)
 * @property {string} [password] - (type=credentials)
 * @property {Signer} [signer] - (type=signer)
 */

/**
 * @typedef {Object} ClientOptions
 * @property {Store} [store] - storage backend
 * @property {IdentityConfig|null} [identity] - signing identity (null = read-only)
 * @property {string} [defaultRealm] - default realm
 * @property {string} [configDir] - override config directory
 * @property {string} [hubUrl] - override hub URL
 */

export {}
