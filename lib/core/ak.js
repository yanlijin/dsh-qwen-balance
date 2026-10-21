/**
 * ak.js — AccessKey resolution and the package's only masking primitives.
 *
 * Two jobs, both security-relevant:
 *
 *  1. Decide which AccessKey the host should use. Priority (SPEC.md §3.4):
 *     environment variables > the AK file > the plugin config. A credential
 *     file is recommended over the plugin config because the plugin config is
 *     plain text in the profile's settings document.
 *
 *  2. Mask anything that reaches a response, a log line or an error message.
 *     SPEC.md §5 forbids a plaintext AccessKey, STS token or gateway key
 *     anywhere outside the outbound request itself; the only accepted form is
 *     the mask (<=12 chars: first 2 + `***`; longer: first 6 + `...` + last 4).
 *
 * Nothing here performs I/O beyond reading the credential file, and no error
 * message ever carries key material.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Plugin-config/endpoint default: the mainland-China BSS site. */
export const DEFAULT_BSS_ENDPOINT = 'business.aliyuncs.com'

/** Where the user is expected to keep the AccessKey: `%USERPROFILE%\.dsh\qwen-coupon.json`. */
export const DEFAULT_AK_FILE = path.join(os.homedir(), '.dsh', 'qwen-coupon.json')

/**
 * Mask one secret. The exact rule from SPEC.md §3.3:
 * length <= 12 -> first 2 characters + `***`; longer -> first 6 + `...` + last 4.
 * @param {unknown} value - the secret to mask.
 * @returns {string} the mask, or `''` for an absent value.
 */
export function maskKey(value) {
  const s = String(value ?? '')
  if (!s) return ''
  if (s.length <= 12) return `${s.slice(0, 2)}***`
  return `${s.slice(0, 6)}...${s.slice(-4)}`
}

/**
 * Replace every occurrence of the given secrets inside a string, or inside
 * every string of an object/array (the shape returned by a probe).
 *
 * Why walk the object: the error texts are third-party. Some gateways echo the
 * `Authorization` header back in a 401 body, so a naive renderer would print
 * the key into the browser payload and the log. Redacting once at the boundary
 * is the only version that cannot be forgotten at a new call site.
 * @param {unknown} value - string, array, plain object, or anything else.
 * @param {Iterable<unknown>} [secrets] - raw secret values to redact.
 * @returns {unknown} a redacted copy (same shape for objects/arrays).
 */
export function redactSecrets(value, secrets = []) {
  const pairs = []
  for (const secret of secrets ?? []) {
    const s = String(secret ?? '')
    // Short values would match everywhere and mangle the text; a real key is
    // never this short.
    if (s.length < 6) continue
    const masked = maskKey(s)
    for (const form of [s, encodeURIComponent(s)]) {
      if (form && form !== masked && !pairs.some(([from]) => from === form)) pairs.push([form, masked])
    }
  }
  if (!pairs.length) return value
  pairs.sort((a, b) => b[0].length - a[0].length)
  const walk = (node) => {
    if (typeof node === 'string') {
      let out = node
      for (const [from, to] of pairs) out = out.split(from).join(to)
      return out
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const copy = {}
      for (const [key, item] of Object.entries(node)) copy[key] = walk(item)
      return copy
    }
    return node
  }
  return walk(value)
}

/** First non-empty trimmed string among the arguments. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Read one of several key spellings from a JSON object. */
function pick(object, ...names) {
  if (!object || typeof object !== 'object') return ''
  for (const name of names) {
    const value = object[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Read the credential file. Never throws: a missing file is the normal
 * "not configured yet" state, and a broken one is reported as a short message
 * (the file path is not secret; its contents are).
 * @param {string} file - absolute path of the credential file.
 * @returns {{ id: string, secret: string, token: string, endpoint: string, error: string|null }} the parsed fields.
 */
export function readAkFile(file) {
  const empty = { id: '', secret: '', token: '', endpoint: '', error: null }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // ENOENT means "no file yet" and must stay silent.
    if (error && error.code === 'ENOENT') return empty
    return { ...empty, error: redactSecrets(`读取 ${file} 失败：${error?.message ?? error}`, []) }
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    // JSON.parse's own message quotes the offending text — and that text is
    // where the secret lives, so it must never be echoed back.
    return { ...empty, error: `解析 ${file} 失败：不是合法的 JSON` }
  }
  // Accept both the documented flat shape and a nested `aliyun` object.
  const nested = json && typeof json.aliyun === 'object' && json.aliyun !== null ? json.aliyun : json
  return {
    id: pick(nested, 'aliyunAkId', 'accessKeyId', 'accessKeyID', 'akId', 'aliyunAccessKeyId'),
    secret: pick(nested, 'aliyunAkSecret', 'accessKeySecret', 'akSecret', 'aliyunAccessKeySecret'),
    token: pick(nested, 'aliyunStsToken', 'securityToken', 'stsToken'),
    endpoint: pick(nested, 'bssEndpoint', 'endpoint'),
    error: null,
  }
}

/**
 * Resolve the effective AccessKey for one probe cycle.
 *
 * Priority is whole-source, not per-field: if the environment supplies both an
 * id and a secret, the file and the plugin config are not consulted at all.
 * When the winning source is incomplete (id without secret, say), the missing
 * half is filled from the next source so a partially exported environment still
 * works — and `source` reports where it came from.
 *
 * Never throws and never returns key material in `error`.
 * @param {object} [options] - resolution inputs.
 * @param {Record<string, string|undefined>} [options.env] - environment (injectable for tests).
 * @param {object} [options.plugin] - the `aliyun` section of the plugin config.
 * @param {string} [options.akFile] - explicit credential-file path (overrides the config).
 * @param {string} [options.homeDir] - home directory override.
 * @returns {{configured: boolean, accessKeyId: string, accessKeySecret: string, securityToken: string, endpoint: string, endpointSource: string, source: 'env'|'file'|'config'|'none', file: string, error: string|null}} the resolved credential.
 */
export function resolveAk({ env = process.env, plugin = {}, akFile = '', homeDir = '', } = {}) {
  const useFile = plugin.useAkFile !== false
  const file = useFile
    ? (akFile || plugin.akFile || path.join(homeDir || os.homedir(), '.dsh', 'qwen-coupon.json'))
    : ''

  const envId = firstNonEmpty(env.ALIYUN_AK_ID, env.ALIBABA_CLOUD_ACCESS_KEY_ID, env.ALIYUN_ACCESS_KEY_ID)
  const envSecret = firstNonEmpty(env.ALIYUN_AK_SECRET, env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, env.ALIYUN_ACCESS_KEY_SECRET)
  const envToken = firstNonEmpty(env.ALIYUN_STS_TOKEN, env.ALIBABA_CLOUD_SECURITY_TOKEN)
  const envEndpoint = firstNonEmpty(env.ALIYUN_BSS_ENDPOINT)
  const envComplete = Boolean(envId && envSecret)

  let fileFields = { id: '', secret: '', token: '', endpoint: '', error: null }
  if (!envComplete && file) fileFields = readAkFile(file)

  const cfgId = firstNonEmpty(plugin.akId)
  const cfgSecret = firstNonEmpty(plugin.akSecret)
  const cfgEndpoint = firstNonEmpty(plugin.endpoint)

  // Whole-source selection: the first source holding BOTH halves wins.
  //
  // Mixing an id from one source with a secret from another is deliberately not
  // done — the resulting pair cannot exist on Alibaba Cloud and would surface
  // as a confusing `InvalidAccessKeyId.NotFound` instead of "not configured".
  // A half-filled source is therefore skipped, not completed.
  const candidates = [
    { source: 'env', id: envId, secret: envSecret, token: envToken },
    { source: 'file', id: fileFields.id, secret: fileFields.secret, token: fileFields.token },
    { source: 'config', id: cfgId, secret: cfgSecret, token: '' },
  ]
  const chosen = candidates.find((candidate) => candidate.id && candidate.secret) ?? null

  const source = chosen?.source ?? 'none'
  const accessKeyId = chosen?.id ?? (envId || fileFields.id || cfgId)
  const accessKeySecret = chosen?.secret ?? ''
  const securityToken = chosen?.token ?? ''

  let endpoint = ''
  let endpointSource = ''
  if (envEndpoint) [endpoint, endpointSource] = [envEndpoint, 'env']
  else if (fileFields.endpoint) [endpoint, endpointSource] = [fileFields.endpoint, 'file']
  else if (cfgEndpoint) [endpoint, endpointSource] = [cfgEndpoint, 'config']

  return {
    configured: chosen !== null,
    accessKeyId,
    accessKeySecret,
    securityToken,
    endpoint,
    endpointSource,
    source,
    file,
    error: fileFields.error ?? null,
  }
}