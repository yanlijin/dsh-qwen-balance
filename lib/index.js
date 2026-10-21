/**
 * dsh-qwen-balance — host half.
 *
 * A cordis plugin that (a) probes the configured balance sources on a timer,
 * (b) serves the frozen payload of SPEC.md §3.3 over two loopback-only routes,
 * and (c) hands the browser half a fresh snapshot on demand.
 *
 * Sources, in payload order: Alibaba Cloud account balance (BSS
 * `QueryAccountBalance`), Alibaba Cloud coupons (BSS `QueryCashCoupons`), and
 * 0..N OpenAI-compatible relays probed through `gateway.js`.
 *
 * Routes:
 *   GET  /api/dsh-qwen-balance/overview?lang=zh|en
 *   POST /api/dsh-qwen-balance/refresh
 * Both answer loopback callers only — a non-loopback request gets
 * `403 {ok:false, error:"forbidden: loopback-only"}` (SPEC.md §3.2, §5).
 *
 * Network: `node:http`/`node:https` with `agent:false`, never
 * `globalThis.fetch`/undici. On Windows an undici keep-alive socket tears down
 * concurrently with libuv's handle close and `process.exit` then aborts with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`.
 * `bss.js` owns the transport; nothing in this package bypasses it.
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveAk, maskKey, redactSecrets } from './core/ak.js'
import { queryAccountBalance, queryCashCoupons } from './core/bss.js'
import { probeGateway } from './core/gateway.js'
import { normalizeLang } from './core/i18n.js'
import {
  buildNotes,
  buildSnapshot,
  renderOverview,
  shapeAliyunSource,
  shapeCouponSource,
} from './core/view.js'

/** Plugin id; must match `package.json#name` and the cordis patch row. */
export const name = 'dsh-qwen-balance'

/** The only service this plugin needs: the host HTTP carrier. */
export const inject = ['webServer']

/** Route prefix shared by both endpoints. */
export const API_PREFIX = '/api/dsh-qwen-balance'

/** Per-request network timeout for every probe. */
export const PROBE_TIMEOUT_MS = 15000

/** Bounds of `pollIntervalSec`, matching the schema. */
const MIN_POLL_SEC = 30
const MAX_POLL_SEC = 3600
const DEFAULT_POLL_SEC = 60

/* ========================================================================== *
 * schemastery resolution
 *
 * The package's single runtime dependency is `@deepseek-ai/schemastery`, and
 * the blessed form is the bare import below. It is not the only form used here
 * because a plugin installed with pnpm's `link:` protocol cannot resolve it:
 * `dsh plugin add` forwards straight to pnpm
 * (`<profiles>/node_modules/@deepseek-ai/dsh/lib/bin.js`), `link:` symlinks the
 * package without installing its dependencies, and Node's ESM resolver
 * realpaths the symlink before resolving bare specifiers. The observed failure
 * is
 *   `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
 *    imported from E:\...\dsh-qwen-balance\lib\index.js`
 * even though the profile's hoisted copy sits one directory away.
 *
 * So: try the bare specifier, then the profile's hoisted copy by absolute path
 * (still the real library), and only then a minimal built-in stand-in so that
 * `import('dsh-qwen-balance')` — and therefore `node --test` in the package —
 * can never fail outright. `SCHEMA_SOURCE` reports which one won.
 * ========================================================================== */

/** Absolute candidates for the profile-hoisted schemastery entry point. */
function schemasteryCandidates() {
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  homes.push(path.join(os.homedir(), '.dsh'))
  const profiles = ['desktop', 'web', 'headless', 'tui', 'tauri', 'dsh-tui']
  const rel = path.join('node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
  const out = []
  for (const home of homes) {
    out.push(path.join(home, 'profiles', rel))
    for (const profile of profiles) out.push(path.join(home, 'profiles', profile, rel))
  }
  return out
}

/**
 * A deliberately tiny stand-in for schemastery, used only when neither the bare
 * specifier nor a profile-hoisted copy resolves. It supports exactly the
 * constructs this Config uses (object/array/union/const/scalars plus
 * `default`/`min`/`max`/`volatile`) so that plugin *loading* never fails; a
 * real DSH always resolves the real library and never reaches this branch.
 * @returns {object} a `z`-shaped factory.
 */
function fallbackSchemastery() {
  const make = (spec) => {
    const schema = (data) => resolveWith(spec, data)
    schema.spec = spec
    schema.meta = spec.meta
    schema.default = (value) => make({ ...spec, meta: { ...spec.meta, default: value } })
    schema.min = (value) => make({ ...spec, meta: { ...spec.meta, min: value } })
    schema.max = (value) => make({ ...spec, meta: { ...spec.meta, max: value } })
    schema.volatile = () => make({ ...spec, meta: { ...spec.meta, volatile: true } })
    schema.simplify = (data) => resolveWith(spec, data)
    return schema
  }
  const resolveWith = (spec, data) => {
    if (data === undefined || data === null) {
      if (Object.prototype.hasOwnProperty.call(spec.meta, 'default')) {
        return typeof spec.meta.default === 'object' ? structuredClone(spec.meta.default) : spec.meta.default
      }
      if (spec.meta.required) throw new Error('missing required value')
      return undefined
    }
    switch (spec.type) {
      case 'object': {
        const out = {}
        for (const [key, child] of Object.entries(spec.dict ?? {})) {
          const value = resolveWith(child.spec, data[key])
          if (value !== undefined) out[key] = value
        }
        return out
      }
      case 'array':
        return (Array.isArray(data) ? data : []).map((item) => resolveWith(spec.inner.spec, item))
      case 'union': {
        let lastError
        for (const option of spec.list ?? []) {
          try { return resolveWith(option.spec, data) } catch (error) { lastError = error }
        }
        throw lastError ?? new Error('no union variant matched')
      }
      case 'const':
        if (data === spec.value) return data
        throw new Error(`expected ${String(spec.value)}`)
      case 'boolean':
        return Boolean(data)
      case 'number': {
        const value = Number(data)
        if (!Number.isFinite(value)) throw new Error('expected a number')
        if (spec.meta.min !== undefined && value < spec.meta.min) throw new Error('below min')
        if (spec.meta.max !== undefined && value > spec.meta.max) throw new Error('above max')
        return value
      }
      default:
        return String(data)
    }
  }
  const z = {
    any: () => make({ type: 'any', meta: {} }),
    const: (value) => make({ type: 'const', value, meta: {} }),
    string: () => make({ type: 'string', meta: {} }),
    number: () => make({ type: 'number', meta: {} }),
    natural: () => make({ type: 'number', meta: {} }),
    boolean: () => make({ type: 'boolean', meta: {} }),
    array: (inner) => make({ type: 'array', inner, meta: {} }),
    object: (dict) => make({ type: 'object', dict, meta: {} }),
    union: (list) => make({ type: 'union', list, meta: {} }),
  }
  return { ...z, default: z }
}

const SCHEMA_CANDIDATES = schemasteryCandidates()

async function loadSchemastery() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    return { z: mod.default ?? mod, source: 'package' }
  } catch { /* fall through to the profile-hoisted copy */ }
  for (const candidate of SCHEMA_CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      return { z: mod.default ?? mod, source: `profile:${candidate}` }
    } catch { /* try the next profile */ }
  }
  return { z: fallbackSchemastery(), source: 'builtin-fallback' }
}

const { z, source: SCHEMA_SOURCE } = await loadSchemastery()

export { SCHEMA_SOURCE }

/* ========================================================================== *
 * Config — SPEC.md §3.4
 * ========================================================================== */

/**
 * Plugin configuration.
 *
 * The Host derives one settings form per profile entry from this schema and
 * serves it only when at least one field is `volatile()`, so every user-facing
 * field carries it.
 *
 * NOTE on `gateways`: SPEC.md §3.4 literally marks the per-entry fields
 * volatile *and* the array volatile. schemastery rejects that combination —
 * `validateVolatileSchema` (schemastery `src/index.ts:488-509`, which passes
 * `blocked = true` into an array's `inner`) requires a volatile field to sit at
 * a fixed object path and refuses one nested inside another volatile field:
 *   `ValidationError - $.gateways.*.name volatile fields require a fixed object
 *    path without an enclosing volatile field`
 * Since the array is itself the volatile unit here, marking it volatile is both
 * sufficient and correct: `gateways` still surfaces as one live-editable field.
 */
export const Config = z.object({
  /** Master switch; `false` disables polling and probing entirely. */
  enabled: z.boolean().default(true).volatile(),
  /** Seconds between probe cycles (30-3600). */
  pollIntervalSec: z.number().min(MIN_POLL_SEC).max(MAX_POLL_SEC).default(DEFAULT_POLL_SEC).volatile(),
  /** Render the coupon rows on the card. */
  showCoupons: z.boolean().default(true).volatile(),
  /** Render the gateway rows on the card. */
  showGateways: z.boolean().default(true).volatile(),
  /** Alibaba Cloud BSS source. */
  aliyun: z.object({
    enabled: z.boolean().default(true).volatile(),
    /** BSS endpoint; empty means the mainland `business.aliyuncs.com`. */
    endpoint: z.string().default('').volatile(),
    /** Last-resort plaintext AccessKey id (env and the AK file win over this). */
    akId: z.string().default('').volatile(),
    /** Last-resort plaintext AccessKey secret. */
    akSecret: z.string().default('').volatile(),
    /** Also consult the AK file. */
    useAkFile: z.boolean().default(true).volatile(),
    /** AK file path; empty means `%USERPROFILE%\.dsh\qwen-coupon.json`. */
    akFile: z.string().default('').volatile(),
  }).default({}),
  /** OpenAI-compatible relays to probe. */
  gateways: z.array(z.object({
    name: z.string().default(''),
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    apiKeyEnv: z.string().default(''),
    kind: z.union([z.const('auto'), z.const('newapi'), z.const('user-balance')]).default('auto'),
  })).default([]).volatile(),
})

/* ========================================================================== *
 * loopback fence — ported from dsh-web-shared/host/loopback
 * ========================================================================== */

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4) {
  const parts = String(v4).split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback `Host`
 * header, plus browser same-origin markers. The socket address is
 * authoritative; `X-Forwarded-For` is never trusted (SPEC.md §5).
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} true when the request may enter the plugin's routes.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Write one JSON response. Mirrors the host's other plugin routes: the handler
 * owns the full response lifecycle.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the body to serialize.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(payload)
}

/** Read `?lang=` off a request URL; missing means the project's primary language. */
export function readLang(req) {
  let params
  try {
    params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return 'zh'
  }
  const raw = params.get('lang')
  return normalizeLang(raw ?? 'zh')
}

/* ========================================================================== *
 * config access
 *
 * A volatile field materializes as a cosmokit volatile reference, not as a
 * plain value, so every read goes through these unwrappers. They also accept
 * plain values, which is what the built-in fallback schema and the unit tests
 * produce.
 * ========================================================================== */

/**
 * Unwrap one config field.
 * @param {unknown} field - a volatile ref, plain value, or nothing.
 * @param {unknown} fallback - value to use when absent/unreadable.
 * @returns {unknown} the effective value.
 */
export function readConfigField(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'function') {
    try {
      const value = field()
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  if (typeof field === 'object' && typeof field.get === 'function') {
    try {
      const value = field.get()
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  return field
}

/** Boolean field with a default. */
function readBool(field, fallback) {
  const value = readConfigField(field, fallback)
  return typeof value === 'boolean' ? value : fallback
}

/** String field with a default. */
function readString(field, fallback = '') {
  const value = readConfigField(field, fallback)
  return typeof value === 'string' ? value : fallback
}

/** Number field with a default, coerced and clamped. */
function readNumber(field, fallback, min, max) {
  const value = Number(readConfigField(field, fallback))
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/** Object field with a default. */
function readObject(field, fallback = {}) {
  const value = readConfigField(field, fallback)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

/** Array field with a default. */
function readArray(field, fallback = []) {
  const value = readConfigField(field, fallback)
  return Array.isArray(value) ? value : fallback
}

/** Collapse any thrown value into a short, single-line, secret-free message. */
function shortError(error, secrets = []) {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown error')
  return redactSecrets(raw.replace(/\s+/g, ' ').trim().slice(0, 240), secrets)
}

/* ========================================================================== *
 * probe cycle
 * ========================================================================== */

/**
 * Run one complete probe cycle and freeze it into a language-neutral snapshot.
 *
 * Never throws: each source is isolated in its own try/catch so one failing
 * source (bad AccessKey, an HTML-answering relay, a dead host) can never take
 * the others down or bubble up as a 500 (SPEC.md §3.3, §3.5).
 *
 * @param {object} [input] - cycle inputs.
 * @param {object} [input.config] - the raw plugin config (volatile refs).
 * @param {Record<string, string|undefined>} [input.env] - environment to read.
 * @param {string} [input.homeDir] - home directory override (tests).
 * @param {string} [input.akFile] - AK file override (tests).
 * @param {number} [input.timeoutMs] - per-request timeout.
 * @param {string} [input.now] - ISO instant override (tests).
 * @returns {Promise<object>} a snapshot for `renderOverview`.
 */
export async function collectOnce({
  config = {},
  env = process.env,
  homeDir = '',
  akFile = '',
  timeoutMs = PROBE_TIMEOUT_MS,
  now = '',
} = {}) {
  const checkedAt = now || new Date().toISOString()
  const enabled = readBool(config.enabled, true)
  const showCoupons = readBool(config.showCoupons, true)
  const showGateways = readBool(config.showGateways, true)
  const base = { checkedAt, enabled, showCoupons, showGateways }

  if (!enabled) return buildSnapshot({ ...base, notes: [] })

  const aliyunCfg = readObject(config.aliyun, {})
  const aliyunEnabled = readBool(aliyunCfg.enabled, true)
  const ak = resolveAk({
    env,
    // `readObject` unwraps the volatile `aliyun` object, but the object's own
    // *fields* are still cosmokit volatile refs, and `resolveAk` reads plain
    // values. Unwrap each field here instead of teaching ak.js about cosmokit.
    plugin: {
      akId: readString(aliyunCfg.akId, ''),
      akSecret: readString(aliyunCfg.akSecret, ''),
      endpoint: readString(aliyunCfg.endpoint, ''),
      akFile: readString(aliyunCfg.akFile, ''),
      useAkFile: readBool(aliyunCfg.useAkFile, true),
    },
    akFile,
    homeDir,
  })

  let aliyunProbe = { state: 'off', error: null, data: null }
  let couponProbe = { state: 'off', error: null, data: null }
  if (ak.configured && aliyunEnabled) {
    const call = {
      accessKeyId: ak.accessKeyId,
      accessKeySecret: ak.accessKeySecret,
      securityToken: ak.securityToken,
      endpoint: ak.endpoint,
      timeoutMs,
    }
    const secrets = [ak.accessKeySecret, ak.accessKeyId, ak.securityToken]
    try {
      aliyunProbe = { state: 'ok', error: null, data: await queryAccountBalance(call) }
    } catch (error) {
      aliyunProbe = { state: 'error', error: shortError(error, secrets), data: null }
    }
    try {
      couponProbe = { state: 'ok', error: null, data: await queryCashCoupons(call) }
    } catch (error) {
      couponProbe = { state: 'error', error: shortError(error, secrets), data: null }
    }
  }

  const gatewayEntries = readArray(config.gateways, [])
  const gateways = await Promise.all(gatewayEntries.map(async (entry, index) => {
    const item = entry && typeof entry === 'object' ? entry : {}
    const name = readString(item.name, '')
    const baseUrl = readString(item.baseUrl, '')
    const apiKeyEnv = readString(item.apiKeyEnv, '')
    // An explicitly named env var wins over an inline key: SPEC.md §5 prefers
    // the environment over plaintext config for secrets.
    const fromEnv = apiKeyEnv ? readString(env[apiKeyEnv], '') : ''
    return probeGateway({
      id: `gw${index + 1}`,
      name,
      baseUrl,
      apiKey: fromEnv || readString(item.apiKey, ''),
      kind: readString(item.kind, 'auto'),
      timeoutMs,
    })
  }))

  const aliyun = shapeAliyunSource(aliyunProbe)
  const coupons = shapeCouponSource({ ...couponProbe, akIdMasked: ak.accessKeyId ? maskKey(ak.accessKeyId) : null })
  // An unreadable AK file also counts as "configured": the user did configure a
  // source and needs to be told *why* it produced nothing, rather than being
  // handed the generic "nothing configured yet" hint.
  const configured = Boolean(aliyunEnabled && (ak.configured || ak.error)) || gatewayEntries.length > 0
  const notes = buildNotes({
    aliyun,
    coupons,
    gateways,
    configured,
    akConfigured: ak.configured && aliyunEnabled,
    akError: ak.error,
  })
  return buildSnapshot({ ...base, aliyun, coupons, gateways, notes })
}

/* ========================================================================== *
 * runtime: snapshot cache, staleness, poll timer
 * ========================================================================== */

/**
 * Create the runtime behind both routes: one cached snapshot, a single-flight
 * refresh, and a self-re-arming poll timer.
 * @param {object} [options] - runtime inputs.
 * @param {object} [options.config] - raw plugin config.
 * @param {Record<string, string|undefined>} [options.env] - environment.
 * @returns {object} the runtime handle consumed by `createRoutes`.
 */
export function createRuntime({ config = {}, env = process.env } = {}) {
  let snapshot = null
  let inFlight = null
  let timer = null
  let disposed = false
  let signature = ''

  const enabled = () => readBool(config.enabled, true)
  const intervalMs = () => readNumber(config.pollIntervalSec, DEFAULT_POLL_SEC, MIN_POLL_SEC, MAX_POLL_SEC) * 1000

  /** One probe cycle; concurrent callers share the in-flight promise. */
  const refresh = () => {
    if (inFlight) return inFlight
    inFlight = collectOnce({ config, env })
      .then((next) => { if (!disposed) snapshot = next; return snapshot })
      .catch((error) => {
        // collectOnce isolates every source, so reaching here means a bug.
        // Keep serving the previous snapshot rather than failing the request.
        if (!snapshot) {
          snapshot = buildSnapshot({
            checkedAt: new Date().toISOString(),
            enabled: enabled(),
            notes: [{ key: 'note.internalError', vars: { error: shortError(error) } }],
          })
        }
        return snapshot
      })
      .finally(() => { inFlight = null })
    return inFlight
  }

  /** The snapshot to answer with, refreshing only when it is missing or stale. */
  const ensure = async () => {
    if (snapshot && (Date.now() - Date.parse(snapshot.checkedAt) < intervalMs())) return snapshot
    return refresh()
  }

  const stopPolling = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  /**
   * (Re)arm the timer. Called at activation and on every volatile config
   * change; restarts only when `enabled` / `pollIntervalSec` actually moved, so
   * editing an unrelated field does not reset the cadence.
   */
  const rearm = () => {
    if (disposed) return
    const next = `${enabled()}:${readNumber(config.pollIntervalSec, DEFAULT_POLL_SEC, MIN_POLL_SEC, MAX_POLL_SEC)}`
    if (next === signature && timer) return
    signature = next
    stopPolling()
    if (!enabled()) { snapshot = null; return }
    timer = setInterval(() => { void refresh() }, intervalMs())
    // Never hold the host process open on our account.
    if (typeof timer.unref === 'function') timer.unref()
  }

  const dispose = () => {
    disposed = true
    stopPolling()
  }

  return { refresh, ensure, rearm, dispose, get snapshot() { return snapshot } }
}

/* ========================================================================== *
 * routes
 * ========================================================================== */

/** The `403` body shared by both routes (exact SPEC.md §3.2 wording). */
const FORBIDDEN = { ok: false, error: 'forbidden: loopback-only' }

/** The `405` body for a wrong method. */
const METHOD_NOT_ALLOWED = { ok: false, error: 'method not allowed' }

/** Never 500: a broken cycle is still rendered as a valid payload. */
function degradedSnapshot(error) {
  return buildSnapshot({
    checkedAt: new Date().toISOString(),
    enabled: true,
    notes: [{ key: 'note.internalError', vars: { error: shortError(error) } }],
  })
}

/**
 * Build the two `WebRoute`s for a runtime.
 *
 * Exported so tests can drive the handlers without a cordis host — the
 * loopback fence, the status codes and the headers are the security-relevant
 * parts of this plugin and are worth exercising directly.
 * @param {object} runtime - a runtime from `createRuntime`.
 * @returns {Array<{kind: 'exact', path: string, handler: Function}>} the routes.
 */
export function createRoutes(runtime) {
  const overview = {
    kind: 'exact',
    path: `${API_PREFIX}/overview`,
    handler: async (req, res) => {
      // Security before semantics: the fence runs before anything is parsed.
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, FORBIDDEN)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, METHOD_NOT_ALLOWED)
        return
      }
      const lang = readLang(req)
      try {
        const snapshot = await runtime.ensure()
        writeJson(res, 200, renderOverview(snapshot, lang), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 200, renderOverview(degradedSnapshot(error), lang), { 'cache-control': 'no-store' })
      }
    },
  }
  const refresh = {
    kind: 'exact',
    path: `${API_PREFIX}/refresh`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, FORBIDDEN)
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, METHOD_NOT_ALLOWED)
        return
      }
      const lang = readLang(req)
      try {
        const snapshot = await runtime.refresh()
        writeJson(res, 200, renderOverview(snapshot, lang), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 200, renderOverview(degradedSnapshot(error), lang), { 'cache-control': 'no-store' })
      }
    },
  }
  return [overview, refresh]
}

/* ========================================================================== *
 * plugin entry
 * ========================================================================== */

/**
 * Mount the plugin: register both routes, arm the poll timer, and warm the
 * cache in the background so the first browser request is already answered.
 *
 * The returned disposer is idempotent — it is reachable both through cordis's
 * `ctx.effect` teardown and through the value `apply` returns, and must be safe
 * to run twice.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} [config] - plugin config.
 * @returns {() => void} the disposer.
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime({ config, env: process.env })
  let cleanup = null
  let done = false
  const once = () => {
    if (done) return
    done = true
    cleanup?.()
  }

  ctx.effect(() => {
    const disposers = createRoutes(runtime).map((route) => ctx.webServer.register(route))
    runtime.rearm()
    // Warm the cache without blocking activation; `/overview` re-checks
    // staleness anyway, so a failure here costs nothing.
    void runtime.refresh()
    ctx.on('loader/volatile-update', () => runtime.rearm())
    cleanup = () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          ctx.logger?.warn?.(error)
        }
      }
      runtime.dispose()
    }
    return once
  }, 'dsh-qwen-balance: runtime')

  return once
}

export default { name, inject, Config, apply }