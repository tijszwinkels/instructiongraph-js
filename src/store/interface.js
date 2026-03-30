/**
 * @typedef {Object} SearchQuery
 * @property {string} [by]
 * @property {string} [type]
 * @property {number} [limit]
 * @property {string} [cursor]
 * @property {boolean} [includeInboundCounts]
 */

/**
 * @typedef {Object} SearchResult
 * @property {object[]} items
 * @property {string|null} cursor
 * @property {boolean} hasMore
 * @property {string} [error]
 */

/**
 * @typedef {Object} Store
 * @property {(ref: string) => Promise<object|null>} get
 * @property {(signedObject: object) => Promise<{ok: boolean, status: number, object?: object, error?: string}>} put
 * @property {(query?: SearchQuery) => Promise<SearchResult>} search
 * @property {(ref: string, query?: SearchQuery & {relation?: string, from?: string}) => Promise<SearchResult>} inbound
 */

export {}
