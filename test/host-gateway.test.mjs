/**
 * host-gateway.test.mjs — one OpenAI-compatible relay at a time.
 *
 * The behaviour under test is mostly adversarial: an OLD one-api answers an
 * unknown route with `200` and an HTML page, and a naive probe would either
 * throw or invent a number out of the HTML. Both must end as `state:'error'`
 * with every numeric field left `null`.
 *
 * The cents conversion is pinned too: `/dashboard/billing/usage` reports
 * `total_usage` in CENTS, so `total_usage: 2234` is `$22.34`, not `$2234`.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { GATEWAY_KINDS, normalizeBases, probeGateway } from '../lib/core/gateway.js'

const API_KEY = 'sk-test-secret-abcdef123456'

const HTML_PAGE = '<!doctype html><html><head><title>One API</title></head><body>Not Found</body></html>'

const SUBSCRIPTION = { object: 'billing_subscription', has_payment_method: true, soft_limit_usd: 30, hard_limit_usd: 30, system_hard_limit_usd: 30 }
const USAGE = { object: 'list', total_usage: 2234, data: [] }
const USER_BALANCE = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }] }

/**
 * Start a mock relay. Unmapped paths answer `200 text/html` — exactly what an
 * old one-api does for every route it does not know.
 * @param {Record<string, object|Function>} routes - path -> response or factory.
 * @returns {Promise<{url: string, hits: object[], close: () => Promise<void>}>} the mock handle.
 */
async function startMockGateway(routes) {
  const hits = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    hits.push({ path: url.pathname, authorization: req.headers.authorization ?? '', method: req.method })
    const entry = routes[url.pathname]
    const spec = (typeof entry === 'function' ? entry(req) : entry) ?? { status: 200, contentType: 'text/html; charset=utf-8', body: HTML_PAGE }
    res.writeHead(spec.status ?? 200, { 'content-type': spec.contentType ?? 'application/json; charset=utf-8' })
    res.end(typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('gateway: normalizeBases tries the origin root before the /v1 root', () => {
  assert.deepEqual(normalizeBases('https://relay.example.com/v1'), ['https://relay.example.com/v1', 'https://relay.example.com'])
  assert.deepEqual(normalizeBases('https://relay.example.com/'), ['https://relay.example.com'])
  assert.deepEqual(normalizeBases('https://relay.example.com/V1/'), ['https://relay.example.com/V1', 'https://relay.example.com'])
  assert.deepEqual(normalizeBases(''), [])
  assert.deepEqual(normalizeBases(undefined), [])
  assert.deepEqual(GATEWAY_KINDS, ['auto', 'newapi', 'user-balance'])
})

test('gateway: total_usage is CENTS, so 2234 means $22.34 used', async (t) => {
  const mock = await startMockGateway({
    '/dashboard/billing/subscription': { body: SUBSCRIPTION },
    '/dashboard/billing/usage': { body: USAGE },
  })
  t.after(() => mock.close())

  const row = await probeGateway({ id: 'gw1', name: '中转站', baseUrl: mock.url, apiKey: API_KEY, kind: 'newapi' })
  assert.equal(row.state, 'ok')
  assert.equal(row.error, null)
  assert.equal(row.kind, 'newapi')
  assert.equal(row.currency, 'USD')
  assert.equal(row.total, 30)
  assert.equal(row.used, 22.34, 'cents must be divided by 100')
  assert.equal(row.remaining, 7.66)
  assert.equal(row.balance, null)
  assert.deepEqual(mock.hits.map((hit) => hit.path), ['/dashboard/billing/subscription', '/dashboard/billing/usage'])
  assert.equal(mock.hits[0].authorization, `Bearer ${API_KEY}`)
})

test('gateway: kind auto prefers the new-api billing endpoints', async (t) => {
  const mock = await startMockGateway({
    '/dashboard/billing/subscription': { body: SUBSCRIPTION },
    '/dashboard/billing/usage': { body: USAGE },
    '/user/balance': { body: USER_BALANCE },
  })
  t.after(() => mock.close())

  const row = await probeGateway({ baseUrl: mock.url, apiKey: API_KEY, kind: 'auto' })
  assert.equal(row.kind, 'newapi')
  assert.equal(row.remaining, 7.66)
  assert.equal(mock.hits.some((hit) => hit.path === '/user/balance'), false)
})

test('gateway: a 200 + HTML body is an error, with no invented numbers', async (t) => {
  // Only the usage route is mapped; the subscription route falls through to the
  // old one-api HTML page.
  const mock = await startMockGateway({ '/dashboard/billing/usage': { body: USAGE } })
  t.after(() => mock.close())

  const row = await probeGateway({ id: 'gw1', name: 'old relay', baseUrl: mock.url, apiKey: API_KEY, kind: 'newapi', debug: true })
  assert.equal(row.state, 'error')
  assert.match(row.error, /HTML/)
  assert.match(row.error, /旧版 one-api/)
  assert.equal(row.total, null)
  assert.equal(row.used, null)
  assert.equal(row.remaining, null)
  assert.equal(row.balance, null)
  assert.equal(row.currency, null)
  assert.equal(row.attempts[0].isHtml, true)
  assert.equal(row.attempts[0].status, 200)
  // The body excerpt is confined to the debug attempt log: it must never reach
  // the user-facing error, and it must never be parsed for digits.
  assert.equal(row.error.includes('<html'), false)
  assert.match(row.attempts[0].error, /<!doctype html>/)
})

test('gateway: kind user-balance reads balance_infos', async (t) => {
  const mock = await startMockGateway({
    '/user/balance': { body: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '7.6600' }, { currency: 'CNY', total_balance: '55' }] } },
  })
  t.after(() => mock.close())

  const row = await probeGateway({ baseUrl: mock.url, apiKey: API_KEY, kind: 'user-balance' })
  assert.equal(row.state, 'ok')
  assert.equal(row.kind, 'user-balance')
  assert.equal(row.balance, 55, 'a CNY entry is preferred when the gateway offers one')
  assert.equal(row.currency, 'CNY')
  assert.equal(row.total, null)
  assert.equal(row.used, null)
  assert.equal(row.remaining, null)
})

test('gateway: kind auto falls back to /user/balance when billing is HTML', async (t) => {
  const mock = await startMockGateway({ '/user/balance': { body: USER_BALANCE } })
  t.after(() => mock.close())

  const row = await probeGateway({ id: 'gw2', baseUrl: mock.url, apiKey: API_KEY, kind: 'auto', debug: true })
  assert.equal(row.state, 'ok')
  assert.equal(row.kind, 'user-balance')
  assert.equal(row.balance, 12.34)
  assert.equal(row.currency, 'CNY')
  assert.equal(row.attempts.some((attempt) => attempt.source === 'newapi-billing' && attempt.isHtml), true)
})

test('gateway: a trailing /v1 is retried against the origin root', async (t) => {
  const mock = await startMockGateway({
    '/dashboard/billing/subscription': { body: SUBSCRIPTION },
    '/dashboard/billing/usage': { body: USAGE },
  })
  t.after(() => mock.close())

  const row = await probeGateway({ baseUrl: `${mock.url}/v1`, apiKey: API_KEY, kind: 'auto' })
  assert.equal(row.state, 'ok')
  assert.equal(row.remaining, 7.66)
  // The /v1 attempt answered HTML and was abandoned, then the origin worked.
  assert.equal(mock.hits[0].path, '/v1/dashboard/billing/subscription')
  assert.equal(mock.hits.some((hit) => hit.path === '/dashboard/billing/subscription'), true)
})

test('gateway: an HTTP error status is reported as an error with that status', async (t) => {
  const mock = await startMockGateway({
    '/dashboard/billing/subscription': { status: 401, body: { error: { message: 'invalid token' } } },
  })
  t.after(() => mock.close())

  const row = await probeGateway({ baseUrl: mock.url, apiKey: API_KEY, kind: 'newapi' })
  assert.equal(row.state, 'error')
  assert.match(row.error, /HTTP 401/)
  assert.equal(row.remaining, null)
})

test('gateway: neither endpoint available gives the "no balance endpoint" error', async (t) => {
  const mock = await startMockGateway({
    '/dashboard/billing/subscription': { body: { hard_limit_usd: null } },
    '/dashboard/billing/usage': { body: { total_usage: null } },
    '/user/balance': { body: { is_available: true, balance_infos: [] } },
  })
  t.after(() => mock.close())

  const row = await probeGateway({ baseUrl: mock.url, apiKey: API_KEY, kind: 'auto' })
  assert.equal(row.state, 'error')
  assert.match(row.error, /没有暴露任何余额端点/)
})

test('gateway: an unconfigured gateway is `off`, and nothing is requested', async (t) => {
  const mock = await startMockGateway({})
  t.after(() => mock.close())

  const noKey = await probeGateway({ id: 'gw1', name: 'relay', baseUrl: mock.url, apiKey: '' })
  assert.equal(noKey.state, 'off')
  assert.equal(noKey.error, '未配置 apiKey（可填 apiKeyEnv 指向环境变量）')

  const noUrl = await probeGateway({ id: 'gw2', baseUrl: '', apiKey: API_KEY })
  assert.equal(noUrl.state, 'off')
  assert.equal(noUrl.error, '未配置 baseUrl')

  assert.deepEqual(mock.hits, [], 'an unconfigured gateway must not be probed at all')
})

test('gateway: the API key never appears anywhere in the returned row, even in debug logs', async (t) => {
  // The relay echoes the bearer token back in its error body — the classic way
  // a secret ends up in a log or a payload.
  const mock = await startMockGateway({
    '/dashboard/billing/subscription': { status: 403, body: { error: { message: `bad key ${API_KEY}` } } },
    '/dashboard/billing/usage': { status: 403, body: { message: `bad key ${API_KEY}` } },
    '/user/balance': { status: 403, body: `unauthorized: ${API_KEY}` },
  })
  t.after(() => mock.close())

  const row = await probeGateway({ baseUrl: mock.url, apiKey: API_KEY, kind: 'auto', debug: true })
  assert.equal(row.state, 'error')
  assert.equal(JSON.stringify(row).includes(API_KEY), false, 'the API key leaked into the gateway row')
  // A 403 on the subscription probe abandons the billing family, so the
  // user-balance fallback is the second and last attempt.
  assert.deepEqual(row.attempts.map((attempt) => attempt.source), ['newapi-billing', 'user-balance'])
  for (const attempt of row.attempts) {
    assert.equal(String(attempt.error ?? '').includes(API_KEY), false)
  }
})

test('gateway: an unreachable host is an error, never a throw', async () => {
  // Port 1 on loopback refuses immediately; no mock is needed.
  const row = await probeGateway({ baseUrl: 'http://127.0.0.1:1', apiKey: API_KEY, kind: 'newapi', timeoutMs: 2000 })
  assert.equal(row.state, 'error')
  assert.ok(row.error)
  assert.equal(row.remaining, null)
})