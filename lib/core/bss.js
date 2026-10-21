/**
 * bss.js — Alibaba Cloud BSS OpenAPI: RPC V1.0 signing, account balance, coupons.
 *
 * This is a direct port of `E:\sings\scripts\lib\aliyun-bss.mjs`, which was
 * already validated against the official signature vector
 * (`OLeaidS1JvxuMvnyHOwuJ+uX5qY=`, RPC V1.0 / HMAC-SHA1 / Version 2017-12-14).
 * The signing rules and the parameter set are therefore copied verbatim on
 * purpose: `percentEncode`, `buildCanonicalQuery`, `rpcSign`, `buildRpcParams`
 * and the two `Action` payloads must not drift from that verified source.
 *
 * Background worth keeping (from the original header):
 *   1. Bailian / DashScope `sk-` keys have NO balance endpoint at all.
 *   2. The `qianwen` CLI (OAuth) can read usage and plan quotas but has no
 *      coupon command.
 *   3. The only programmatic route to "account balance / coupon balance" is the
 *      BSS OpenAPI, which requires an AccessKey:
 *        - QueryAccountBalance  permission bss:DescribeAcccount  -> cash / available / credit
 *        - QueryCashCoupons     permission bss:DescribeCoupons   -> coupon list (nominal + balance + expiry)
 *      Alibaba Cloud states explicitly that "available credit" does NOT include
 *      coupon or stored-value balances, so coupons must be queried separately.
 *
 * Network rule (SPEC.md §3.5): `node:http` / `node:https` with `agent: false`
 * only. `globalThis.fetch` / undici is forbidden in this package because on
 * Windows its keep-alive socket races libuv's handle teardown and
 * `process.exit` then trips
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`.
 * `agent: false` makes every request a fresh connection closed on response end.
 */

import { createHmac, randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import { maskKey, redactSecrets } from './ak.js'

export { maskKey, redactSecrets }

/**
 * Coerce any value to a finite number, or `null`.
 *
 * SPEC.md §3.3 requires every numeric field to be `number | null` — never
 * `undefined` — because `undefined` disappears from `JSON.stringify` and the
 * browser half would see a missing key rather than "no value".
 * @param {unknown} value - candidate value.
 * @returns {number|null} the number, or null.
 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** BSS OpenAPI version every call in this package uses. */
export const BSS_VERSION = '2017-12-14'

/** BSS (cost & billing) OpenAPI entry points, by site/region. */
export const BSS_ENDPOINTS = {
  'cn-hangzhou': 'business.aliyuncs.com',
  'cn-shanghai': 'business.aliyuncs.com',
  'ap-southeast-1': 'business.ap-southeast-1.aliyuncs.com',
}

/* --------------------------------------------------------------- small helpers */

/**
 * Alibaba Cloud's required percent-encoding for RPC V1.0.
 *
 * The official Java implementation is `URLEncoder.encode(v, "UTF-8")` followed
 * by `+`->`%20`, `*`->`%2A`, `%7E`->`~`. Java's URLEncoder only keeps
 * `[A-Za-z0-9 . - _ *]`, so `! ' ( )` MUST be encoded — while JavaScript's
 * `encodeURIComponent` leaves exactly those four alone. They are patched by
 * hand below, otherwise the canonical query would not match the official one.
 * @param {unknown} value - parameter value.
 * @returns {string} the encoded value.
 */
export function percentEncode(value) {
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
 * Sort parameters by key and join them into the canonicalized query string.
 * @param {Record<string, unknown>} params - all signing parameters.
 * @returns {string} the canonical query.
 */
export function buildCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')
}

/**
 * Alibaba Cloud RPC-style signature V1.0 (HMAC-SHA1).
 * `StringToSign = METHOD & %2F & percentEncode(canonicalQuery)`.
 * @param {object} input - signing input.
 * @param {Record<string, unknown>} input.params - parameters, without Signature.
 * @param {string} input.accessKeySecret - the AccessKey secret.
 * @param {string} [input.method] - HTTP method.
 * @param {string} [input.path] - request path.
 * @returns {{canonicalQuery: string, stringToSign: string, signature: string}} the signature material.
 */
export function rpcSign({ params, accessKeySecret, method = 'GET', path = '/' }) {
  const canonicalQuery = buildCanonicalQuery(params)
  const stringToSign = `${method}&${percentEncode(path)}&${percentEncode(canonicalQuery)}`
  const signature = createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64')
  return { canonicalQuery, stringToSign, signature }
}

/**
 * An endpoint may be a bare domain, a full URL (the local mock servers) or a
 * region name.
 * @param {string} [endpoint] - configured endpoint.
 * @param {string} [region] - region whose default to use.
 * @returns {string} an absolute base URL without a trailing slash.
 */
export function resolveBssEndpoint(endpoint, region = 'cn-hangzhou') {
  const raw = String(endpoint || BSS_ENDPOINTS[region] || BSS_ENDPOINTS['cn-hangzhou']).trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

/**
 * Assemble the RPC common parameters (without `Signature`).
 *
 * `Timestamp` keeps the verified source's format: `yyyy-MM-ddTHH:mm:ssZ`, which
 * is exactly what the Alibaba Cloud RPC V1.0 spec asks for (ISO 8601, UTC,
 * second precision). Do not "improve" it to milliseconds — it is part of the
 * signed material and the vector above was computed with it.
 * @param {object} input - request parts.
 * @param {string} input.action - the OpenAPI Action.
 * @param {string} [input.version] - API version.
 * @param {string} input.accessKeyId - AccessKey id.
 * @param {string} [input.securityToken] - STS token, when temporary credentials are used.
 * @param {Record<string, unknown>} [input.params] - action-specific parameters.
 * @returns {Record<string, unknown>} the unsigned parameter map.
 */
export function buildRpcParams({ action, version = BSS_VERSION, accessKeyId, securityToken = '', params = {} }) {
  const out = {
    AccessKeyId: accessKeyId,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: version,
  }
  if (securityToken) out.SecurityToken = securityToken
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = typeof value === 'boolean' ? String(value) : value
  }
  return out
}

/* --------------------------------------------------------------- transport */

/**
 * Minimal GET returning text. Only this module and `gateway.js` use it.
 *
 * Deliberately NOT `globalThis.fetch` / undici — see the module header for the
 * Windows `UV_HANDLE_CLOSING` crash. `agent: false` guarantees the socket is
 * closed once the body is read, so the host keeps no background handles.
 * @param {string} url - absolute URL.
 * @param {object} [options] - request options.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {Record<string, string>} [options.headers] - extra request headers.
 * @param {number} [options.maxRedirects] - redirects to follow (0 = never, matching the BSS source).
 * @returns {Promise<{status: number, contentType: string, text: string, url: string}>} the raw response.
 */
export function httpGetText(url, { timeoutMs = 15000, headers = {}, maxRedirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`URL 不合法：${url}`))
      return
    }
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      agent: false,
      headers,
    }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (maxRedirects > 0 && status >= 300 && status < 400 && typeof location === 'string' && location) {
        res.resume()
        let next
        try {
          next = new URL(location, parsed).toString()
        } catch {
          reject(new Error(`重定向目标不合法：${location}`))
          return
        }
        resolve(httpGetText(next, { timeoutMs, headers, maxRedirects: maxRedirects - 1 }))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status,
        contentType: String(res.headers['content-type'] ?? ''),
        text: Buffer.concat(chunks).toString('utf8'),
        url: parsed.toString(),
      }))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`超时(>${timeoutMs}ms)`)) })
    req.on('error', (error) => reject(error))
    req.end()
  })
}

/* --------------------------------------------------------------- BSS calls */

/**
 * Call one BSS OpenAPI (GET + RPC signature).
 * @param {object} input - call parameters.
 * @param {string} input.action - Action name.
 * @param {string} [input.version] - API version.
 * @param {string} input.accessKeyId - AccessKey id.
 * @param {string} input.accessKeySecret - AccessKey secret.
 * @param {string} [input.securityToken] - STS token.
 * @param {string} [input.endpoint] - endpoint override.
 * @param {string} [input.region] - region for the default endpoint.
 * @param {number} [input.timeoutMs] - request timeout.
 * @param {Record<string, unknown>} [input.params] - action parameters.
 * @returns {Promise<{endpoint: string, requestId: string, data: any}>} the unwrapped `Data`.
 * @throws {Error} on transport failure, HTML/non-JSON body, or an Alibaba Cloud error code; the message is masked.
 */
export async function callBss({
  action,
  version = BSS_VERSION,
  accessKeyId,
  accessKeySecret,
  securityToken = '',
  endpoint,
  region = 'cn-hangzhou',
  timeoutMs = 15000,
  params = {},
} = {}) {
  if (!accessKeyId || !accessKeySecret) throw new Error('缺少 AccessKey ID 或 AccessKey Secret')
  if (!action) throw new Error('缺少 Action')
  const secrets = [accessKeySecret, accessKeyId, securityToken]
  const host = resolveBssEndpoint(endpoint, region)
  const signed = buildRpcParams({ action, version, accessKeyId, securityToken, params })
  const { signature } = rpcSign({ params: signed, accessKeySecret })
  const url = `${host}/?${buildCanonicalQuery({ ...signed, Signature: signature })}`

  let res
  try {
    res = await httpGetText(url, { timeoutMs, headers: { Accept: 'application/json' } })
  } catch (error) {
    const reason = String(error?.message ?? error)
    throw new Error(redactSecrets(`请求 BSS OpenAPI 失败：${reason}（${host}）`, secrets))
  }
  const text = res.text

  const isHtml = /text\/html/i.test(res.contentType) || /^\s*</.test(text)
  if (isHtml) {
    throw new Error(redactSecrets(`BSS OpenAPI 返回了 HTML 而不是 JSON（${host}）：${text.slice(0, 160).replace(/\s+/g, ' ')}`, secrets))
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(redactSecrets(`BSS OpenAPI 响应无法解析为 JSON（HTTP ${res.status}）：${text.slice(0, 200).replace(/\s+/g, ' ')}`, secrets))
  }
  const code = data?.Code
  const okCode = code === undefined || code === null || String(code) === '200' || String(code) === 'Success'
  if (res.status !== 200 || data?.Success === false || !okCode) {
    const bad = code ?? `HTTP ${res.status}`
    throw new Error(redactSecrets(`BSS OpenAPI 报错 [${bad}] ${data?.Message ?? ''}（RequestId=${data?.RequestId ?? '?'}）`, secrets))
  }
  return { endpoint: host, requestId: data?.RequestId ?? '', data: data?.Data ?? data }
}

/**
 * Account balance: `QueryAccountBalance`, normalized to camelCase.
 * @param {object} [opts] - `callBss` options.
 * @returns {Promise<{endpoint: string, requestId: string, currency: string, available: number|null, cash: number|null, credit: number|null, mybankCredit: number|null, quotaLimit: number|null}>} the balance.
 */
export async function queryAccountBalance(opts = {}) {
  const result = await callBss({ ...opts, action: 'QueryAccountBalance' })
  const data = result.data ?? {}
  return {
    endpoint: result.endpoint,
    requestId: result.requestId,
    currency: data.Currency ?? '',
    available: toNumber(data.AvailableAmount),
    cash: toNumber(data.AvailableCashAmount),
    credit: toNumber(data.CreditAmount),
    mybankCredit: toNumber(data.MybankCreditAmount),
    quotaLimit: toNumber(data.QuotaLimit),
  }
}

/**
 * Normalize one `CashCoupon` entry from `QueryCashCoupons`.
 * @param {Record<string, unknown>} [coupon] - the raw entry.
 * @returns {object} the normalized coupon.
 */
export function normalizeCoupon(coupon = {}) {
  return {
    id: coupon.CashCouponId === undefined || coupon.CashCouponId === null ? null : String(coupon.CashCouponId),
    no: coupon.CashCouponNo ?? '',
    status: coupon.Status ?? '',
    statusText: ({ Available: '可用', Expired: '已过期', Cancelled: '已作废' })[coupon.Status] ?? coupon.Status ?? '',
    nominal: toNumber(coupon.NominalValue),
    balance: toNumber(coupon.Balance),
    currency: 'CNY',
    effective: coupon.EffectiveTime ?? '',
    expiry: coupon.ExpiryTime ?? '',
    granted: coupon.GrantedTime ?? '',
    products: coupon.ApplicableProducts ?? '',
    scenarios: coupon.ApplicableScenarios ?? '',
    description: coupon.Description ?? '',
  }
}

/**
 * Pull the coupon array out of a `QueryCashCoupons` `Data` object (it may be a
 * single object instead of an array).
 * @param {unknown} data - the unwrapped `Data`.
 * @returns {object[]} normalized coupons.
 */
export function parseCouponList(data) {
  const raw = data?.CashCoupon ?? data?.CashCoupons ?? data?.Coupon ?? []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.filter((coupon) => coupon && typeof coupon === 'object').map(normalizeCoupon)
}

/**
 * Pick one coupon by number or id (case-insensitive; `Q-xxxx` and plain digits
 * both work). `QueryCashCoupons` has no server-side filter, so this is the only
 * way to look one up.
 * @param {object[]} coupons - normalized coupons.
 * @param {unknown} idOrNo - coupon number or id.
 * @returns {object|null} the match, or null.
 */
export function pickCoupon(coupons, idOrNo) {
  const key = String(idOrNo ?? '').trim().toLowerCase()
  if (!key) return null
  return (coupons ?? []).find((coupon) => (
    String(coupon.no ?? '').toLowerCase() === key || String(coupon.id ?? '') === key
  )) ?? null
}

/**
 * Coupon list: `QueryCashCoupons`.
 *   - The only inputs are `ExpiryTimeStart` / `ExpiryTimeEnd` / `EffectiveOrNot`;
 *     there is NO parameter to filter by coupon number, so `couponNo`/`couponId`
 *     are filtered locally via {@link pickCoupon}.
 *   - `Balance` is what is left on the coupon, `NominalValue` is the face value;
 *     only `Status=Available` coupons count toward the available total.
 * @param {object} [input] - query options.
 * @param {string} [input.couponNo] - restrict the result to one coupon number.
 * @param {string} [input.couponId] - restrict the result to one coupon id.
 * @param {string} [input.expiringBefore] - `ExpiryTimeEnd`.
 * @param {string} [input.expiringAfter] - `ExpiryTimeStart`.
 * @param {boolean} [input.effectiveOnly] - `EffectiveOrNot`.
 * @param {boolean} [input.filter] - apply the couponNo/couponId filter.
 * @returns {Promise<object>} the coupon summary (snake_case, matching the verified source).
 */
export async function queryCashCoupons({
  couponNo,
  couponId,
  expiringBefore,
  expiringAfter,
  effectiveOnly,
  filter = true,
  ...rest
} = {}) {
  const params = {}
  if (expiringBefore) params.ExpiryTimeEnd = expiringBefore
  if (expiringAfter) params.ExpiryTimeStart = expiringAfter
  if (effectiveOnly !== undefined) params.EffectiveOrNot = Boolean(effectiveOnly)
  const result = await callBss({ ...rest, action: 'QueryCashCoupons', params })
  const all = parseCouponList(result.data)
  const available = all.filter((coupon) => /^available$/i.test(coupon.status))
  const availableBalance = Number(available.reduce((sum, coupon) => sum + (coupon.balance ?? 0), 0).toFixed(6))
  const wanted = couponNo ?? couponId
  const selected = filter && wanted ? pickCoupon(all, wanted) : null
  const out = {
    source: 'aliyun-bss',
    kind: 'cash-coupons',
    endpoint: result.endpoint,
    request_id: result.requestId,
    currency: 'CNY',
    total_count: toNumber(result.data?.TotalCount) ?? all.length,
    available_count: available.length,
    available_balance: availableBalance,
    nominal_total: Number(available.reduce((sum, coupon) => sum + (coupon.nominal ?? 0), 0).toFixed(6)),
    coupons: filter && wanted ? (selected ? [selected] : []) : all,
  }
  if (wanted) {
    out.filtered_by = String(wanted)
    out.found = Boolean(selected)
  }
  return out
}