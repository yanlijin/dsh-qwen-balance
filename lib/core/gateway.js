/**
 * gateway.js — probe one OpenAI-compatible relay ("中转站") for its balance.
 *
 * Ported from `probeGateway` in `E:\sings\scripts\qwen-balance.mjs`, narrowed to
 * one configured gateway per call so the result maps 1:1 onto a
 * `sources.gateways[]` row (SPEC.md §3.3).
 *
 * Two families of endpoint are recognized:
 *
 *   A. new-api / one-api billing (preferred when both bodies look right)
 *        GET /dashboard/billing/subscription -> { hard_limit_usd }        (USD, a money amount)
 *        GET /dashboard/billing/usage        -> { total_usage }            (CENTS — divide by 100)
 *      so `total = hard_limit_usd`, `used = total_usage / 100`,
 *      `remaining = total - used`.
 *
 *   B. DeepSeek-style wallet
 *        GET /user/balance -> { is_available, balance_infos: [{ currency, total_balance, ... }] }
 *      so `balance = total_balance` and total/used/remaining stay null.
 *
 * The trap this module exists to avoid: an OLD one-api answers *unknown* routes
 * with `200` and an HTML page. Parsing that as JSON either throws or, worse,
 * yields garbage numbers that look like a real balance. Every body is therefore
 * classified as HTML **before** it is parsed, and HTML is reported as an error.
 *
 * Network: `node:http`/`node:https` via `bss.js#httpGetText` with `agent:false`
 * (see that module's header for the Windows undici crash this avoids).
 */

import { httpGetText, maskKey, redactSecrets, toNumber } from './bss.js'

/** Accepted `gateways[].kind` values. */
export const GATEWAY_KINDS = ['auto', 'newapi', 'user-balance']

/**
 * Candidate origins for a configured base URL.
 *
 * People paste either `https://relay.example.com` or
 * `https://relay.example.com/v1` (the OpenAI-compatible root). The billing
 * routes live at the origin root, so a trailing `/v1` is also tried stripped.
 * @param {unknown} baseUrl - configured base URL.
 * @returns {string[]} candidate origins, in try order, without trailing slashes.
 */
export function normalizeBases(baseUrl) {
  const raw = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!raw) return []
  const out = [raw]
  const stripped = raw.replace(/\/v1$/i, '')
  if (stripped && stripped !== raw) out.push(stripped)
  return out
}

/** Collapse a body into a short single-line excerpt safe for an error message. */
function snippet(text, limit = 120) {
  return String(text ?? '').slice(0, limit).replace(/\s+/g, ' ').trim()
}

/**
 * GET + JSON with HTML/status/parse classification.
 *
 * Every message carries `snippet(text)` — a fragment of the remote body — so
 * every one of them is passed through `redactSecrets` before it is returned:
 * a misbehaving relay can echo the bearer token back, and `attempts` (the debug
 * log) would otherwise persist it.
 * @param {string} url - absolute URL.
 * @param {object} options - request options.
 * @param {string} options.apiKey - bearer token (masked in every error).
 * @param {number} options.timeoutMs - request timeout.
 * @returns {Promise<{ok: boolean, status: number, endpoint: string, isHtml: boolean, data?: any, error?: string}>} the classified response.
 */
async function getJson(url, { apiKey, timeoutMs }) {
  const safe = (message) => redactSecrets(message, [apiKey])
  const headers = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  let res
  try {
    res = await httpGetText(url, { timeoutMs, headers, maxRedirects: 3 })
  } catch (error) {
    return { ok: false, status: 0, endpoint: url, isHtml: false, error: safe(`请求失败：${error?.message ?? error}`) }
  }
  const text = res.text
  // HTML first: an old one-api's 200 + HTML must never reach JSON.parse.
  const isHtml = /text\/html/i.test(res.contentType) || /^\s*</.test(text)
  if (isHtml) {
    return {
      ok: false, status: res.status, endpoint: url, isHtml: true,
      error: safe(`返回 HTML 而不是 JSON（HTTP ${res.status}）：${snippet(text)}`),
    }
  }
  if (res.status !== 200) {
    return { ok: false, status: res.status, endpoint: url, isHtml: false, error: safe(`HTTP ${res.status}：${snippet(text)}`) }
  }
  try {
    return { ok: true, status: res.status, endpoint: url, isHtml: false, data: JSON.parse(text) }
  } catch {
    return { ok: false, status: res.status, endpoint: url, isHtml: false, error: safe(`响应无法解析为 JSON：${snippet(text)}`) }
  }
}

/** Round to 6 decimals, preserving null. */
function round(value) {
  return value === null || value === undefined ? null : Number(value.toFixed(6))
}

/**
 * Probe one gateway.
 *
 * Never throws: a transport failure, an HTML body, a 401 or a gateway that
 * exposes neither endpoint all become `state:'error'` (or `'off'` when
 * unconfigured) with a short masked message, so one bad gateway can never take
 * the other sources down (SPEC.md §3.3).
 *
 * @param {object} input - gateway to probe.
 * @param {string} input.id - stable row id (`gw1`, ...).
 * @param {string} [input.name] - display name.
 * @param {string} input.baseUrl - configured base URL.
 * @param {string} input.apiKey - API key (env or config).
 * @param {'auto'|'newapi'|'user-balance'} [input.kind] - endpoint family.
 * @param {number} [input.timeoutMs] - per-request timeout.
 * @param {boolean} [input.debug] - attach the raw attempt log (tests only).
 * @returns {Promise<{id: string, name: string, kind: string, state: 'ok'|'off'|'error', error: string|null, currency: string|null, total: number|null, used: number|null, remaining: number|null, balance: number|null, attempts?: object[]}>} the gateway row.
 */
export async function probeGateway({
  id = 'gw1',
  name = '',
  baseUrl = '',
  apiKey = '',
  kind = 'auto',
  timeoutMs = 15000,
  debug = false,
} = {}) {
  const configuredKind = GATEWAY_KINDS.includes(kind) ? kind : 'auto'
  const row = {
    id: String(id),
    name: String(name ?? ''),
    kind: configuredKind,
    state: 'off',
    error: null,
    currency: null,
    total: null,
    used: null,
    remaining: null,
    balance: null,
  }
  const attempts = []
  const bases = normalizeBases(baseUrl)
  const withAttempts = (value) => (debug ? { ...value, attempts } : value)

  if (!bases.length) return withAttempts({ ...row, error: '未配置 baseUrl' })
  if (!apiKey) return withAttempts({ ...row, error: '未配置 apiKey（可填 apiKeyEnv 指向环境变量）' })

  const wantNewApi = configuredKind === 'auto' || configuredKind === 'newapi'
  const wantUserBalance = configuredKind === 'auto' || configuredKind === 'user-balance'

  if (wantNewApi) {
    for (const origin of bases) {
      const sub = await getJson(`${origin}/dashboard/billing/subscription`, { apiKey, timeoutMs })
      attempts.push({ source: 'newapi-billing', endpoint: sub.endpoint, ok: sub.ok, status: sub.status, isHtml: sub.isHtml, error: sub.error ?? null })
      if (!sub.ok) continue
      const usage = await getJson(`${origin}/dashboard/billing/usage`, { apiKey, timeoutMs })
      attempts.push({ source: 'newapi-usage', endpoint: usage.endpoint, ok: usage.ok, status: usage.status, isHtml: usage.isHtml, error: usage.error ?? null })
      const total = toNumber(sub.data?.hard_limit_usd)
      const usedCents = usage.ok ? toNumber(usage.data?.total_usage) : null
      // total_usage is in CENTS — the /100 is the whole reason this branch exists.
      const used = usedCents === null ? null : round(usedCents / 100)
      if (total === null && used === null) continue
      return withAttempts({
        ...row,
        kind: 'newapi',
        state: 'ok',
        error: null,
        currency: 'USD',
        total,
        used,
        remaining: total !== null && used !== null ? round(total - used) : null,
        balance: null,
      })
    }
  }

  if (wantUserBalance) {
    for (const origin of bases) {
      const res = await getJson(`${origin}/user/balance`, { apiKey, timeoutMs })
      attempts.push({ source: 'user-balance', endpoint: res.endpoint, ok: res.ok, status: res.status, isHtml: res.isHtml, error: res.error ?? null })
      if (!res.ok) continue
      const infos = Array.isArray(res.data?.balance_infos) ? res.data.balance_infos : []
      if (!infos.length) continue
      const info = infos.find((item) => /CNY/i.test(String(item?.currency ?? ''))) ?? infos[0]
      const balance = toNumber(info?.total_balance)
      if (balance === null) continue
      return withAttempts({
        ...row,
        kind: 'user-balance',
        state: 'ok',
        error: null,
        currency: String(info?.currency ?? 'CNY'),
        total: null,
        used: null,
        remaining: null,
        balance,
      })
    }
  }

  const htmlAttempt = attempts.find((attempt) => attempt.isHtml)
  const httpAttempt = attempts.find((attempt) => !attempt.ok && attempt.status > 0)
  const transportAttempt = attempts.find((attempt) => !attempt.ok && attempt.status === 0)
  let error
  if (htmlAttempt) {
    error = `该地址对未知路由返回 HTML（旧版 one-api），无法读取余额：${htmlAttempt.endpoint}`
  } else if (httpAttempt) {
    error = `HTTP ${httpAttempt.status}（${httpAttempt.endpoint}）`
  } else if (transportAttempt) {
    error = transportAttempt.error ?? '请求失败'
  } else {
    error = '没有暴露任何余额端点（/dashboard/billing/* 与 /user/balance 都不可用）'
  }
  return withAttempts({
    ...row,
    state: 'error',
    error: redactSecrets(error, [apiKey]),
  })
}

/** Export the masking helper next to the probe so callers cannot forget it. */
export { maskKey, redactSecrets }