/**
 * host-routes.test.mjs — the security-relevant surface of the host half.
 *
 * Two things are proven here:
 *   1. the loopback fence runs BEFORE any work, so a non-loopback caller gets
 *      `403 {ok:false, error:"forbidden: loopback-only"}` and never a single
 *      byte of balance data, and
 *   2. a configuration with no sources at all still answers a valid
 *      `ok:false` payload instead of a 500.
 *
 * The happy path is exercised over a real loopback HTTP socket; the rejection
 * cases drive the handler directly with a synthetic request, because a test
 * cannot acquire a non-loopback source address.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import plugin, {
  API_PREFIX,
  SCHEMA_SOURCE,
  Config,
  apply,
  createRoutes,
  createRuntime,
  inject,
  isIPv4Loopback,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  name,
  readConfigField,
  writeJson,
} from '../lib/index.js'

/** A config with no source at all — every probe is skipped, so no network I/O. */
function offlineConfig() {
  return {
    enabled: true,
    pollIntervalSec: 60,
    showCoupons: true,
    showGateways: true,
    aliyun: { enabled: true, useAkFile: false, akId: '', akSecret: '', endpoint: '' },
    gateways: [],
  }
}

/** A runtime that cannot reach the network, with an environment of its own. */
function offlineRuntime() {
  return createRuntime({ config: offlineConfig(), env: {} })
}

/** Issue one real request against a loopback test server. */
function request(port, path, { method = 'GET', headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let responseBody = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { responseBody += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Serve a plugin route table over loopback so the fence sees a real socket. */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1')
    const route = routes.find((item) => item.path === pathname)
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no such route')
      return
    }
    void route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** A minimal IncomingMessage stand-in. */
function fakeRequest(overrides = {}) {
  return {
    url: `${API_PREFIX}/overview?lang=zh`,
    method: 'GET',
    headers: { host: '127.0.0.1:1234' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

/** A ServerResponse stand-in that records what was written. */
function fakeResponse() {
  const res = { status: 0, headers: null, body: null, ended: false }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.ended = true; res.body = body }
  return res
}

/* ------------------------------------------------------------ plugin shape */

test('index: the plugin exports the cordis contract and a frozen §3.4 schema', () => {
  assert.equal(name, 'dsh-qwen-balance')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof apply, 'function')
  assert.equal(plugin.name, 'dsh-qwen-balance')
  assert.deepEqual(plugin.inject, ['webServer'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.Config, Config)
  assert.equal(typeof SCHEMA_SOURCE, 'string')
  assert.ok(SCHEMA_SOURCE.length > 0)
})

test('index: Config resolves the SPEC §3.4 defaults without a volatile-path rejection', () => {
  // The literal §3.4 wording (per-entry volatile inside a volatile array) makes
  // schemastery refuse the schema outright; this asserts the shipped schema
  // constructs AND resolves.
  const resolved = Config({})
  assert.equal(readConfigField(resolved.enabled, null), true)
  assert.equal(readConfigField(resolved.pollIntervalSec, null), 60)
  assert.equal(readConfigField(resolved.showCoupons, null), true)
  assert.equal(readConfigField(resolved.showGateways, null), true)
  assert.deepEqual(readConfigField(resolved.gateways, null), [])

  const aliyun = readConfigField(resolved.aliyun, {})
  // The nested fields are cosmokit volatile refs as well, not plain values:
  // `readConfigField` is what unwraps them.
  assert.equal(readConfigField(aliyun.enabled, null), true)
  assert.equal(readConfigField(aliyun.useAkFile, null), true)
  assert.equal(readConfigField(aliyun.endpoint, null), '')
  assert.equal(readConfigField(aliyun.akFile, null), '')
})

test('index: Config accepts real values and enforces the documented bounds', () => {
  const resolved = Config({
    enabled: false,
    pollIntervalSec: 120,
    aliyun: { akId: 'id-from-config', endpoint: 'business.example.com' },
    gateways: [{ name: '中转站', baseUrl: 'https://relay.example.com', apiKey: 'sk-x', apiKeyEnv: '', kind: 'user-balance' }],
  })
  assert.equal(readConfigField(resolved.enabled, null), false)
  assert.equal(readConfigField(resolved.pollIntervalSec, null), 120)
  const aliyun = readConfigField(resolved.aliyun, {})
  assert.equal(readConfigField(aliyun.akId, null), 'id-from-config')
  assert.equal(readConfigField(aliyun.endpoint, null), 'business.example.com')
  const gateways = readConfigField(resolved.gateways, [])
  assert.equal(gateways.length, 1)
  assert.equal(readConfigField(gateways[0].kind, null), 'user-balance')
  assert.equal(readConfigField(gateways[0].baseUrl, null), 'https://relay.example.com')

  assert.throws(() => Config({ pollIntervalSec: 5 }), /min|below|30/i)
  assert.throws(() => Config({ pollIntervalSec: 99999 }), /max|above|3600/i)
})

/* ---------------------------------------------------------------- the fence */

test('fence: address and hostname predicates', () => {
  assert.equal(isIPv4Loopback('127.0.0.1'), true)
  assert.equal(isIPv4Loopback('127.9.9.9'), true)
  assert.equal(isIPv4Loopback('128.0.0.1'), false)
  assert.equal(isIPv4Loopback('10.0.0.1'), false)
  assert.equal(isIPv4Loopback('127.0.0.1.5'), false)
  assert.equal(isIPv4Loopback('127.0.0.999'), false)
  assert.equal(isIPv4Loopback('localhost'), false)

  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(isLoopbackAddress(undefined), false)

  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('evil.example.com'), false)
  assert.equal(isLoopbackHostname('127.0.0.1.evil.com'), false)
})

test('fence: isLoopbackRequest requires BOTH a loopback socket and a loopback Host', () => {
  assert.equal(isLoopbackRequest(fakeRequest()), true)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: 'localhost:1234' } })), true)

  // A remote socket can never be trusted, whatever it claims.
  assert.equal(isLoopbackRequest(fakeRequest({ socket: { remoteAddress: '10.1.2.3' } })), false)
  // DNS rebinding: a loopback socket with a foreign Host is refused.
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: 'evil.example.com' } })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: {} })), false)
  // A forwarded header is never an authorization.
  assert.equal(isLoopbackRequest(fakeRequest({ socket: { remoteAddress: '10.1.2.3' }, headers: { host: '127.0.0.1:1234', 'x-forwarded-for': '127.0.0.1' } })), false)
  // Browser same-origin markers.
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: '127.0.0.1:1234', 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: '127.0.0.1:1234', origin: 'http://evil.example.com' } })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' } })), true)
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: 'evil.example.com', origin: 'http://evil.example.com' } })), false)
})

test('fence: a non-loopback caller gets exactly 403 forbidden, before any probing', async () => {
  // `refresh` would reach the network; the fence must answer first.
  const runtime = createRuntime({ config: { ...offlineConfig(), enabled: true }, env: {} })
  let probed = 0
  runtime.ensure = () => { probed += 1; return { checkedAt: new Date().toISOString(), rows: [] } }
  runtime.refresh = () => { probed += 1; return { checkedAt: new Date().toISOString(), rows: [] } }
  for (const route of createRoutes(runtime)) {
    const res = fakeResponse()
    await route.handler(fakeRequest({ url: route.path, socket: { remoteAddress: '192.168.1.50' } }), res)
    assert.equal(res.status, 403, `${route.path} must refuse a non-loopback caller`)
    assert.equal(res.body, JSON.stringify({ ok: false, error: 'forbidden: loopback-only' }))
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    // No balance data can possibly be in a 403.
    assert.equal(res.body.includes('rows'), false)
  }
  assert.equal(probed, 0, 'the fence must run before any work')
})

test('fence: a foreign Host header on a loopback socket is still refused', async () => {
  const runtime = offlineRuntime()
  for (const route of createRoutes(runtime)) {
    const res = fakeResponse()
    await route.handler(fakeRequest({ url: route.path, headers: { host: 'attacker.example.com' } }), res)
    assert.equal(res.status, 403)
  }
})

test('fence: wrong methods are 405, not 404 and not 500', async () => {
  const runtime = offlineRuntime()
  const [overview, refresh] = createRoutes(runtime)

  const postOverview = fakeResponse()
  await overview.handler(fakeRequest({ method: 'POST' }), postOverview)
  assert.equal(postOverview.status, 405)
  assert.equal(postOverview.body, JSON.stringify({ ok: false, error: 'method not allowed' }))

  const getRefresh = fakeResponse()
  await refresh.handler(fakeRequest({ url: `${API_PREFIX}/refresh`, method: 'GET' }), getRefresh)
  assert.equal(getRefresh.status, 405)
  assert.equal(getRefresh.body, JSON.stringify({ ok: false, error: 'method not allowed' }))
})

test('index: writeJson owns the response contract', () => {
  const res = fakeResponse()
  writeJson(res, 200, { ok: true }, { 'cache-control': 'no-store' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

/* ------------------------------------------------------------ real HTTP path */

test('routes: both endpoints answer over a real loopback socket', async (t) => {
  const runtime = offlineRuntime()
  const routes = createRoutes(runtime)
  const server = await serve(routes)
  t.after(() => server.close())

  const overview = await request(server.port, `${API_PREFIX}/overview`)
  assert.equal(overview.status, 200)
  assert.match(overview.headers['content-type'], /application\/json/)
  assert.equal(overview.headers['cache-control'], 'no-store', 'the payload must never be cached')
  const payload = JSON.parse(overview.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.enabled, true)
  assert.equal(payload.error, null)
  assert.deepEqual(payload.rows, [])
  assert.equal(payload.lang, 'zh')
  assert.ok(payload.notes.length > 0, 'a source-less install must explain how to configure one')
  assert.match(payload.notes.join(' '), /ALIYUN_AK_ID/)

  const english = await request(server.port, `${API_PREFIX}/overview?lang=en`)
  const englishPayload = JSON.parse(english.body)
  assert.equal(englishPayload.lang, 'en')
  assert.deepEqual(englishPayload.rows, [])
  assert.notDeepEqual(englishPayload.notes, payload.notes)

  const badLang = await request(server.port, `${API_PREFIX}/overview?lang=fr`)
  assert.equal(JSON.parse(badLang.body).lang, 'en', 'an unknown tag folds onto a supported language')

  const refreshed = await request(server.port, `${API_PREFIX}/refresh`, { method: 'POST' })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(refreshed.body).rows, [])

  const wrongMethod = await request(server.port, `${API_PREFIX}/refresh`, { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.deepEqual(JSON.parse(wrongMethod.body), { ok: false, error: 'method not allowed' })
})

test('routes: a source-less configuration answers ok:false instead of failing', async (t) => {
  // Deliberately the "nothing configured" state: enabled, no AK, no gateways.
  const runtime = offlineRuntime()
  const server = await serve(createRoutes(runtime))
  t.after(() => server.close())

  for (let i = 0; i < 3; i += 1) {
    const res = await request(server.port, `${API_PREFIX}/overview`)
    assert.equal(res.status, 200, 'a missing configuration is not an HTTP error')
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.enabled, true)
    assert.deepEqual(payload.sources.gateways, [])
    assert.equal(payload.sources.aliyun.state, 'off')
    assert.equal(payload.sources.coupons.state, 'off')
  }
})

/* ---------------------------------------------------------------- activation */

test('apply: mounts three exact routes, and the disposer is idempotent', async (t) => {
  // Keep the activation's background warm-up completely offline, even if the
  // developer's own environment holds real credentials.
  const saved = {}
  for (const key of ['ALIYUN_AK_ID', 'ALIYUN_AK_SECRET', 'ALIYUN_STS_TOKEN', 'ALIYUN_BSS_ENDPOINT', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET']) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const routes = []
  const listeners = []
  const ctx = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect: (fn) => { fn() },
    on: (event, callback) => listeners.push([event, callback]),
    logger: { warn: () => {} },
  }

  const dispose = apply(ctx, offlineConfig())
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(routes.map((route) => route.path), [`${API_PREFIX}/overview`, `${API_PREFIX}/refresh`, `${API_PREFIX}/client-report`])
  assert.deepEqual(routes.map((route) => route.kind), ['exact', 'exact', 'exact'])
  assert.deepEqual(listeners.map(([event]) => event), ['loader/volatile-update'])
  assert.equal(typeof listeners[0][1], 'function')

  // Let the background warm-up settle, then tear down twice.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.doesNotThrow(() => { dispose(); dispose() })
  assert.deepEqual(routes, [], 'disposal must unregister every route')
})

test('apply: a disabled plugin mounts routes that report enabled:false', async (t) => {
  const runtime = createRuntime({ config: { ...offlineConfig(), enabled: false }, env: {} })
  const server = await serve(createRoutes(runtime))
  t.after(() => server.close())

  const res = await request(server.port, `${API_PREFIX}/overview`)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.enabled, false)
  assert.equal(payload.error, 'disabled')
  assert.equal(payload.ok, false)
  assert.deepEqual(payload.rows, [])
})

/* ---------------------------------------- v0.1.1 client diagnostics (§3.6) */

/** Post a client report over a real loopback socket. */
function postReport(port, payload, { raw = null, headers = {} } = {}) {
  return request(port, `${API_PREFIX}/client-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(payload),
  })
}

test('client-report: a valid report is accepted and surfaces as overview.client', async (t) => {
  const runtime = offlineRuntime()
  const server = await serve(createRoutes(runtime))
  t.after(() => server.close())

  const before = JSON.parse((await request(server.port, `${API_PREFIX}/overview`)).body)
  assert.ok('client' in before, 'the field is always present on v0.1.1')
  assert.equal(before.client, null, 'never-reported is null, not undefined')

  const posted = await postReport(server.port, {
    state: 'mounted',
    seat: { sidebar: true, foot: true, settings: true, usedFallback: false },
    rows: 4,
    expanded: true,
  })
  assert.equal(posted.status, 200)
  assert.deepEqual(JSON.parse(posted.body), { ok: true })

  const after = JSON.parse((await request(server.port, `${API_PREFIX}/overview`)).body)
  assert.deepEqual(Object.keys(after.client).sort(), ['at', 'error', 'expanded', 'rows', 'seat', 'state'])
  assert.equal(after.client.state, 'mounted')
  assert.deepEqual(after.client.seat, { sidebar: true, foot: true, settings: true, usedFallback: false })
  assert.equal(after.client.rows, 4)
  assert.equal(after.client.expanded, true)
  assert.equal(after.client.error, null)
  assert.ok(!Number.isNaN(Date.parse(after.client.at)), 'at is a host-generated ISO instant')

  const refreshed = JSON.parse((await request(server.port, `${API_PREFIX}/refresh`, { method: 'POST' })).body)
  assert.equal(refreshed.client.state, 'mounted', 'refresh carries the same diagnostics')
  assert.equal(runtime.clientReportTotal(), 1)
})

test('client-report: the body is normalized and bounded before it is kept', async (t) => {
  const runtime = offlineRuntime()
  const server = await serve(createRoutes(runtime))
  t.after(() => server.close())

  const posted = await postReport(server.port, {
    state: 'reseated',
    seat: { sidebar: 1, foot: 0, settings: 'yes', usedFallback: null, extra: 'dropped' },
    rows: 3.9,
    expanded: 'no',
    error: `  seat\n  failed   with   spaces  ${'x'.repeat(300)}`,
    at: '1999-01-01T00:00:00.000Z',
    seq: 999,
    secret: 'must-not-be-kept',
  })
  assert.equal(posted.status, 200)

  const client = JSON.parse((await request(server.port, `${API_PREFIX}/overview`)).body).client
  assert.deepEqual(Object.keys(client.seat).sort(), ['foot', 'settings', 'sidebar', 'usedFallback'])
  assert.deepEqual(client.seat, { sidebar: true, foot: false, settings: true, usedFallback: false })
  assert.equal(client.rows, 3, 'rows is floored to a non-negative integer')
  assert.equal(client.expanded, null, 'a non-boolean expanded is refused, not coerced')
  assert.equal(client.error.length, 200)
  assert.ok(!client.error.includes('\n'), 'whitespace is collapsed')
  assert.ok(!('seq' in client) && !('secret' in client), 'unknown fields never reach the payload')
  assert.notEqual(client.at, '1999-01-01T00:00:00.000Z', 'the host stamps at; the client cannot')
})

test('client-report: unusable bodies are refused with 400 and never stored', async (t) => {
  const runtime = offlineRuntime()
  const server = await serve(createRoutes(runtime))
  t.after(() => server.close())

  for (const payload of [{ state: 'exploded' }, {}, null, [], { state: 42 }]) {
    const res = await postReport(server.port, payload)
    assert.equal(res.status, 400, `unusable body must be 400: ${JSON.stringify(payload)}`)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'invalid client report' })
  }
  assert.equal((await postReport(server.port, null, { raw: '{"state":' })).status, 400)
  assert.equal((await postReport(server.port, null, { raw: '' })).status, 400, 'an empty body is not a report')

  assert.equal(runtime.clientReport(), null, 'nothing invalid may be stored')
  assert.equal(runtime.clientReportTotal(), 0)
})

test('client-report: an oversized body is 413 and a wrong method is 405', async (t) => {
  const runtime = offlineRuntime()
  const server = await serve(createRoutes(runtime))
  t.after(() => server.close())

  const big = await postReport(server.port, { state: 'mounted', pad: 'x'.repeat(4000) })
  assert.equal(big.status, 413)
  assert.deepEqual(JSON.parse(big.body), { ok: false, error: 'payload too large' })

  const wrong = await request(server.port, `${API_PREFIX}/client-report`, { method: 'GET' })
  assert.equal(wrong.status, 405)
  assert.deepEqual(JSON.parse(wrong.body), { ok: false, error: 'method not allowed' })

  assert.equal(runtime.clientReport(), null)
})

test('client-report: a non-loopback caller is fenced out before the body is read', async () => {
  const runtime = offlineRuntime()
  const route = createRoutes(runtime).find((item) => item.path === `${API_PREFIX}/client-report`)
  const req = fakeRequest({
    url: `${API_PREFIX}/client-report`,
    method: 'POST',
    headers: { host: 'example.com' },
    socket: { remoteAddress: '203.0.113.7' },
  })
  const res = fakeResponse()
  await route.handler(req, res)
  assert.equal(res.status, 403)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'forbidden: loopback-only' })
  assert.equal(runtime.clientReportTotal(), 0)
})