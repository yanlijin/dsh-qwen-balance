/**
 * host-view.test.mjs — the frozen payload of SPEC.md §3.3.
 *
 * The two invariants that matter most are asserted here:
 *   - `lang` changes wording only; every field name and every number is
 *     identical between zh and en.
 *   - one failing source never removes another source's rows, and a
 *     configuration with no sources at all is still a valid, non-throwing
 *     `ok:false` payload carrying setup guidance.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNotes, buildSnapshot, money, renderOverview, shapeAliyunSource, shapeCouponSource } from '../lib/core/view.js'

const CHECKED_AT = '2026-10-21T04:00:00.000Z'

/** The exact SPEC.md §3.3 example shapes, reused across the cases. */
function couponProbe() {
  return {
    state: 'ok',
    error: null,
    akIdMasked: 'LTAI5t...EDaN',
    data: {
      available_balance: 263.66,
      available_count: 1,
      total_count: 2,
      nominal_total: 500,
      coupons: [
        { no: 'Q-100', balance: 263.66, nominal: 500, status: 'Available', expiry: '2027-10-20T00:00:00Z', scenarios: '通用' },
        { no: 'Q-200', balance: 0, nominal: 20, status: 'Expired', expiry: '2024-01-01T00:00:00Z', scenarios: '通用' },
      ],
    },
  }
}

function gatewayRow(overrides = {}) {
  return {
    id: 'gw1', name: '中转站', kind: 'newapi', state: 'ok', error: null,
    currency: 'USD', total: 10, used: 2.34, remaining: 7.66, balance: null,
    ...overrides,
  }
}

/** Walk every leaf so a stray `undefined` cannot hide. */
function leaves(value, path = '$', out = []) {
  if (value === null || typeof value !== 'object') {
    out.push([path, value])
    return out
  }
  for (const [key, item] of Object.entries(value)) leaves(item, `${path}.${key}`, out)
  return out
}

test('view: money formats known currencies and degrades gracefully', () => {
  assert.equal(money(263.66, 'CNY'), '¥263.66')
  assert.equal(money(7.66, 'USD'), '$7.66')
  assert.equal(money(0, 'CNY'), '¥0.00')
  assert.equal(money(12.34, 'XYZ'), '12.34 XYZ')
  assert.equal(money(12.34, ''), '12.34')
  assert.equal(money(null, 'CNY'), null)
  assert.equal(money(undefined, 'CNY'), null)
  assert.equal(money('not-a-number', 'CNY'), null)
})

test('view: shapeAliyunSource maps a BSS balance onto the frozen field names', () => {
  const source = shapeAliyunSource({ state: 'ok', error: null, data: { available: 263.66, cash: 263.66, credit: 0, currency: 'CNY' } })
  assert.deepEqual(source, { state: 'ok', error: null, availableAmount: 263.66, cashAmount: 263.66, creditAmount: 0, currency: 'CNY' })
  assert.deepEqual(shapeAliyunSource({}), { state: 'off', error: null, availableAmount: null, cashAmount: null, creditAmount: null, currency: 'CNY' })
})

test('view: shapeCouponSource keeps five fields per coupon and finds the nearest expiry', () => {
  const source = shapeCouponSource(couponProbe())
  assert.equal(source.availableBalance, 263.66)
  assert.equal(source.availableCount, 1)
  assert.equal(source.totalCount, 2)
  assert.equal(source.nominalTotal, 500)
  assert.equal(source.akIdMasked, 'LTAI5t...EDaN')
  assert.equal(source.nearestExpiry, '2027-10-20T00:00:00Z', 'the expired coupon must not win')
  assert.equal(source.items.length, 2)
  assert.deepEqual(Object.keys(source.items[0]).sort(), ['balance', 'expiry', 'no', 'nominal', 'scenarios', 'status'])

  // The nearest *available* expiry wins even when it is not the first entry.
  const reordered = shapeCouponSource({
    state: 'ok',
    data: {
      available_count: 2, total_count: 2, available_balance: 2,
      coupons: [
        { no: 'a', status: 'Available', expiry: '2028-01-01T00:00:00Z' },
        { no: 'b', status: 'Available', expiry: '2026-05-05T00:00:00Z' },
      ],
    },
  })
  assert.equal(reordered.nearestExpiry, '2026-05-05T00:00:00Z')
})

test('view: no configured source is ok:false with rows:[] and setup guidance, not a throw', () => {
  const snapshot = buildSnapshot({ checkedAt: CHECKED_AT, notes: [{ key: 'note.noSource' }] })
  const payload = renderOverview(snapshot, 'zh')
  assert.equal(payload.ok, false)
  assert.equal(payload.enabled, true)
  assert.equal(payload.error, null)
  assert.deepEqual(payload.rows, [])
  assert.equal(payload.summary, null)
  assert.equal(payload.lang, 'zh')
  assert.equal(payload.notes.length, 1)
  assert.match(payload.notes[0], /ALIYUN_AK_ID/)
  assert.equal(payload.sources.aliyun.state, 'off')
  assert.equal(payload.sources.coupons.state, 'off')
  assert.deepEqual(payload.sources.gateways, [])
})

test('view: a disabled plugin reports enabled:false and error `disabled`', () => {
  const snapshot = buildSnapshot({ checkedAt: CHECKED_AT, enabled: false, notes: [] })
  const payload = renderOverview(snapshot, 'zh')
  assert.equal(payload.ok, false)
  assert.equal(payload.enabled, false)
  assert.equal(payload.error, 'disabled')
  assert.deepEqual(payload.rows, [])
  assert.equal(payload.summary, null)
  assert.match(payload.notes[0], /禁用|disabled/)
})

test('view: one failing source leaves the other sources intact', () => {
  const snapshot = buildSnapshot({
    checkedAt: CHECKED_AT,
    aliyun: shapeAliyunSource({ state: 'error', error: 'BSS OpenAPI 报错 [InvalidAccessKeyId.NotFound]' }),
    coupons: shapeCouponSource({ state: 'error', error: '网络不通' }),
    gateways: [gatewayRow()],
    notes: buildNotes({
      aliyun: { state: 'error', error: 'BSS OpenAPI 报错 [InvalidAccessKeyId.NotFound]' },
      coupons: { state: 'error', error: '网络不通' },
      gateways: [gatewayRow()],
      configured: true,
      akConfigured: true,
    }),
  })
  const payload = renderOverview(snapshot, 'zh')
  assert.equal(payload.ok, true, 'the healthy gateway keeps the payload ok')
  const keys = payload.rows.map((row) => row.key)
  assert.ok(keys.includes('gw1.remaining'))
  assert.equal(keys.some((key) => key.startsWith('coupon')), false)
  assert.equal(keys.some((key) => key.startsWith('aliyun')), false)
  assert.ok(payload.notes.some((note) => /InvalidAccessKeyId/.test(note)))
  assert.ok(payload.notes.some((note) => /网络不通/.test(note)))
  assert.equal(payload.sources.gateways[0].state, 'ok')
})

test('view: coupons produce the SPEC rows, and the "not included" note', () => {
  const coupons = shapeCouponSource(couponProbe())
  const snapshot = buildSnapshot({
    checkedAt: CHECKED_AT,
    aliyun: shapeAliyunSource({ state: 'ok', data: { available: 263.66, cash: 263.66, credit: 0, currency: 'CNY' } }),
    coupons,
    notes: buildNotes({ aliyun: shapeAliyunSource({ state: 'ok', data: {} }), coupons, configured: true, akConfigured: true }),
  })
  const payload = renderOverview(snapshot, 'zh')
  const byKey = Object.fromEntries(payload.rows.map((row) => [row.key, row]))
  assert.equal(byKey['coupon.total'].value, '¥263.66')
  assert.equal(byKey['coupon.total'].tone, 'good')
  assert.equal(byKey['coupon.total'].group, 'coupon')
  assert.equal(byKey['coupon.Q-100'].label, '券 Q-100')
  assert.equal(byKey['coupon.Q-100'].value, '¥263.66 · 2027-10-20 到期')
  assert.equal(byKey['coupon.Q-200'], undefined, 'an expired coupon gets no row')
  assert.equal(byKey['aliyun.cash'].value, '¥263.66')
  // SPEC §5.4: the wording must never imply coupons are part of available credit.
  assert.ok(payload.notes.some((note) => /不计入/.test(note)))
  // The headline follows the coupon balance.
  assert.deepEqual([payload.summary.label, payload.summary.value, payload.summary.sub], ['阿里云', '¥263.66', '代金券可用'])
})

test('view: lang changes wording only — every field name and number is identical', () => {
  const snapshot = buildSnapshot({
    checkedAt: CHECKED_AT,
    aliyun: shapeAliyunSource({ state: 'ok', data: { available: 263.66, cash: 12, credit: 0, currency: 'CNY' } }),
    coupons: shapeCouponSource(couponProbe()),
    gateways: [gatewayRow()],
    notes: buildNotes({ aliyun: shapeAliyunSource({ state: 'ok', data: {} }), coupons: shapeCouponSource(couponProbe()), gateways: [gatewayRow()], configured: true, akConfigured: true }),
  })
  const zh = renderOverview(snapshot, 'zh')
  const en = renderOverview(snapshot, 'en')

  assert.equal(zh.lang, 'zh')
  assert.equal(en.lang, 'en')
  assert.notEqual(zh.summary.label, en.summary.label)
  assert.equal(zh.summary.value, en.summary.value)
  assert.deepEqual(zh.rows.map((row) => row.key), en.rows.map((row) => row.key))
  // The one thing `value` localizes is the coupon expiry suffix; no number,
  // field name, tone or group may differ between the two languages.
  const stripSuffix = (value) => String(value).replace(/ · .*$/, '')
  assert.deepEqual(zh.rows.map((row) => stripSuffix(row.value)), en.rows.map((row) => stripSuffix(row.value)))
  const zhCoupon = zh.rows.find((row) => row.key === 'coupon.Q-100').value
  const enCoupon = en.rows.find((row) => row.key === 'coupon.Q-100').value
  assert.match(zhCoupon, /2027-10-20/)
  assert.match(enCoupon, /2027-10-20/)
  assert.notEqual(zhCoupon, enCoupon, 'the expiry suffix itself must be localized')
  assert.deepEqual(zh.rows.map((row) => row.tone), en.rows.map((row) => row.tone))
  assert.deepEqual(zh.rows.map((row) => row.group), en.rows.map((row) => row.group))
  assert.notDeepEqual(zh.rows.map((row) => row.label), en.rows.map((row) => row.label))
  assert.deepEqual(zh.sources, en.sources, 'sources must be language-neutral')
  assert.notDeepEqual(zh.notes, en.notes)

  // An unknown tag folds onto a supported language rather than throwing.
  assert.equal(renderOverview(snapshot, 'zh-Hans-CN').lang, 'zh')
  assert.equal(renderOverview(snapshot, 'fr').lang, 'en')
  assert.equal(renderOverview(snapshot, undefined).lang, 'zh')
})

test('view: the payload never serializes undefined and every number is number|null', () => {
  const snapshot = buildSnapshot({
    checkedAt: CHECKED_AT,
    aliyun: shapeAliyunSource({ state: 'ok', data: { available: 1, cash: 2, credit: 3, currency: 'CNY' } }),
    coupons: shapeCouponSource(couponProbe()),
    gateways: [gatewayRow(), gatewayRow({ id: 'gw2', state: 'error', error: 'boom', remaining: null, total: null, used: null })],
    notes: [{ key: 'note.coupons.notIncluded' }],
  })
  const payload = renderOverview(snapshot, 'en')
  for (const [path, value] of leaves(payload)) {
    assert.notEqual(typeof value, 'undefined', `${path} is undefined and would vanish from JSON`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, 'a JSON round trip must be lossless')

  for (const gateway of payload.sources.gateways) {
    for (const field of ['total', 'used', 'remaining', 'balance']) {
      assert.ok(gateway[field] === null || typeof gateway[field] === 'number', `gateways[].${field}`)
    }
  }
  for (const field of ['availableAmount', 'cashAmount', 'creditAmount']) {
    assert.ok(payload.sources.aliyun[field] === null || typeof payload.sources.aliyun[field] === 'number')
  }
  assert.match(payload.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('view: buildNotes explains each source state, in order', () => {
  const off = buildNotes({ configured: false })
  assert.deepEqual(off, [{ key: 'note.noSource' }])

  const noAk = buildNotes({ configured: true, akConfigured: false, aliyun: { state: 'off', error: null }, coupons: { state: 'off', error: null } })
  assert.deepEqual(noAk.map((note) => note.key), ['note.aliyun.noAk', 'note.coupons.noAk'])

  const akFileError = buildNotes({ configured: true, akConfigured: true, akError: '读取失败', aliyun: { state: 'ok' }, coupons: { state: 'ok', totalCount: 1, availableCount: 1 } })
  assert.equal(akFileError[0].key, 'note.akFileError')
  assert.equal(akFileError[0].vars.error, '读取失败')

  // A broken credential file must not *also* claim that nothing is configured.
  const brokenFile = buildNotes({ configured: true, akConfigured: false, akError: '解析失败', aliyun: { state: 'off' }, coupons: { state: 'off' } })
  assert.deepEqual(brokenFile.map((note) => note.key), ['note.akFileError'])

  const empty = buildNotes({ configured: true, akConfigured: true, aliyun: { state: 'ok' }, coupons: { state: 'ok', totalCount: 0, availableCount: 0 } })
  assert.ok(empty.some((note) => note.key === 'note.coupons.empty'))

  const noneAvailable = buildNotes({ configured: true, akConfigured: true, aliyun: { state: 'ok' }, coupons: { state: 'ok', totalCount: 3, availableCount: 0 } })
  const entry = noneAvailable.find((note) => note.key === 'note.coupons.noAvailable')
  assert.equal(entry.vars.total, 3)

  // A quiet source pair, so only the gateway notes remain.
  const quiet = { state: 'off', error: null }
  const gatewayOff = buildNotes({
    configured: true,
    akConfigured: true,
    aliyun: quiet,
    coupons: quiet,
    gatewayNames: { gw1: 'relay-a' },
    gateways: [{ id: 'gw1', name: '', state: 'off' }],
  })
  assert.equal(gatewayOff[0].key, 'note.gateway.off')
  assert.equal(gatewayOff[0].vars.name, 'relay-a')

  const gatewayError = buildNotes({
    configured: true,
    akConfigured: true,
    aliyun: quiet,
    coupons: quiet,
    gateways: [{ id: 'gw1', name: 'relay-a', state: 'error', error: 'boom' }],
  })
  assert.deepEqual(gatewayError.map((note) => note.key), ['note.gateway.error', 'note.gateway.hint'])
})

test('view: the summary prefers coupons, then available credit, then a gateway', () => {
  const gatewayOnly = buildSnapshot({ checkedAt: CHECKED_AT, gateways: [gatewayRow()] })
  assert.deepEqual(
    [renderOverview(gatewayOnly, 'zh').summary.label, renderOverview(gatewayOnly, 'zh').summary.value],
    ['中转站', '$7.66'],
  )

  const aliyunOnly = buildSnapshot({ checkedAt: CHECKED_AT, aliyun: shapeAliyunSource({ state: 'ok', data: { available: 50, currency: 'CNY' } }) })
  assert.deepEqual(
    [renderOverview(aliyunOnly, 'zh').summary.sub, renderOverview(aliyunOnly, 'zh').summary.value],
    ['可用额度', '¥50.00'],
  )

  const nothing = buildSnapshot({ checkedAt: CHECKED_AT })
  assert.equal(renderOverview(nothing, 'zh').summary, null)
})

test('view: showCoupons/showGateways hide rows but never the error state', () => {
  const snapshot = buildSnapshot({
    checkedAt: CHECKED_AT,
    showCoupons: false,
    showGateways: false,
    aliyun: shapeAliyunSource({ state: 'ok', data: { available: 1, currency: 'CNY' } }),
    coupons: shapeCouponSource(couponProbe()),
    gateways: [gatewayRow()],
  })
  const payload = renderOverview(snapshot, 'zh')
  assert.equal(payload.rows.some((row) => row.group === 'coupon'), false)
  assert.equal(payload.rows.some((row) => row.group === 'gateway'), false)
  assert.ok(payload.sources.coupons.items.length > 0, 'the data is still reported, only the rows are hidden')
  assert.equal(payload.ok, true)
})