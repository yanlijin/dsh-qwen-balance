/**
 * host-bss.test.mjs — Alibaba Cloud BSS signing and coupon aggregation.
 *
 * Two independent things are checked:
 *   1. `lib/core/bss.js#rpcSign` reproduces the official RPC V1.0 signature
 *      vector published by Alibaba Cloud (`OLeaidS1JvxuMvnyHOwuJ+uX5qY=`).
 *   2. The mock BSS server recomputes HMAC-SHA1 itself, from the raw query
 *      string it received, so a request is only accepted when the library's
 *      canonicalization is byte-for-byte what the other side derived.
 */

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import http from 'node:http'
import test from 'node:test'

import {
  buildCanonicalQuery,
  buildRpcParams,
  callBss,
  normalizeCoupon,
  parseCouponList,
  percentEncode,
  pickCoupon,
  queryAccountBalance,
  queryCashCoupons,
  resolveBssEndpoint,
  rpcSign,
  toNumber,
} from '../lib/core/bss.js'

/* --------------------------------------------------------- official vector */

const VECTOR = {
  accessKeySecret: 'testsecret',
  params: {
    Timestamp: '2016-02-23T12:46:24Z',
    Format: 'XML',
    AccessKeyId: 'testid',
    Action: 'DescribeRegions',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
    Version: '2014-05-26',
    SignatureVersion: '1.0',
  },
  stringToSign: 'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeRegions%26Format%3DXML'
    + '%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3D3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf'
    + '%26SignatureVersion%3D1.0%26Timestamp%3D2016-02-23T12%253A46%253A24Z%26Version%3D2014-05-26',
  signature: 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=',
}

test('bss: rpcSign reproduces the official StringToSign and Signature', () => {
  const signed = rpcSign({ params: VECTOR.params, accessKeySecret: VECTOR.accessKeySecret, method: 'GET', path: '/' })
  assert.equal(signed.stringToSign, VECTOR.stringToSign)
  assert.equal(signed.signature, VECTOR.signature)
})

test('bss: percentEncode follows the Java URLEncoder rules, not encodeURIComponent', () => {
  const cases = {
    ' ': '%20',
    '+': '%2B',
    '*': '%2A',
    '~': '~',
    '/': '%2F',
    '!': '%21',
    "'": '%27',
    '(': '%28',
    ')': '%29',
    '%': '%25',
    '&': '%26',
    '=': '%3D',
    '-_.': '-_.',
    aZ09: 'aZ09',
    '中文': '%E4%B8%AD%E6%96%87',
  }
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(percentEncode(input), expected, `percentEncode(${JSON.stringify(input)})`)
  }
})

test('bss: buildCanonicalQuery sorts by key and encodes values', () => {
  const canonical = buildCanonicalQuery({ Zed: 'last', Action: 'QueryCashCoupons', Space: 'a b', Num: 42 })
  assert.equal(canonical, 'Action=QueryCashCoupons&Num=42&Space=a%20b&Zed=last')
})

test('bss: buildRpcParams always carries the frozen common parameter set', () => {
  const params = buildRpcParams({ action: 'QueryCashCoupons', accessKeyId: 'testid', securityToken: 'sts-token' })
  assert.equal(params.Action, 'QueryCashCoupons')
  assert.equal(params.Version, '2017-12-14')
  assert.equal(params.SignatureMethod, 'HMAC-SHA1')
  assert.equal(params.SignatureVersion, '1.0')
  assert.equal(params.Format, 'JSON')
  assert.equal(params.AccessKeyId, 'testid')
  assert.equal(params.SecurityToken, 'sts-token')
  assert.match(params.SignatureNonce, /^[0-9a-f-]{36}$/)
  // The verified source formats Timestamp as ISO seconds + Z.
  assert.match(params.Timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('bss: resolveBssEndpoint keeps full URLs and qualifies bare domains', () => {
  assert.equal(resolveBssEndpoint('business.aliyuncs.com'), 'https://business.aliyuncs.com')
  assert.equal(resolveBssEndpoint('', 'ap-southeast-1'), 'https://business.ap-southeast-1.aliyuncs.com')
  assert.equal(resolveBssEndpoint('http://127.0.0.1:18081/'), 'http://127.0.0.1:18081')
})

test('bss: toNumber returns a finite number or null, never NaN', () => {
  assert.equal(toNumber('263.66'), 263.66)
  assert.equal(toNumber(0), 0)
  assert.equal(toNumber(''), null)
  assert.equal(toNumber(undefined), null)
  assert.equal(toNumber('not-a-number'), null)
})

/* ------------------------------------------------------------- mock server */

/** Independent percent-encoder; deliberately not imported from the library. */
function mockEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/%7E/g, '~')
}

/**
 * Start a mock BSS endpoint that verifies every signature with its own RSA-free
 * HMAC-SHA1 recomputation over the received query string.
 * @param {object} options - mock options.
 * @param {string} options.secret - expected AccessKey secret.
 * @param {(action: string) => object} options.respond - response body factory.
 * @returns {Promise<{url: string, seen: object[], close: () => Promise<void>}>} the mock handle.
 */
async function startMockBss({ secret = 'testsecret', respond }) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const params = Object.fromEntries(url.searchParams.entries())
    const signature = params.Signature
    delete params.Signature
    // Independent recomputation: the mock trusts only what it can derive.
    const canonical = Object.keys(params).sort().map((key) => `${mockEncode(key)}=${mockEncode(params[key])}`).join('&')
    const stringToSign = `GET&${mockEncode('/')}&${mockEncode(canonical)}`
    const expected = createHmac('sha1', `${secret}&`).update(stringToSign, 'utf8').digest('base64')
    seen.push({ action: params.Action, signatureOk: expected === signature, params })
    if (expected !== signature) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Code: 'SignatureDoesNotMatch', Message: 'mock signature mismatch' }))
      return
    }
    const body = respond(params.Action, params)
    res.writeHead(200, { 'content-type': body.contentType ?? 'application/json; charset=utf-8' })
    res.end(typeof body.body === 'string' ? body.body : JSON.stringify(body.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const BALANCE_DATA = {
  RequestId: 'REQ-BALANCE',
  Code: '200',
  Success: true,
  Data: {
    AvailableAmount: '263.66',
    AvailableCashAmount: '263.66',
    CreditAmount: '0',
    MybankCreditAmount: '0',
    QuotaLimit: '1000',
    Currency: 'CNY',
  },
}

const COUPON_DATA = {
  RequestId: 'REQ-COUPON',
  Code: '200',
  Success: true,
  Data: {
    TotalCount: 3,
    CashCoupon: [
      { CashCouponId: 1, CashCouponNo: 'Q-100', Status: 'Available', NominalValue: '500', Balance: '263.66', ExpiryTime: '2027-10-20T00:00:00Z', ApplicableScenarios: '通用' },
      { CashCouponId: 2, CashCouponNo: 'Q-200', Status: 'Available', NominalValue: '100', Balance: '50', ExpiryTime: '2026-01-05T00:00:00Z', ApplicableScenarios: '通用' },
      { CashCouponId: 3, CashCouponNo: 'Q-300', Status: 'Expired', NominalValue: '20', Balance: '0', ExpiryTime: '2024-01-01T00:00:00Z', ApplicableScenarios: '通用' },
    ],
  },
}

test('bss: a real request is accepted by an independently verifying mock', async (t) => {
  const mock = await startMockBss({ respond: (action) => ({ body: action === 'QueryAccountBalance' ? BALANCE_DATA : COUPON_DATA }) })
  t.after(() => mock.close())

  const balance = await queryAccountBalance({
    accessKeyId: 'testid',
    accessKeySecret: 'testsecret',
    endpoint: mock.url,
  })
  assert.equal(balance.available, 263.66)
  assert.equal(balance.cash, 263.66)
  assert.equal(balance.credit, 0)
  assert.equal(balance.currency, 'CNY')

  assert.equal(mock.seen.length, 1)
  assert.equal(mock.seen[0].action, 'QueryAccountBalance')
  assert.equal(mock.seen[0].signatureOk, true, 'mock must independently verify the HMAC-SHA1 signature')
})

test('bss: coupon totals count only Available coupons, and filtering works locally', async (t) => {
  const mock = await startMockBss({ respond: () => ({ body: COUPON_DATA }) })
  t.after(() => mock.close())

  const all = await queryCashCoupons({ accessKeyId: 'testid', accessKeySecret: 'testsecret', endpoint: mock.url })
  assert.equal(all.total_count, 3)
  assert.equal(all.available_count, 2)
  assert.equal(all.available_balance, 313.66, '263.66 + 50, the expired coupon must not count')
  assert.equal(all.nominal_total, 600)
  assert.equal(all.coupons.length, 3)
  assert.equal(mock.seen[0].signatureOk, true)

  const one = await queryCashCoupons({ accessKeyId: 'testid', accessKeySecret: 'testsecret', endpoint: mock.url, couponNo: 'Q-200' })
  assert.equal(one.found, true)
  assert.equal(one.coupons.length, 1)
  assert.equal(one.coupons[0].no, 'Q-200')
  assert.equal(one.filtered_by, 'Q-200')

  const missing = await queryCashCoupons({ accessKeyId: 'testid', accessKeySecret: 'testsecret', endpoint: mock.url, couponNo: 'Q-999' })
  assert.equal(missing.found, false)
  assert.deepEqual(missing.coupons, [])
})

test('bss: an HTML body is reported as an error, never parsed into numbers', async (t) => {
  const mock = await startMockBss({ respond: () => ({ contentType: 'text/html', body: '<!doctype html><html><body>nginx</body></html>' }) })
  t.after(() => mock.close())

  await assert.rejects(
    () => callBss({ action: 'QueryAccountBalance', accessKeyId: 'testid', accessKeySecret: 'testsecret', endpoint: mock.url }),
    (error) => {
      assert.match(error.message, /HTML/)
      assert.doesNotMatch(error.message, /AvailableAmount/)
      return true
    },
  )
})

test('bss: an Alibaba Cloud error code surfaces with its code and RequestId', async (t) => {
  const mock = await startMockBss({
    respond: () => ({ body: { Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.', RequestId: 'REQ-BAD' } }),
  })
  t.after(() => mock.close())

  await assert.rejects(
    () => callBss({ action: 'QueryAccountBalance', accessKeyId: 'testid', accessKeySecret: 'testsecret', endpoint: mock.url }),
    /InvalidAccessKeyId\.NotFound.*REQ-BAD/s,
  )
})

test('bss: a wrong secret is rejected by the mock, proving the signature is actually checked', async (t) => {
  const mock = await startMockBss({ respond: () => ({ body: BALANCE_DATA }) })
  t.after(() => mock.close())

  await assert.rejects(
    () => callBss({ action: 'QueryAccountBalance', accessKeyId: 'testid', accessKeySecret: 'wrong-secret', endpoint: mock.url }),
    /SignatureDoesNotMatch/,
  )
  assert.equal(mock.seen[0].signatureOk, false)
})

test('bss: missing credentials fail fast without any network call', async () => {
  await assert.rejects(() => callBss({ action: 'QueryAccountBalance', accessKeyId: '', accessKeySecret: '' }), /缺少 AccessKey/)
})

test('bss: coupon normalization and lookup helpers', () => {
  const coupon = normalizeCoupon({ CashCouponId: 7, CashCouponNo: 'Q-7', Status: 'Available', NominalValue: '100', Balance: '12.5', ExpiryTime: '2027-01-01T00:00:00Z', ApplicableScenarios: '通用' })
  assert.equal(coupon.id, '7')
  assert.equal(coupon.no, 'Q-7')
  assert.equal(coupon.balance, 12.5)
  assert.equal(coupon.statusText, '可用')
  assert.equal(pickCoupon([coupon], 'q-7')?.no, 'Q-7')
  assert.equal(pickCoupon([coupon], 'nope'), null)

  // A single object instead of an array must still normalize to a list.
  assert.equal(parseCouponList({ CashCoupon: { CashCouponNo: 'Q-1' } }).length, 1)
  assert.deepEqual(parseCouponList({}), [])
})

test('bss: AccessKeys and STS tokens never appear in an error message', async (t) => {
  const secret = 'super-secret-access-key-value'
  const mock = await startMockBss({
    secret,
    respond: () => ({ body: { Code: 'Throttling', Message: `rate limited for ${secret}`, RequestId: 'REQ-1' } }),
  })
  t.after(() => mock.close())

  await assert.rejects(
    () => callBss({ action: 'QueryAccountBalance', accessKeyId: 'testid', accessKeySecret: secret, endpoint: mock.url }),
    (error) => {
      assert.equal(error.message.includes(secret), false, 'the raw secret leaked into the error message')
      assert.match(error.message, /Throttling/)
      return true
    },
  )
})