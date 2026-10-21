/**
 * i18n.js — the plugin's zh/en wording table.
 *
 * Contract (SPEC.md §3.3): `lang` only changes wording — `summary.label`,
 * `rows[].label`, `rows[].value` suffixes and `notes`. Field names, structure
 * and every number stay identical across languages, so the browser half never
 * has to guess and the payload stays diffable.
 *
 * Everything the card shows is a *label*; nothing here computes money. Numbers
 * are formatted by `view.js#money`, which is language-neutral on purpose.
 */

/** The two languages the payload supports. */
export const LANGS = ['zh', 'en']

const ZH = {
  /* ---- summary ---------------------------------------------------------- */
  'summary.aliyun': '阿里云',
  'summary.gateway': '中转站',
  'sub.coupon': '代金券可用',
  'sub.aliyun': '可用额度',
  'sub.gateway': '剩余',

  /* ---- rows ------------------------------------------------------------- */
  'row.coupon.total': '代金券可用',
  'row.coupon.item': '券 {no}',
  'row.coupon.expiry': '{date} 到期',
  'row.coupon.none': '代金券',
  'row.aliyun.available': '可用额度',
  'row.aliyun.cash': '现金余额',
  'row.aliyun.credit': '信控额度',
  'row.gw.remaining': '{name} 剩余',
  'row.gw.balance': '{name} 余额',
  'row.gw.total': '{name} 总额度',
  'row.gw.used': '{name} 已用',
  'gateway.defaultName': '中转站 {n}',
  'value.noData': '无数据',
  'value.unavailable': '不可用',

  /* ---- notes ------------------------------------------------------------ */
  'note.disabled': '插件已在 DSH 设置里禁用（enabled=false）。',
  'note.noSource': '未配置任何余额来源：阿里云需要 ALIYUN_AK_ID / ALIYUN_AK_SECRET 环境变量，或 %USERPROFILE%\\.dsh\\qwen-coupon.json；中转站需要在插件配置里填 baseUrl 与 apiKey。',
  'note.aliyun.noAk': '未配置阿里云 AccessKey（可在插件配置里填，或设置 ALIYUN_AK_ID / ALIYUN_AK_SECRET 环境变量）。',
  'note.aliyun.error': '阿里云账户余额查询失败：{error}',
  'note.aliyun.hint': '常见原因：AccessKey 不对、RAM 用户缺 bss:DescribeAcccount 权限、站点不匹配（国际站用 business.ap-southeast-1.aliyuncs.com）。',
  'note.coupons.noAk': '未配置阿里云 AccessKey，代金券余额不可见。',
  'note.coupons.error': '代金券查询失败：{error}',
  'note.coupons.hint': '常见原因：RAM 用户缺 bss:DescribeCoupons 权限、AccessKey 不对、站点不匹配。',
  'note.coupons.empty': '这个账号名下没有查到任何代金券。',
  'note.coupons.noAvailable': '查到 {total} 张代金券，但没有一张处于可用状态。',
  'note.coupons.notIncluded': '代金券余额是独立数字，不计入「可用额度」（阿里云官方定义）。',
  'note.coupons.available': '代金券可用余额 {amount}（{count} 张可用）。',
  'note.gateway.error': '{name} 查询失败：{error}',
  'note.gateway.off': '{name} 未配置（需要 baseUrl 与 apiKey，或用 apiKeyEnv 指定环境变量）。',
  'note.gateway.noEndpoint': '{name} 没有暴露任何余额端点（/dashboard/billing/* 与 /user/balance 都不可用）。',
  'note.gateway.hint': '中转站请确认 baseUrl 指向 OpenAI 兼容根地址（例如 https://example.com），kind=auto 会自动识别 new-api / one-api 与 DeepSeek 风格。',
  'note.akFileError': '读取 AccessKey 文件失败：{error}',
  'note.internalError': '余额探测内部错误：{error}',
}

const EN = {
  /* ---- summary ---------------------------------------------------------- */
  'summary.aliyun': 'Alibaba Cloud',
  'summary.gateway': 'Gateway',
  'sub.coupon': 'coupons available',
  'sub.aliyun': 'available credit',
  'sub.gateway': 'remaining',

  /* ---- rows ------------------------------------------------------------- */
  'row.coupon.total': 'Coupons available',
  'row.coupon.item': 'Coupon {no}',
  'row.coupon.expiry': 'expires {date}',
  'row.coupon.none': 'Coupons',
  'row.aliyun.available': 'Available credit',
  'row.aliyun.cash': 'Cash balance',
  'row.aliyun.credit': 'Credit line',
  'row.gw.remaining': '{name} remaining',
  'row.gw.balance': '{name} balance',
  'row.gw.total': '{name} total',
  'row.gw.used': '{name} used',
  'gateway.defaultName': 'Gateway {n}',
  'value.noData': 'no data',
  'value.unavailable': 'unavailable',

  /* ---- notes ------------------------------------------------------------ */
  'note.disabled': 'This plugin is disabled in DSH settings (enabled=false).',
  'note.noSource': 'No balance source is configured. Alibaba Cloud needs ALIYUN_AK_ID / ALIYUN_AK_SECRET or %USERPROFILE%\\.dsh\\qwen-coupon.json; a gateway needs baseUrl and apiKey in the plugin config.',
  'note.aliyun.noAk': 'No Alibaba Cloud AccessKey configured (set it in the plugin config or via ALIYUN_AK_ID / ALIYUN_AK_SECRET).',
  'note.aliyun.error': 'Alibaba Cloud account balance query failed: {error}',
  'note.aliyun.hint': 'Usual causes: wrong AccessKey, RAM user missing bss:DescribeAcccount, or the wrong site (use business.ap-southeast-1.aliyuncs.com for the international site).',
  'note.coupons.noAk': 'No Alibaba Cloud AccessKey configured, so coupon balance is not visible.',
  'note.coupons.error': 'Coupon query failed: {error}',
  'note.coupons.hint': 'Usual causes: RAM user missing bss:DescribeCoupons, wrong AccessKey, or the wrong site.',
  'note.coupons.empty': 'No coupons were found for this account.',
  'note.coupons.noAvailable': 'Found {total} coupon(s), but none of them is currently available.',
  'note.coupons.notIncluded': 'Coupon balance is a separate number and is NOT part of "available credit" (Alibaba Cloud definition).',
  'note.coupons.available': 'Coupons available: {amount} ({count} usable).',
  'note.gateway.error': '{name} query failed: {error}',
  'note.gateway.off': '{name} is not configured (baseUrl and apiKey are required, or name an env var with apiKeyEnv).',
  'note.gateway.noEndpoint': '{name} exposes no balance endpoint (neither /dashboard/billing/* nor /user/balance answered).',
  'note.gateway.hint': 'Check that baseUrl points at the OpenAI-compatible root (for example https://example.com); kind=auto detects new-api / one-api and the DeepSeek-style endpoint.',
  'note.akFileError': 'Reading the AccessKey file failed: {error}',
}

/** The whole table, keyed by language. */
export const MESSAGES = { zh: ZH, en: EN }

/**
 * Fold any language tag onto a supported one: anything starting with `zh`
 * (zh, zh-CN, zh-Hans, ZH_cn) becomes `zh`, everything else becomes `en`.
 * @param {unknown} value - a lang query value, navigator language, or nothing.
 * @returns {'zh'|'en'} the supported language.
 */
export function normalizeLang(value) {
  return String(value ?? '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Look one message up and substitute `{name}` placeholders.
 * A missing key falls back to the English table and finally to the key itself,
 * so a new label can never crash the card.
 * @param {unknown} lang - requested language.
 * @param {string} key - message key.
 * @param {Record<string, unknown>} [vars] - placeholder values.
 * @returns {string} the localized text.
 */
export function t(lang, key, vars) {
  const table = MESSAGES[normalizeLang(lang)] ?? EN
  const raw = table[key] ?? EN[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name) => {
    const value = vars[name]
    return value === undefined || value === null ? match : String(value)
  })
}