/**
 * host-ak.test.mjs — AccessKey resolution priority and the masking rule.
 *
 * These are the two places where a mistake leaks a credential, so both are
 * pinned by their own tests: the SPEC.md §3.3 mask arithmetic, and the
 * SPEC.md §3.4 priority chain (environment > AK file > plugin config).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_BSS_ENDPOINT, maskKey, readAkFile, redactSecrets, resolveAk } from '../lib/core/ak.js'

/** Create a throwaway home directory containing an AK file. */
function withAkFile(t, contents, name = 'qwen-coupon.json') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qb-ak-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = path.join(home, '.dsh', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (contents !== null) fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return { home, file }
}

const ENV_ID = 'LTAI5tEnvIdExampleValue'
const ENV_SECRET = 'envSecretValue0123456789abcdef'

/* ------------------------------------------------------------------ masking */

test('ak: maskKey implements the exact SPEC.md §3.3 rule', () => {
  // <= 12 characters: first 2 + ***
  assert.equal(maskKey('ab'), 'ab***')
  assert.equal(maskKey('abcdefghijkl'), 'ab***', '12 characters is still the short branch')
  assert.equal(maskKey('a'), 'a***')
  // > 12 characters: first 6 + ... + last 4
  assert.equal(maskKey('abcdefghijklm'), 'abcdef...jklm', '13 characters uses the long branch')
  assert.equal(maskKey('LTAI5tAbCdEfGhIjKlEDaN'), 'LTAI5t...EDaN')
  assert.equal(maskKey(''), '')
  assert.equal(maskKey(undefined), '')
  assert.equal(maskKey(null), '')
})

test('ak: redactSecrets replaces a secret anywhere in a string, array or object', () => {
  const secret = 'super-secret-value-1234'
  const masked = maskKey(secret)
  const input = {
    message: `failed with ${secret}`,
    nested: { list: [`token=${secret}`, 'untouched'] },
    short: 'ab',
  }
  const output = redactSecrets(input, [secret])
  assert.equal(output.message, `failed with ${masked}`)
  assert.equal(output.nested.list[0], `token=${masked}`)
  assert.equal(output.nested.list[1], 'untouched')
  // A very short "secret" is ignored rather than mangling every occurrence.
  assert.equal(redactSecrets('ab ab ab', ['ab']), 'ab ab ab')
  // Non-string input passes straight through.
  assert.equal(redactSecrets(42, [secret]), 42)
})

/* ----------------------------------------------------------------- priority */

test('ak: environment variables win over the AK file and the plugin config', (t) => {
  const { home, file } = withAkFile(t, { aliyunAkId: 'file-id', aliyunAkSecret: 'file-secret-value' })
  const resolved = resolveAk({
    env: { ALIYUN_AK_ID: ENV_ID, ALIYUN_AK_SECRET: ENV_SECRET },
    plugin: { akId: 'config-id', akSecret: 'config-secret-value' },
    homeDir: home,
  })
  assert.equal(resolved.configured, true)
  assert.equal(resolved.source, 'env')
  assert.equal(resolved.accessKeyId, ENV_ID)
  assert.equal(resolved.accessKeySecret, ENV_SECRET)
  assert.equal(resolved.file, file)
})

test('ak: the AK file wins over the plugin config', (t) => {
  const { home, file } = withAkFile(t, {
    aliyunAkId: 'file-id',
    aliyunAkSecret: 'file-secret-value',
    aliyunStsToken: 'file-sts-token',
    bssEndpoint: 'business.ap-southeast-1.aliyuncs.com',
  })
  const resolved = resolveAk({
    env: {},
    plugin: { akId: 'config-id', akSecret: 'config-secret-value', endpoint: 'config.example.com' },
    homeDir: home,
  })
  assert.equal(resolved.configured, true)
  assert.equal(resolved.source, 'file')
  assert.equal(resolved.accessKeyId, 'file-id')
  assert.equal(resolved.accessKeySecret, 'file-secret-value')
  assert.equal(resolved.securityToken, 'file-sts-token')
  assert.equal(resolved.endpoint, 'business.ap-southeast-1.aliyuncs.com')
  assert.equal(resolved.endpointSource, 'file')
  assert.equal(resolved.file, file)
})

test('ak: the plugin config is the last resort and reports itself as such', () => {
  const resolved = resolveAk({
    env: {},
    plugin: { akId: 'config-id', akSecret: 'config-secret-value', useAkFile: false },
    homeDir: path.join(os.tmpdir(), 'dsh-qb-does-not-exist'),
  })
  assert.equal(resolved.configured, true)
  assert.equal(resolved.source, 'config')
  assert.equal(resolved.accessKeyId, 'config-id')
})

test('ak: ALIBABA_CLOUD_* names are accepted as environment aliases', () => {
  const resolved = resolveAk({
    env: { ALIBABA_CLOUD_ACCESS_KEY_ID: ENV_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET: ENV_SECRET },
    plugin: {},
    homeDir: path.join(os.tmpdir(), 'dsh-qb-does-not-exist'),
  })
  assert.equal(resolved.configured, true)
  assert.equal(resolved.source, 'env')
  assert.equal(resolved.accessKeyId, ENV_ID)
  assert.equal(resolved.accessKeySecret, ENV_SECRET)
})

test('ak: a half-filled source is skipped, never mixed with another source', (t) => {
  // An id-only environment plus a complete file must NOT be combined into a
  // pair that cannot exist on Alibaba Cloud.
  const { home } = withAkFile(t, { aliyunAkId: 'file-id', aliyunAkSecret: 'file-secret-value' })
  const resolved = resolveAk({ env: { ALIYUN_AK_ID: 'env-id-only' }, plugin: {}, homeDir: home })
  assert.equal(resolved.source, 'file')
  assert.equal(resolved.accessKeyId, 'file-id')
  assert.equal(resolved.accessKeySecret, 'file-secret-value')

  // With nothing complete anywhere, the source is simply not configured and no
  // secret is handed back at all.
  const none = resolveAk({ env: { ALIYUN_AK_ID: 'env-id-only' }, plugin: {}, homeDir: path.join(os.tmpdir(), 'dsh-qb-nope') })
  assert.equal(none.configured, false)
  assert.equal(none.source, 'none')
  assert.equal(none.accessKeySecret, '')
})

test('ak: ALIYUN_BSS_ENDPOINT beats the file and the config', (t) => {
  const { home } = withAkFile(t, { aliyunAkId: 'file-id', aliyunAkSecret: 'file-secret-value', bssEndpoint: 'from-file.example.com' })
  const resolved = resolveAk({
    env: { ALIYUN_AK_ID: ENV_ID, ALIYUN_AK_SECRET: ENV_SECRET, ALIYUN_BSS_ENDPOINT: 'from-env.example.com' },
    plugin: { endpoint: 'from-config.example.com' },
    homeDir: home,
  })
  assert.equal(resolved.endpoint, 'from-env.example.com')
  assert.equal(resolved.endpointSource, 'env')
})

/* --------------------------------------------------------------- file handling */

test('ak: a missing file is the normal not-configured state, with no error', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qb-ak-missing-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const resolved = resolveAk({ env: {}, plugin: {}, homeDir: home })
  assert.equal(resolved.configured, false)
  assert.equal(resolved.error, null, 'ENOENT must stay silent')
  assert.equal(readAkFile(path.join(home, '.dsh', 'qwen-coupon.json')).error, null)
})

test('ak: a broken file is reported as a short error, never a throw', (t) => {
  const { home } = withAkFile(t, '{ not json at all')
  const resolved = resolveAk({ env: {}, plugin: {}, homeDir: home })
  assert.equal(resolved.configured, false)
  assert.match(resolved.error, /失败|Failed/)
  assert.doesNotMatch(resolved.error, /\{ not json/, 'the file contents must not be echoed back')
})

test('ak: an unreadable path (a directory) is reported as an error', (t) => {
  const { home } = withAkFile(t, null)
  fs.mkdirSync(path.join(home, '.dsh', 'qwen-coupon.json'), { recursive: true })
  const resolved = resolveAk({ env: {}, plugin: {}, homeDir: home })
  assert.equal(resolved.configured, false)
  assert.ok(resolved.error)
})

test('ak: the documented file keys and their compatibility spellings both load', (t) => {
  const documented = withAkFile(t, { aliyunAkId: 'id-a', aliyunAkSecret: 'secret-a-value', aliyunStsToken: 'sts-a', bssEndpoint: 'ep-a' })
  const fields = readAkFile(documented.file)
  assert.deepEqual([fields.id, fields.secret, fields.token, fields.endpoint], ['id-a', 'secret-a-value', 'sts-a', 'ep-a'])
  assert.equal(fields.error, null)

  const alternate = withAkFile(t, { accessKeyId: 'id-b', accessKeySecret: 'secret-b-value', securityToken: 'sts-b', endpoint: 'ep-b' })
  const other = readAkFile(alternate.file)
  assert.deepEqual([other.id, other.secret, other.token, other.endpoint], ['id-b', 'secret-b-value', 'sts-b', 'ep-b'])

  // A nested `aliyun` object is accepted too.
  const nested = withAkFile(t, { aliyun: { aliyunAkId: 'id-c', aliyunAkSecret: 'secret-c-value' } })
  assert.equal(readAkFile(nested.file).id, 'id-c')
})

test('ak: useAkFile=false suppresses the default file entirely', (t) => {
  const { home } = withAkFile(t, { aliyunAkId: 'file-id', aliyunAkSecret: 'file-secret-value' })
  const resolved = resolveAk({ env: {}, plugin: { useAkFile: false }, homeDir: home })
  assert.equal(resolved.configured, false)
  assert.equal(resolved.file, '', 'no file was even consulted')
  assert.equal(resolved.accessKeyId, '')
})

test('ak: an explicit akFile path overrides the configured one', (t) => {
  const { home, file } = withAkFile(t, { aliyunAkId: 'explicit-id', aliyunAkSecret: 'explicit-secret-value' })
  const resolved = resolveAk({ env: {}, plugin: {}, akFile: file, homeDir: path.join(os.tmpdir(), 'dsh-qb-unused') })
  assert.equal(resolved.configured, true)
  assert.equal(resolved.source, 'file')
  assert.equal(resolved.accessKeyId, 'explicit-id')
  assert.equal(resolved.file, file)
})

test('ak: the resolved secret never appears in the returned error field', (t) => {
  const { home } = withAkFile(t, `{"aliyunAkId":"id","aliyunAkSecret":"${ENV_SECRET}"`)
  const resolved = resolveAk({ env: {}, plugin: {}, homeDir: home })
  assert.ok(resolved.error)
  assert.equal(resolved.error.includes(ENV_SECRET), false)
})

test('ak: the exported default endpoint is the mainland BSS site', () => {
  assert.equal(DEFAULT_BSS_ENDPOINT, 'business.aliyuncs.com')
})