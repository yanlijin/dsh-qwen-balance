/**
 * host-collect.test.mjs — the whole cycle, against mock sources.
 *
 * This is the test that would have caught the original bug class: it wires a
 * mocked Alibaba Cloud BSS endpoint and a mocked relay into `collectOnce`, and
 * then asserts the properties that matter when something breaks —
 *
 *   - one failing source never removes another source's rows,
 *   - the coupon rows carry the right totals (Available only),
 *   - a configuration with no sources is `ok:false`, not an exception,
 *   - and no secret ever reaches the payload.
 */

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import http from 'node:http'
import test from 'node:test'

import { maskKey } from '../lib/core/ak.js'
import { collectOnce, Config } from '../lib/index.js'

const NOW = '2026-10-21T04:00:00.000Z'
const AK_ID = 'testid'
const AK_SECRET = 'testsecret'
const GATEWAY_KEY = 'sk-test-secret-abcdef123456'

/* ------------------------------------------------------------------ mocks */

function mockEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/!/g, '%21')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/%7E/g, '~')
}

/**
 * A mock BSS endpoint that independently re-derives the RPC V1.0 signature and
 * refuses anything it cannot reproduce.
 * @param {string} expectedSecret - the AccessKey secret it will accept.
 * @returns {Promise<{url: string, badSignatures: number, close: Function}>} the mock handle.
 */
async function startMockBss(expectedSecret) {
  const state = { badSignatures: 0 }
  const server = http.createServer((req, res) => {
    const params = Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams.entries())
    const signature = params.Signature
    delete params.Signature
    const canonical = Object.keys(params).sort().map((key) => `${mockEncode(key)}=${mockEncode(params[key])}`).join('&')
    const expected = createHmac('sha1', `${expectedSecret}&`).update(`GET&${mockEncode('/')}&${mockEncode(canonical)}`, 'utf8').digest('base64')
    if (expected !== signature) {
      state.badSignatures += 1
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Code: 'SignatureDoesNotMatch' }))
      return
    }
    const body = params.Action === 'QueryAccountBalance'
      ? {
          RequestId: 'REQ-B', Code: '200', Success: true,
          Data: { AvailableAmount: '263.66', AvailableCashAmount: '263.66', CreditAmount: '0', Currency: 'CNY' },
        }
      : {
          RequestId: 'REQ-C', Code: '200', Success: true,
          Data: {
            TotalCount: 3,
            CashCoupon: [
              { CashCouponNo: 'Q-100', Status: 'Available', NominalValue: '500', Balance: '263.66', ExpiryTime: '2027-10-20T00:00:00Z', ApplicableScenarios: '通用' },
              { CashCouponNo: 'Q-200', Status: 'Available', NominalValue: '100', Balance: '50', ExpiryTime: '2026-01-05T00:00:00Z', ApplicableScenarios: '通用' },
              { CashCouponNo: 'Q-300', Status: 'Expired', NominalValue: '20', Balance: '0', ExpiryTime: '2024-01-01T00:00:00Z', ApplicableScenarios: '通用' },
            ],
          },
        }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get badSignatures() { return state.badSignatures },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * A mock relay that speaks the new-api billing routes.
 * @param {object} [options] - mock options.
 * @param {'json'|'html'} [options.billing] - `'html'` makes the billing routes
 *   answer `200 text/html`, reproducing a relay that does not implement them
 *   (old one-api answers HTML to every route it does not recognize).
 * @returns {Promise<{url: string, close: Function}>} the mock handle.
 */
async function startMockGateway({ billing = 'json' } = {}) {
  const billingPaths = ['/dashboard/billing/subscription', '/dashboard/billing/usage']
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1')
    if (billing === 'html' && billingPaths.includes(pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>Not Found</body></html>')
      return
    }
    const bodies = {
      '/dashboard/billing/subscription': { hard_limit_usd: 30, soft_limit_usd: 30 },
      '/dashboard/billing/usage': { object: 'list', total_usage: 2234 },
    }
    const body = bodies[pathname]
    if (!body) {
      // Old one-api: 200 + HTML for anything it does not recognize.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>Not Found</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Aliyun section pointing at a mock, with the AK file switched off. */
function aliyunConfig(endpoint) {
  return { enabled: true, endpoint, akId: AK_ID, akSecret: AK_SECRET, useAkFile: false, akFile: '' }
}

/* ------------------------------------------------------------------- tests */

test('collect: a healthy cycle produces the SPEC rows from every source', async (t) => {
  const bss = await startMockBss(AK_SECRET)
  const relay = await startMockGateway()
  t.after(() => Promise.all([bss.close(), relay.close()]))

  const snapshot = await collectOnce({
    config: {
      enabled: true,
      aliyun: aliyunConfig(bss.url),
      gateways: [{ name: '中转站', baseUrl: relay.url, apiKey: GATEWAY_KEY, kind: 'newapi' }],
    },
    env: {},
    now: NOW,
  })

  assert.equal(snapshot.checkedAt, NOW)
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.aliyun.state, 'ok')
  assert.equal(snapshot.aliyun.availableAmount, 263.66)
  assert.equal(snapshot.aliyun.currency, 'CNY')
  assert.equal(snapshot.coupons.state, 'ok')
  assert.equal(snapshot.coupons.availableBalance, 313.66)
  assert.equal(snapshot.coupons.availableCount, 2)
  assert.equal(snapshot.coupons.totalCount, 3)
  assert.equal(snapshot.coupons.items.length, 3)
  assert.equal(snapshot.coupons.akIdMasked, maskKey(AK_ID))
  assert.equal(snapshot.coupons.nearestExpiry, '2026-01-05T00:00:00Z')
  assert.equal(snapshot.gateways.length, 1)
  assert.equal(snapshot.gateways[0].state, 'ok')
  assert.equal(snapshot.gateways[0].remaining, 7.66)
  assert.equal(bss.badSignatures, 0, 'the mock must have verified every signature')
  assert.equal(snapshot.ok, undefined, 'the snapshot is language-neutral and has no ok flag')

  const payload = JSON.parse(JSON.stringify(snapshot))
  assert.equal(JSON.stringify(payload).includes(AK_SECRET), false)
  assert.equal(JSON.stringify(payload).includes(GATEWAY_KEY), false)
})

test('collect: a dead Alibaba Cloud source does not remove the gateway rows', async (t) => {
  const relay = await startMockGateway()
  t.after(() => relay.close())

  const snapshot = await collectOnce({
    config: {
      enabled: true,
      // Port 1 refuses immediately, so this source fails fast and offline.
      aliyun: aliyunConfig('http://127.0.0.1:1'),
      gateways: [{ name: '中转站', baseUrl: relay.url, apiKey: GATEWAY_KEY }],
    },
    env: {},
    now: NOW,
    timeoutMs: 2000,
  })

  assert.equal(snapshot.aliyun.state, 'error')
  assert.equal(snapshot.aliyun.availableAmount, null)
  assert.equal(snapshot.coupons.state, 'error')
  assert.equal(snapshot.coupons.items.length, 0)
  assert.equal(snapshot.gateways[0].state, 'ok', 'one broken source must not affect another')
  assert.equal(snapshot.gateways[0].remaining, 7.66)
  assert.equal(snapshot.notes.some((note) => note.key === 'note.gateway.off' || note.key === 'note.gateway.error'), false)
  assert.equal(JSON.stringify(snapshot).includes(AK_SECRET), false, 'the failing source must not leak its secret')
})

test('collect: a broken relay does not remove the coupon rows', async (t) => {
  const bss = await startMockBss(AK_SECRET)
  t.after(() => bss.close())

  const snapshot = await collectOnce({
    config: {
      enabled: true,
      aliyun: aliyunConfig(bss.url),
      // An origin that answers HTML to everything: the old one-api trap.
      gateways: [{ name: 'old relay', baseUrl: 'http://127.0.0.1:1', apiKey: GATEWAY_KEY, kind: 'newapi' }],
    },
    env: {},
    now: NOW,
    timeoutMs: 2000,
  })

  assert.equal(snapshot.coupons.state, 'ok')
  assert.equal(snapshot.coupons.availableBalance, 313.66)
  assert.equal(snapshot.gateways[0].state, 'error')
  assert.equal(snapshot.gateways[0].remaining, null)
})

test('collect: a relaying HTML gateway is reported as HTML, with no invented numbers', async (t) => {
  const bss = await startMockBss(AK_SECRET)
  t.after(() => bss.close())

  // This relay answers `200 text/html` to the billing routes — the old one-api
  // behaviour. It must be reported as HTML, never mined for digits.
  const relay = await startMockGateway({ billing: 'html' })
  t.after(() => relay.close())

  const snapshot = await collectOnce({
    config: {
      enabled: true,
      aliyun: aliyunConfig(bss.url),
      gateways: [{ name: 'old relay', baseUrl: relay.url, apiKey: GATEWAY_KEY, kind: 'newapi' }],
    },
    env: {},
    now: NOW,
  })
  assert.equal(snapshot.gateways[0].state, 'error')
  assert.match(snapshot.gateways[0].error, /HTML/)
  assert.equal(snapshot.gateways[0].remaining, null)
  assert.equal(snapshot.gateways[0].total, null, 'no number may be invented from HTML')
  assert.equal(snapshot.aliyun.state, 'ok', 'the BSS source is untouched by the relay failure')
})

test('collect: apiKeyEnv wins over an inline apiKey', async (t) => {
  const relay = await startMockGateway()
  t.after(() => relay.close())

  const snapshot = await collectOnce({
    config: {
      enabled: true,
      aliyun: { enabled: false, useAkFile: false, akId: '', akSecret: '' },
      gateways: [{ name: 'relay', baseUrl: relay.url, apiKey: 'inline-key-should-lose', apiKeyEnv: 'MY_RELAY_KEY' }],
    },
    env: { MY_RELAY_KEY: GATEWAY_KEY },
    now: NOW,
  })
  assert.equal(snapshot.gateways[0].state, 'ok')
  assert.equal(JSON.stringify(snapshot).includes('inline-key-should-lose'), false)
})

test('collect: no source configured is ok:false with guidance, never a throw', async () => {
  const snapshot = await collectOnce({
    config: { enabled: true, aliyun: { enabled: true, useAkFile: false, akId: '', akSecret: '', endpoint: '' }, gateways: [] },
    env: {},
    now: NOW,
  })
  assert.equal(snapshot.aliyun.state, 'off')
  assert.equal(snapshot.coupons.state, 'off')
  assert.deepEqual(snapshot.gateways, [])
  assert.deepEqual(snapshot.notes, [{ key: 'note.noSource' }])
})

test('collect: disabled short-circuits without touching the network', async () => {
  const snapshot = await collectOnce({
    config: { enabled: false, aliyun: aliyunConfig('http://127.0.0.1:1'), gateways: [{ baseUrl: 'http://127.0.0.1:1', apiKey: GATEWAY_KEY }] },
    env: {},
    now: NOW,
  })
  assert.equal(snapshot.enabled, false)
  assert.equal(snapshot.gateways.length, 0)
  assert.equal(snapshot.aliyun.state, 'off')
  // `renderOverview` is what turns the disabled flag into the user-facing note.
  assert.deepEqual(snapshot.notes, [])
})

test('collect: a malformed gateway entry becomes an `off` row instead of a crash', async () => {
  const snapshot = await collectOnce({
    config: { enabled: true, aliyun: { enabled: false, useAkFile: false }, gateways: [null, { name: 'no url' }] },
    env: {},
    now: NOW,
  })
  assert.equal(snapshot.gateways.length, 2)
  assert.equal(snapshot.gateways[0].state, 'off')
  assert.equal(snapshot.gateways[1].state, 'off')
  assert.equal(snapshot.gateways[1].name, 'no url')
})

test('collect: an AK file error is surfaced as a note without breaking the cycle', async (t) => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qb-collect-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.dsh', 'qwen-coupon.json'), '{ broken', 'utf8')

  const snapshot = await collectOnce({
    config: { enabled: true, aliyun: { enabled: true, useAkFile: true, akId: '', akSecret: '', endpoint: '' }, gateways: [] },
    env: {},
    homeDir: home,
    now: NOW,
  })
  assert.equal(snapshot.aliyun.state, 'off')
  assert.ok(snapshot.notes.some((note) => note.key === 'note.akFileError'))
  assert.equal(JSON.stringify(snapshot).includes('{ broken'), false, 'the file contents must not be echoed')
})

test('collect: a real schemastery Config (volatile refs) is read, not stringified', async () => {
  // Regression guard for a defect that only a real `Config` can expose: after
  // resolution, the fields of `aliyun` and of every `gateways[]` entry are still
  // cosmokit volatile refs rather than plain values. Reading them directly would
  // leave `akId` truthy-but-wrong and make every credential look empty.
  const resolved = Config({
    enabled: true,
    aliyun: {
      enabled: true,
      useAkFile: false,
      akId: 'id-from-config',
      akSecret: 'secret-from-config',
      endpoint: 'http://127.0.0.1:1',
    },
    gateways: [{ name: 'unused', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-volatile' }],
  })

  const snapshot = await collectOnce({ config: resolved, env: {}, now: NOW, timeoutMs: 2000 })

  // Port 1 refuses, so the probe fails — but running the probe at all proves the
  // credentials were unwrapped, and the mask proves `akId` was really read.
  assert.equal(snapshot.aliyun.state, 'error')
  assert.equal(snapshot.coupons.akIdMasked, maskKey('id-from-config'))
  assert.equal(snapshot.gateways.length, 1, 'the gateways array survived resolution')
  assert.equal(snapshot.gateways[0].state, 'error')
  assert.equal(JSON.stringify(snapshot).includes('secret-from-config'), false)
  assert.equal(JSON.stringify(snapshot).includes('sk-volatile'), false)
})