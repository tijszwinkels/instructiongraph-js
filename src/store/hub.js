import { canonicalJSON } from '../canonical.js'

const textEncoder = new TextEncoder()

function normalizeBaseUrl(url) {
  return url.endsWith('/') ? url : `${url}/`
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, normalizeBaseUrl(baseUrl))
  if (query) {
    for (const [key, value] of query) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.append(key, String(value))
      }
    }
  }
  return url
}

function mapListResponse(body, fallbackError) {
  if (!body || typeof body !== 'object') {
    return { items: [], cursor: null, hasMore: false, error: fallbackError }
  }

  return {
    items: Array.isArray(body.items) ? body.items : [],
    cursor: body.cursor ?? null,
    hasMore: Boolean(body.has_more),
    ...(fallbackError ? { error: fallbackError } : {}),
  }
}

export function createHubStore(options = {}) {
  const {
    url = 'https://dataverse001.net',
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    token = null,
    getToken,
    headers: defaultHeaders = {},
    credentials = 'include',
    userAgent,
  } = options

  if (!fetchImpl) {
    throw new Error('fetch API is not available in this runtime')
  }

  let authToken = token

  async function resolveToken() {
    if (getToken) return await getToken()
    return authToken
  }

  async function request(path, requestOptions = {}) {
    const {
      method = 'GET',
      query,
      body,
      auth = true,
      headers = {},
    } = requestOptions

    const finalHeaders = {
      Accept: 'application/json',
      ...defaultHeaders,
      ...headers,
    }

    if (userAgent) finalHeaders['User-Agent'] = userAgent
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'

    if (auth) {
      const bearer = await resolveToken()
      if (bearer) finalHeaders.Authorization = `Bearer ${bearer}`
    }

    try {
      const response = await fetchImpl(buildUrl(url, path, query), {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : canonicalJSON(body),
        credentials,
      })

      const text = await response.text()
      let json = null
      if (text) {
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
      }

      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        body: json,
        error: response.ok ? null : json?.error ?? response.statusText ?? `HTTP ${response.status}`,
      }
    } catch {
      return {
        ok: false,
        status: 0,
        headers: new Headers(),
        body: null,
        error: 'hub unreachable',
      }
    }
  }

  return {
    async get(ref) {
      const response = await request(`/${ref}`)
      if (response.ok) return response.body
      if (response.status === 404 || response.status === 0) return null
      return null
    },

    async put(signedObject) {
      const ref = signedObject?.item?.ref
      if (!ref) {
        return { ok: false, status: 0, error: 'signed object is missing item.ref' }
      }

      const response = await request(`/${ref}`, {
        method: 'PUT',
        body: signedObject,
      })

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          object: response.body,
        }
      }

      return {
        ok: false,
        status: response.status,
        error: response.error,
        ...(response.body ? { object: response.body } : {}),
      }
    },

    async search(query = {}) {
      const response = await request('/search', {
        query: [
          ['by', query.by],
          ['type', query.type],
          ['limit', query.limit],
          ['cursor', query.cursor],
          ['include', query.includeInboundCounts ? 'inbound_counts' : undefined],
        ],
      })

      return mapListResponse(response.body, response.ok ? null : response.error)
    },

    async inbound(ref, query = {}) {
      const response = await request(`/${ref}/inbound`, {
        query: [
          ['relation', query.relation],
          ['from', query.from],
          ['type', query.type],
          ['limit', query.limit],
          ['cursor', query.cursor],
          ['include', query.includeInboundCounts ? 'inbound_counts' : undefined],
        ],
      })

      return mapListResponse(response.body, response.ok ? null : response.error)
    },

    async getChallenge() {
      const response = await request('/auth/challenge', { auth: false })
      if (!response.ok || !response.body?.challenge) {
        throw new Error(response.error ?? 'failed to fetch auth challenge')
      }
      return response.body
    },

    async authenticate(signer) {
      const challenge = await this.getChallenge()
      const signature = await signer.sign(textEncoder.encode(challenge.challenge))
      const response = await request('/auth/token', {
        method: 'POST',
        auth: false,
        body: {
          pubkey: signer.pubkey,
          challenge: challenge.challenge,
          signature,
        },
      })

      if (!response.ok || !response.body?.token) {
        throw new Error(response.error ?? 'failed to authenticate with hub')
      }

      authToken = response.body.token
      return response.body
    },

    async logout() {
      const response = await request('/auth/logout', { method: 'POST' })
      authToken = null
      return {
        ok: response.ok,
        status: response.status,
        ...(response.body ? { body: response.body } : {}),
        ...(response.ok ? {} : { error: response.error }),
      }
    },

    getToken() {
      return authToken
    },

    setToken(nextToken) {
      authToken = nextToken ?? null
    },
  }
}
