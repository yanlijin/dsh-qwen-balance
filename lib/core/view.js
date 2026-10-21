/**
 * view.js — turn raw probe results into the frozen payload of SPEC.md §3.3.
 *
 * Two layers, deliberately separated:
 *
 *   buildSnapshot(...)  — language-neutral. Holds source state plus the note
 *                         *keys* that explain it. Cacheable; one snapshot is
 *                         reused for every subsequent request.
 *   renderOverview(...) — per request. Applies one language and produces the
 *                         exact object the browser half renders.
 *
 * That split is what makes §3.3's rule ("`lang` only changes
 * `summary.label`, `rows[].label` and `notes`") structural rather than a
 * promise: field names and numbers are produced by `buildSnapshot`, which never
 * sees a language.
 *
 * Every numeric field is emitted as `number | null`, never `undefined`, so
 * `JSON.stringify` cannot silently drop a key.
 */

import { normalizeLang, t } from './i18n.js'

/** Currency symbols used by `money`. Anything unknown prints as `12.34 XYZ`. */
const SYMBOLS = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' }

/**
 * Format an amount for display. Language-neutral by design.
 * @param {unknown} amount - the number.
 * @param {unknown} currency - ISO currency code.
 * @returns {string|null} `¥263.66`, `$7.66`, `12.34 XYZ`, or null when absent.
 */
export function money(amount, currency) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return null
  const code = String(currency ?? '').toUpperCase()
  const value = Number(amount).toFixed(2)
  const symbol = SYMBOLS[code]
  return symbol ? `${symbol}${value}` : `${value}${code ? ` ${code}` : ''}`
}

/** Parse the leading `YYYY-MM-DD` of a timestamp; null when unusable. */
function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''))
  return match ? match[1] : null
}

/** The `off` aliyun source: not queried (disabled, or no credential). */
export const OFF_ALIYUN = Object.freeze({
  state: 'off', error: null, availableAmount: null, cashAmount: null, creditAmount: null, currency: 'CNY',
})

/** The `off` coupon source. */
export const OFF_COUPONS = Object.freeze({
  state: 'off', error: null, availableBalance: null, availableCount: null, totalCount: null,
  nominalTotal: null, nearestExpiry: null, akIdMasked: null, items: [],
})

/**
 * Shape a `queryAccountBalance` probe into `sources.aliyun`.
 * @param {object} probe - `{state, error, data}`.
 * @returns {object} the SPEC-shaped source.
 */
export function shapeAliyunSource(probe = {}) {
  const data = probe.data ?? null
  return {
    state: probe.state ?? 'off',
    error: probe.error ?? null,
    availableAmount: data?.available ?? null,
    cashAmount: data?.cash ?? null,
    creditAmount: data?.credit ?? null,
    currency: data?.currency || 'CNY',
  }
}

/**
 * Shape a `queryCashCoupons` probe into `sources.coupons`.
 *
 * Only the five fields SPEC.md §3.3 lists survive per coupon, and the earliest
 * expiry among *available* coupons becomes `nearestExpiry` — the one number the
 * card needs to warn about before a coupon silently lapses.
 * @param {object} probe - `{state, error, data, akIdMasked}`.
 * @returns {object} the SPEC-shaped source.
 */
export function shapeCouponSource(probe = {}) {
  const data = probe.data ?? null
  const coupons = Array.isArray(data?.coupons) ? data.coupons : []
  const items = coupons.map((coupon) => ({
    no: coupon?.no ?? '',
    balance: coupon?.balance ?? null,
    nominal: coupon?.nominal ?? null,
    status: coupon?.status ?? '',
    expiry: coupon?.expiry ?? null,
    scenarios: coupon?.scenarios ?? '',
  }))
  const availableExpiries = items
    .filter((item) => /^available$/i.test(String(item.status)) && item.expiry)
    .map((item) => ({ day: isoDay(item.expiry), raw: item.expiry }))
    .filter((entry) => entry.day)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return {
    state: probe.state ?? 'off',
    error: probe.error ?? null,
    availableBalance: data?.available_balance ?? null,
    availableCount: data?.available_count ?? null,
    totalCount: data?.total_count ?? null,
    nominalTotal: data?.nominal_total ?? null,
    nearestExpiry: availableExpiries[0]?.raw ?? null,
    akIdMasked: probe.akIdMasked ?? null,
    items,
  }
}

/**
 * Freeze one probe cycle. Language-neutral; `lang` is applied later.
 * @param {object} input - snapshot parts.
 * @param {string} input.checkedAt - ISO instant of the cycle.
 * @param {boolean} input.enabled - plugin `enabled`.
 * @param {boolean} [input.showCoupons] - render coupon rows.
 * @param {boolean} [input.showGateways] - render gateway rows.
 * @param {object} [input.aliyun] - shaped aliyun source.
 * @param {object} [input.coupons] - shaped coupon source.
 * @param {object[]} [input.gateways] - gateway rows.
 * @param {Array<{key: string, vars?: object}>} [input.notes] - language-neutral notes.
 * @returns {object} the snapshot handed to `renderOverview`.
 */
export function buildSnapshot({
  checkedAt,
  enabled = true,
  showCoupons = true,
  showGateways = true,
  aliyun,
  coupons,
  gateways,
  notes = [],
} = {}) {
  return {
    checkedAt: checkedAt ?? null,
    enabled: Boolean(enabled),
    showCoupons: Boolean(showCoupons),
    showGateways: Boolean(showGateways),
    aliyun: aliyun ?? OFF_ALIYUN,
    coupons: coupons ?? OFF_COUPONS,
    gateways: Array.isArray(gateways) ? gateways : [],
    notes: Array.isArray(notes) ? notes : [],
  }
}

/**
 * Build the language-neutral note list from source states.
 *
 * Kept here (not in `index.js`) because it is pure: given the shapes, the
 * explanation is deterministic, which makes the "which failures produce which
 * guidance" behaviour directly unit-testable.
 * @param {object} input - observed state.
 * @param {object} input.aliyun - shaped aliyun source.
 * @param {object} input.coupons - shaped coupon source.
 * @param {object[]} input.gateways - gateway rows.
 * @param {boolean} input.configured - at least one source is configured.
 * @param {boolean} input.akConfigured - an AccessKey pair was resolved.
 * @param {string|null} [input.akError] - credential-file read error.
 * @param {Map<string,string>|object} [input.gatewayNames] - id -> display name.
 * @returns {Array<{key: string, vars?: object}>} note keys in display order.
 */
export function buildNotes({
  aliyun = OFF_ALIYUN,
  coupons = OFF_COUPONS,
  gateways = [],
  configured = false,
  akConfigured = false,
  akError = null,
  gatewayNames = {},
} = {}) {
  const notes = []
  const nameOf = (gateway, index) => gateway.name || gatewayNames[gateway.id] || `#${index + 1}`

  if (!configured) {
    notes.push({ key: 'note.noSource' })
    return notes
  }
  if (akError) notes.push({ key: 'note.akFileError', vars: { error: akError } })

  if (aliyun.state === 'off' && !akConfigured && !akError) notes.push({ key: 'note.aliyun.noAk' })
  if (aliyun.state === 'error') {
    notes.push({ key: 'note.aliyun.error', vars: { error: aliyun.error ?? '' } })
    notes.push({ key: 'note.aliyun.hint' })
  }
  if (coupons.state === 'ok') {
    if ((coupons.totalCount ?? 0) === 0) notes.push({ key: 'note.coupons.empty' })
    else if ((coupons.availableCount ?? 0) === 0) notes.push({ key: 'note.coupons.noAvailable', vars: { total: coupons.totalCount } })
    else notes.push({ key: 'note.coupons.notIncluded' })
  } else if (coupons.state === 'error') {
    notes.push({ key: 'note.coupons.error', vars: { error: coupons.error ?? '' } })
    notes.push({ key: 'note.coupons.hint' })
  } else if (!akConfigured && !akError) {
    // `akError` already explains the credential state; a second "no AK" note
    // would only contradict it.
    notes.push({ key: 'note.coupons.noAk' })
  }

  let badGateway = false
  gateways.forEach((gateway, index) => {
    const name = nameOf(gateway, index)
    if (gateway.state === 'off') notes.push({ key: 'note.gateway.off', vars: { name } })
    else if (gateway.state === 'error') {
      badGateway = true
      notes.push({ key: 'note.gateway.error', vars: { name, error: gateway.error ?? '' } })
    }
  })
  if (badGateway) notes.push({ key: 'note.gateway.hint' })
  return notes
}

/** Row label for a gateway, falling back to a localized default name. */
function gatewayName(gateway, index, lang) {
  return gateway.name || t(lang, 'gateway.defaultName', { n: index + 1 })
}

/** `¥263.66 · 2027-10-20 到期` for one coupon. */
function couponValue(item, lang) {
  const amount = money(item.balance, 'CNY') ?? t(lang, 'value.noData')
  const day = isoDay(item.expiry)
  return day ? `${amount} · ${t(lang, 'row.coupon.expiry', { date: day })}` : amount
}

/**
 * Build the `rows[]` array.
 * @param {object} snapshot - a snapshot from `buildSnapshot`.
 * @param {'zh'|'en'} lang - resolved language.
 * @returns {object[]} the rows.
 */
function buildRows(snapshot, lang) {
  const rows = []
  const coupons = snapshot.coupons
  if (snapshot.showCoupons && coupons.state === 'ok') {
    if (coupons.availableBalance !== null && (coupons.availableCount ?? 0) > 0) {
      rows.push({
        key: 'coupon.total',
        label: t(lang, 'row.coupon.total'),
        value: money(coupons.availableBalance, 'CNY') ?? t(lang, 'value.noData'),
        tone: 'good',
        group: 'coupon',
      })
    }
    const available = coupons.items.filter((item) => /^available$/i.test(String(item.status))).slice(0, 5)
    for (const item of available) {
      rows.push({
        key: `coupon.${item.no || 'item'}`,
        label: t(lang, 'row.coupon.item', { no: item.no || '-' }),
        value: couponValue(item, lang),
        tone: 'normal',
        group: 'coupon',
      })
    }
  }

  const aliyun = snapshot.aliyun
  if (aliyun.state === 'ok') {
    if (aliyun.availableAmount !== null) {
      rows.push({ key: 'aliyun.available', label: t(lang, 'row.aliyun.available'), value: money(aliyun.availableAmount, aliyun.currency), tone: 'good', group: 'aliyun' })
    }
    if (aliyun.cashAmount !== null) {
      rows.push({ key: 'aliyun.cash', label: t(lang, 'row.aliyun.cash'), value: money(aliyun.cashAmount, aliyun.currency), tone: 'muted', group: 'aliyun' })
    }
    if (aliyun.creditAmount !== null) {
      rows.push({ key: 'aliyun.credit', label: t(lang, 'row.aliyun.credit'), value: money(aliyun.creditAmount, aliyun.currency), tone: 'muted', group: 'aliyun' })
    }
  }

  if (snapshot.showGateways) {
    snapshot.gateways.forEach((gateway, index) => {
      if (gateway.state !== 'ok') return
      const name = gatewayName(gateway, index, lang)
      if (gateway.remaining !== null) {
        rows.push({
          key: `${gateway.id}.remaining`,
          label: t(lang, 'row.gw.remaining', { name }),
          value: money(gateway.remaining, gateway.currency),
          tone: gateway.remaining > 0 ? 'normal' : 'warn',
          group: 'gateway',
        })
      } else if (gateway.balance !== null) {
        rows.push({ key: `${gateway.id}.balance`, label: t(lang, 'row.gw.balance', { name }), value: money(gateway.balance, gateway.currency), tone: 'normal', group: 'gateway' })
      }
      if (gateway.total !== null) {
        rows.push({ key: `${gateway.id}.total`, label: t(lang, 'row.gw.total', { name }), value: money(gateway.total, gateway.currency), tone: 'muted', group: 'gateway' })
      }
      if (gateway.used !== null) {
        rows.push({ key: `${gateway.id}.used`, label: t(lang, 'row.gw.used', { name }), value: money(gateway.used, gateway.currency), tone: 'muted', group: 'gateway' })
      }
    })
  }
  return rows
}

/**
 * Build the single headline card.
 *
 * Priority follows what the user is actually spending first: coupon balance,
 * then account available credit, then a gateway's remaining quota.
 * @param {object} snapshot - a snapshot from `buildSnapshot`.
 * @param {'zh'|'en'} lang - resolved language.
 * @returns {object|null} the summary, or null when nothing is known.
 */
function buildSummary(snapshot, lang) {
  const coupons = snapshot.coupons
  if (snapshot.showCoupons && coupons.state === 'ok' && coupons.availableBalance !== null && (coupons.availableCount ?? 0) > 0) {
    return { key: 'summary', label: t(lang, 'summary.aliyun'), value: money(coupons.availableBalance, 'CNY'), sub: t(lang, 'sub.coupon'), tone: 'good' }
  }
  const aliyun = snapshot.aliyun
  if (aliyun.state === 'ok' && aliyun.availableAmount !== null) {
    return { key: 'summary', label: t(lang, 'summary.aliyun'), value: money(aliyun.availableAmount, aliyun.currency), sub: t(lang, 'sub.aliyun'), tone: 'good' }
  }
  if (snapshot.showGateways) {
    const gateway = snapshot.gateways.find((item) => item.state === 'ok')
    if (gateway) {
      const value = gateway.remaining !== null ? money(gateway.remaining, gateway.currency) : money(gateway.balance, gateway.currency)
      if (value) return { key: 'summary', label: t(lang, 'summary.gateway'), value, sub: t(lang, 'sub.gateway'), tone: 'normal' }
    }
  }
  return null
}

/**
 * Render one snapshot for one language — the frozen SPEC.md §3.3 payload.
 * @param {object} snapshot - a snapshot from `buildSnapshot`.
 * @param {unknown} [lang] - requested language.
 * @returns {object} the HTTP response body for `/overview` and `/refresh`.
 */
export function renderOverview(snapshot, lang) {
  const resolved = normalizeLang(lang ?? 'zh')
  const enabled = snapshot.enabled !== false
  const sources = {
    aliyun: snapshot.aliyun,
    coupons: snapshot.coupons,
    gateways: snapshot.gateways,
  }
  if (!enabled) {
    return {
      ok: false,
      enabled: false,
      checkedAt: snapshot.checkedAt,
      lang: resolved,
      summary: null,
      rows: [],
      notes: [t(resolved, 'note.disabled')],
      sources,
      error: 'disabled',
    }
  }
  const ok = sources.aliyun.state === 'ok'
    || sources.coupons.state === 'ok'
    || sources.gateways.some((gateway) => gateway.state === 'ok')
  return {
    ok,
    enabled: true,
    checkedAt: snapshot.checkedAt,
    lang: resolved,
    summary: buildSummary(snapshot, resolved),
    rows: buildRows(snapshot, resolved),
    notes: snapshot.notes.map((note) => t(resolved, note.key, note.vars)),
    sources,
    error: null,
  }
}