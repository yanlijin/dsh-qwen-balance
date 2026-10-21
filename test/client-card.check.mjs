/**
 * client-*.check.mjs · lib/client.js 的最小 DOM stub 自测
 *
 * 用法：node test/client-card.check.mjs   （node v24 直接可跑，零依赖）
 *
 * 覆盖：包装可执行 / 导出 inject+apply / apply 不抛 / 卡片落在「设置」行上方 /
 * 同源相对路径取数 / 30s 轮询（hidden 暂停、可见补一次）/ 点击展开 rows + POST refresh /
 * tone 上色 / notes / 错误时保留上次数据 / 栏轨收起隐藏 / React 重渲染与整面板重建后自愈 /
 * 无座位静默 / DOM 坏掉只 warn 不抛 / 不渲染 sources（掩码）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, '..', 'lib', 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

/** SPEC §3.3 冻结样例（原样抄自 docs/PLUGIN-SPEC.md）。 */
const SAMPLE = {
  ok: true,
  enabled: true,
  checkedAt: '2026-10-21T04:00:00.000Z',
  lang: 'zh',
  summary: { key: 'summary', label: '阿里云', value: '¥263.66', sub: '代金券可用', tone: 'good' },
  rows: [
    { key: 'coupon.total', label: '代金券可用', value: '¥263.66', tone: 'good', group: 'coupon' },
    { key: 'coupon.item', label: '券 923898490070', value: '¥263.66 · 2027-10-20 到期', tone: 'normal', group: 'coupon' },
    { key: 'aliyun.cash', label: '现金余额', value: '¥0.01', tone: 'muted', group: 'aliyun' },
    { key: 'gw.remaining', label: '中转站 剩余', value: '$7.66', tone: 'normal', group: 'gateway' },
  ],
  notes: ['未配置阿里云 AccessKey（可在插件配置里填，或设置环境变量）'],
  sources: {
    aliyun: { state: 'ok', error: null, availableAmount: 0.01, cashAmount: 0.01, creditAmount: 0, currency: 'CNY' },
    coupons: {
      state: 'ok',
      error: null,
      availableBalance: 263.66,
      availableCount: 1,
      totalCount: 1,
      nominalTotal: 300,
      nearestExpiry: '2027-10-20T00:00:00Z',
      akIdMasked: 'LTAI5t...EDaN',
      items: [
        {
          no: '923898490070',
          balance: 263.66,
          nominal: 300,
          status: 'Available',
          expiry: '2027-10-20T00:00:00Z',
          scenarios: '...',
        },
      ],
    },
    gateways: [
      {
        id: 'gw1',
        name: '中转站',
        kind: 'newapi',
        state: 'ok',
        error: null,
        currency: 'USD',
        total: 20,
        used: 12.34,
        remaining: 7.66,
        balance: null,
      },
    ],
  },
  error: null,
}

// ============================================================ 最小 DOM stub
const kebab = (name) => String(name).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
const camel = (name) => String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase())

class Style {
  setProperty(name, value) {
    this[camel(name)] = String(value)
  }
  getPropertyValue(name) {
    const value = this[camel(name)]
    return value === undefined ? '' : value
  }
  removeProperty(name) {
    const key = camel(name)
    const value = this[key]
    delete this[key]
    return value === undefined ? '' : value
  }
  get cssText() {
    return Object.keys(this)
      .filter((key) => typeof this[key] === 'string')
      .map((key) => kebab(key) + ':' + this[key])
      .join(';')
  }
}

class TextNode {
  constructor(text) {
    this.nodeType = 3
    this._text = String(text)
    this.parentNode = null
  }
  get textContent() {
    return this._text
  }
  set textContent(value) {
    this._text = String(value)
  }
}

const COMPOUND = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([*^$]?=)\s*"?([^"\]]*)"?\s*)?\]/g

function matchesCompound(el, compound) {
  COMPOUND.lastIndex = 0
  let match
  let seen = false
  while ((match = COMPOUND.exec(compound)) !== null) {
    seen = true
    if (match[1] !== undefined) {
      if (el._tag !== match[1].toLowerCase()) return false
    } else if (match[2] !== undefined) {
      const classNames = String(el.getAttribute('class') || '').split(/\s+/)
      if (classNames.indexOf(match[2]) < 0) return false
    } else if (match[3] !== undefined) {
      if (el.getAttribute('id') !== match[3]) return false
    } else if (match[4] !== undefined) {
      const actual = el.getAttribute(match[4].toLowerCase())
      if (actual === null) return false
      const op = match[5]
      const expected = match[6] === undefined ? '' : match[6]
      if (op === undefined) continue
      if (op === '=' && actual !== expected) return false
      if (op === '*=' && !actual.includes(expected)) return false
      if (op === '^=' && !actual.startsWith(expected)) return false
      if (op === '$=' && !actual.endsWith(expected)) return false
    }
  }
  return seen
}

function matchesChain(el, chain) {
  if (chain.length === 0) return false
  if (!matchesCompound(el, chain[chain.length - 1])) return false
  let index = chain.length - 2
  let node = el.parentNode
  while (index >= 0) {
    let found = false
    while (node !== null && node.nodeType === 1) {
      if (matchesCompound(node, chain[index])) {
        found = true
        node = node.parentNode
        break
      }
      node = node.parentNode
    }
    if (!found) return false
    index -= 1
  }
  return true
}

function matches(el, selector) {
  if (el.nodeType !== 1 || !selector) return false
  return String(selector)
    .split(',')
    .some((part) => matchesChain(el, part.trim().split(/\s+/).filter(Boolean)))
}

function queryAll(root, selector, includeRoot) {
  const out = []
  const visit = (node, isRoot) => {
    if (node.nodeType === 1) {
      if ((includeRoot || !isRoot) && matches(node, selector)) out.push(node)
      for (const child of node.childNodes) visit(child, false)
    }
  }
  visit(root, true)
  return out
}

function addListenerApi(target) {
  target._listeners = new Map()
  target.addEventListener = function (type, fn) {
    let set = this._listeners.get(type)
    if (!set) {
      set = new Set()
      this._listeners.set(type, set)
    }
    set.add(fn)
  }
  target.removeEventListener = function (type, fn) {
    const set = this._listeners.get(type)
    if (set) set.delete(fn)
  }
  target.dispatchEvent = function (event) {
    const ev = event || {}
    ev.target = ev.target || this
    ev.currentTarget = this
    if (typeof ev.preventDefault !== 'function') ev.preventDefault = () => {}
    if (typeof ev.stopPropagation !== 'function') ev.stopPropagation = () => {}
    const set = this._listeners.get(ev.type)
    if (set) for (const fn of [...set]) fn.call(this, ev)
    return true
  }
  return target
}

class Element {
  constructor(tag, doc) {
    this.nodeType = 1
    this.tagName = String(tag).toUpperCase()
    this._tag = String(tag).toLowerCase()
    this.ownerDocument = doc
    this.childNodes = []
    this.parentNode = null
    this.attributes = new Map()
    this.style = new Style()
    this._measuredWidth = 0
    addListenerApi(this)
  }
  get nodeName() {
    return this.tagName
  }
  get className() {
    return this.getAttribute('class') || ''
  }
  set className(value) {
    this.setAttribute('class', value === null || value === undefined ? '' : String(value))
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1)
  }
  get firstChild() {
    return this.childNodes[0] || null
  }
  get firstElementChild() {
    return this.children[0] || null
  }
  get lastElementChild() {
    const kids = this.children
    return kids[kids.length - 1] || null
  }
  get nextElementSibling() {
    const parent = this.parentNode
    if (!parent) return null
    const kids = parent.children
    const index = kids.indexOf(this)
    return index < 0 ? null : kids[index + 1] || null
  }
  get previousElementSibling() {
    const parent = this.parentNode
    if (!parent) return null
    const kids = parent.children
    const index = kids.indexOf(this)
    return index <= 0 ? null : kids[index - 1] || null
  }
  get isConnected() {
    let node = this
    while (node.parentNode) node = node.parentNode
    return node === this.ownerDocument.documentElement || node === this.ownerDocument.body
  }
  get textContent() {
    if (this.childNodes.length === 0) return ''
    return this.childNodes.map((node) => node.textContent).join('')
  }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value !== null && value !== undefined && String(value) !== '') {
      const textNode = new TextNode(value)
      textNode.parentNode = this
      this.childNodes.push(textNode)
    }
  }
  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value))
  }
  getAttribute(name) {
    const key = String(name).toLowerCase()
    return this.attributes.has(key) ? this.attributes.get(key) : null
  }
  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase())
  }
  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase())
  }
  appendChild(node) {
    if (!node) return node
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  insertBefore(node, reference) {
    if (reference === null || reference === undefined) return this.appendChild(node)
    const index = this.childNodes.indexOf(reference)
    if (index < 0) throw new Error('insertBefore: reference node is not a child')
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.splice(index, 0, node)
    return node
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index < 0) throw new Error('removeChild: node is not a child')
    this.childNodes.splice(index, 1)
    node.parentNode = null
    return node
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  contains(node) {
    for (let cursor = node; cursor; cursor = cursor.parentNode) if (cursor === this) return true
    return false
  }
  querySelector(selector) {
    return queryAll(this, selector, false)[0] || null
  }
  querySelectorAll(selector) {
    return queryAll(this, selector, false)
  }
  closest(selector) {
    for (let node = this; node && node.nodeType === 1; node = node.parentNode) {
      if (matches(node, selector)) return node
    }
    return null
  }
  click() {
    return this.dispatchEvent({ type: 'click' })
  }
  getBoundingClientRect() {
    return { width: this._measuredWidth, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
  }
  get offsetWidth() {
    return this._measuredWidth
  }
}

/**
 * 可控时钟：lib/client.js 只用 Date.now()（自报节流）与 new Date(iso)（更新时间），
 * 所以替换掉 vm 里的 Date 就能确定性地验证 5s 节流。
 */
let virtualDateNow = Date.parse('2026-10-21T04:00:00.000Z')
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(virtualDateNow)
    else super(...args)
  }
  static now() {
    return virtualDateNow
  }
}

function createEnv(options = {}) {
  const doc = { nodeType: 9 }
  const observers = new Set()
  const pendingMutations = []
  const frames = new Map()
  const timers = new Map()
  const warns = []
  const calls = []
  let nextId = 1
  let virtualNow = 0
  let fetchHandler = async () => ({ ok: true, status: 200, json: async () => doc._payload })

  const documentElement = new Element('html', doc)
  const body = new Element('body', doc)
  documentElement.appendChild(body)

  doc.documentElement = documentElement
  doc.body = body
  doc.hidden = !!options.hidden
  doc.visibilityState = options.hidden ? 'hidden' : 'visible'
  doc._payload = options.payload === undefined ? SAMPLE : options.payload
  doc.createElement = (tag) => new Element(tag, doc)
  doc.createTextNode = (value) => new TextNode(value)
  doc.querySelector = (selector) => queryAll(documentElement, selector, true)[0] || null
  doc.querySelectorAll = (selector) => queryAll(documentElement, selector, true)
  addListenerApi(doc)

  const setTimer = (fn, ms, repeat) => {
    const id = nextId++
    const delay = Math.max(0, Number(ms) || 0)
    timers.set(id, { fn, at: virtualNow + (repeat ? Math.max(1, delay || 1) : delay), repeat: repeat ? Math.max(1, delay || 1) : 0 })
    return id
  }

  const context = {
    document: doc,
    Date: FakeDate,
    navigator: { language: options.language === undefined ? 'zh-CN' : options.language },
    console: {
      warn: (...args) => warns.push(args.map((value) => String(value)).join(' ')),
      log: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
    setTimeout: (fn, ms) => setTimer(fn, ms, false),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => setTimer(fn, ms, true),
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => {
      const id = nextId++
      frames.set(id, fn)
      return id
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: async (url, init) => {
      calls.push({ url, init })
      return fetchHandler(url, init)
    },
    MutationObserver: class {
      constructor(callback) {
        this._callback = callback || (() => {})
        this._active = false
        observers.add(this)
      }
      observe() {
        this._active = true
      }
      disconnect() {
        this._active = false
        observers.delete(this)
      }
      takeRecords() {
        return []
      }
    },
  }

  const registered = []
  const windowStub = {
    setTimeout: context.setTimeout,
    clearTimeout: context.clearTimeout,
    setInterval: context.setInterval,
    clearInterval: context.clearInterval,
    requestAnimationFrame: context.requestAnimationFrame,
    cancelAnimationFrame: context.cancelAnimationFrame,
    document: doc,
    navigator: context.navigator,
    __ModuleLoader__: { load: (definition) => registered.push(definition) },
  }
  addListenerApi(windowStub)
  windowStub.window = windowStub
  context.window = windowStub
  context.globalThis = context
  vm.createContext(context)

  let exportsRef = null
  const env = {
    document: doc,
    window: windowStub,
    calls,
    warns,
    registered,
    get payload() {
      return doc._payload
    },
    setPayload(value) {
      doc._payload = value
    },
    setFetch(handler) {
      fetchHandler = handler
    },
    setHidden(value) {
      doc.hidden = !!value
      doc.visibilityState = value ? 'hidden' : 'visible'
      if (!value) doc.dispatchEvent({ type: 'visibilitychange' })
      else doc.dispatchEvent({ type: 'visibilitychange' })
    },
    flushMutations() {
      const records = pendingMutations.splice(0, pendingMutations.length)
      for (const observer of [...observers]) {
        if (!observer._active) continue
        observer._callback(records)
      }
    },
    mutate(fn) {
      fn()
      env.flushMutations()
    },
    flushFrames() {
      for (let guard = 0; guard < 8 && frames.size > 0; guard += 1) {
        const batch = [...frames.entries()]
        frames.clear()
        for (const [, fn] of batch) fn()
      }
    },
    advance(ms) {
      const target = virtualNow + ms
      // 自报节流用的是 Date.now()，让可控时钟跟着一起走。
      virtualDateNow += ms
      for (;;) {
        let next = null
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === null || timer.at < next.timer.at)) next = { id, timer }
        }
        if (next === null) break
        virtualNow = next.timer.at
        if (next.timer.repeat) next.timer.at = virtualNow + next.timer.repeat
        else timers.delete(next.id)
        next.timer.fn()
      }
      virtualNow = target
    },
    async settle(rounds = 8) {
      for (let index = 0; index < rounds; index += 1) {
        await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
      }
      env.flushFrames()
    },
    loadClient() {
      if (exportsRef !== null) return exportsRef
      vm.runInContext(SOURCE, context, { filename: 'lib/client.js' })
      assert.equal(registered.length, 1, 'window.__ModuleLoader__.load 应被调用一次')
      const definition = registered[0]
      assert.equal(definition.id, 'dsh-qwen-balance')
      assert.equal(typeof definition.factory, 'function')
      exportsRef = definition.factory((name) => {
        throw new Error('unexpected require: ' + name)
      })
      return exportsRef
    },
  }

  // 自动记录 DOM 变更，供 flushMutations 投递。
  const originalAppend = Element.prototype.appendChild
  Element.prototype.appendChild = function (node) {
    const result = originalAppend.call(this, node)
    pendingMutations.push({ type: 'childList', target: this })
    return result
  }
  const originalInsertBefore = Element.prototype.insertBefore
  Element.prototype.insertBefore = function (node, reference) {
    const result = originalInsertBefore.call(this, node, reference)
    pendingMutations.push({ type: 'childList', target: this })
    return result
  }
  const originalRemoveChild = Element.prototype.removeChild
  Element.prototype.removeChild = function (node) {
    const result = originalRemoveChild.call(this, node)
    pendingMutations.push({ type: 'childList', target: this })
    return result
  }

  return env
}

/** 在（已有的）侧栏列里挂出 root > footArea > settingsArea 结构，返回各座位引用。 */
function mountSidebarTree(doc, sidebarCol, options = {}) {
  sidebarCol.textContent = ''
  const root = doc.createElement('div')
  root.setAttribute('class', options.collapsedClass ? '_2H3hWW_root _2H3hWW_collapsed' : '_2H3hWW_root')
  const footArea = doc.createElement('div')
  footArea.setAttribute('class', '_2H3hWW_footArea')
  const settingsArea = doc.createElement('div')
  settingsArea.setAttribute('class', '_2H3hWW_settingsArea')
  const settingsButton = doc.createElement('button')
  settingsButton.textContent = '设置'
  settingsArea.appendChild(settingsButton)
  footArea.appendChild(settingsArea)
  root.appendChild(footArea)
  sidebarCol.appendChild(root)
  return { root, footArea, settingsArea }
}

/** 搭出与真实外壳同构的侧栏（类名取自 DSH web 的 CSS module 产物）。 */
function buildSidebar(doc, options = {}) {
  const frame = doc.createElement('div')
  frame.setAttribute('class', 'BynINW_frame')
  if (options.collapsedAttribute) frame.setAttribute('data-sidebar-collapsed', 'true')
  const sidebarCol = doc.createElement('div')
  sidebarCol.setAttribute('class', 'BynINW_sidebarCol')
  sidebarCol._measuredWidth = options.collapsedWidth ? 56 : 280
  frame.appendChild(sidebarCol)
  doc.body.appendChild(frame)
  const tree = mountSidebarTree(doc, sidebarCol, options)
  return { frame, sidebarCol, ...tree }
}

/** 按路径筛请求：v0.1.1 之后 env.calls 里还混着 client-report 的 POST。 */
const callsTo = (env, path) => env.calls.filter((call) => String(call.url).indexOf(path) === 0)
const overviewCalls = (env) => callsTo(env, 'api/dsh-qwen-balance/overview')
const refreshCalls = (env) => callsTo(env, 'api/dsh-qwen-balance/refresh')
const reportCalls = (env) => callsTo(env, 'api/dsh-qwen-balance/client-report')
const parseReport = (call) => JSON.parse(call.init.body)
const lastReport = (env) => {
  const calls = reportCalls(env)
  if (calls.length === 0) return null
  return { call: calls[calls.length - 1], body: parseReport(calls[calls.length - 1]) }
}

// ============================================================ 断言运行器
let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok   - ' + name)
  } catch (err) {
    failed += 1
    const message = String((err && err.message) || err).slice(0, 400).replace(/\n/g, '\n       ')
    const frames = String((err && err.stack) || '')
      .split('\n')
      .filter((line) => line.includes('client-card.check.mjs'))
      .slice(0, 3)
    console.error('FAIL - ' + name)
    console.error('       ' + message)
    for (const frame of frames) console.error('     ' + frame.trim())
  }
}

// ============================================================ 用例
console.log('# lib/client.js 检查 (node ' + process.version + ')')
console.log('# source: ' + CLIENT_PATH)

await check('包装形态：__ModuleLoader__.load + id + factory + Module 标记', () => {
  const withoutComment = SOURCE.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')
  assert.ok(
    withoutComment.startsWith('window.__ModuleLoader__.load({'),
    '首个语句必须是 window.__ModuleLoader__.load({...})',
  )
  assert.ok(SOURCE.includes("id: 'dsh-qwen-balance'"))
  assert.ok(SOURCE.includes('factory: (require) => {'))
  assert.ok(SOURCE.includes("Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })"))
  assert.ok(SOURCE.includes('return module.exports'))
  assert.ok(!/\binnerHTML\b/.test(SOURCE), '不得使用 innerHTML')
  assert.ok(!/require\(['"]react/.test(SOURCE), '不得引入 React')
  assert.ok(!/\bdocument\.write\b/.test(SOURCE), '不得使用 document.write')
})

await check('apply 不抛、导出 inject/apply、卡片插在「设置」行上方', () => {
  const env = createEnv()
  const seat = buildSidebar(env.document)
  const mod = env.loadClient()
  assert.ok(Array.isArray(mod.inject), 'inject 应为数组')
  assert.equal(typeof mod.apply, 'function')
  let disposer = null
  assert.doesNotThrow(() => {
    disposer = mod.apply({})
  })
  assert.equal(typeof disposer, 'function', 'apply 必须返回 disposer')

  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card, '卡片容器应已插入')
  assert.ok(seat.footArea.children[0] === card, '卡片应是 footArea 的第一个子节点')
  assert.ok(card.nextElementSibling === seat.settingsArea, '卡片必须紧邻「设置」行上方')
})

await check('取数用同源相对路径，渲染出 summary.value/sub', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()

  assert.equal(overviewCalls(env).length, 1, '首次应恰好取一次 overview')
  assert.equal(overviewCalls(env)[0].url, 'api/dsh-qwen-balance/overview?lang=zh')
  assert.equal(overviewCalls(env)[0].init.method, 'GET')
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card.textContent.includes('¥263.66'), '卡片文本应含 summary.value：' + card.textContent)
  assert.ok(card.textContent.includes('代金券可用'), '卡片文本应含 summary.sub')
  assert.ok(card.textContent.includes('阿里云'), '卡片文本应含 summary.label')
  assert.equal(card.getAttribute('data-dsh-qwen-balance-state'), 'ready')
  assert.equal(env.warns.length, 0, '正常路径不应有 warn：' + env.warns.join('|'))
})

await check('v0.1.1 默认展开：首次渲染明细行直接可见（无需点击）', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  const details = card.querySelector('[data-dsh-qwen-balance-details]')
  assert.equal(details.style.display, 'block', '首次渲染就应展开（不再需要点击）')
  const rows = card.querySelectorAll('[data-dsh-qwen-balance-row]')
  assert.equal(rows.length, SAMPLE.rows.length, 'rows 应全部渲染')
  for (const row of rows) {
    assert.ok(details.contains(row), 'rows 必须在展开区内')
    assert.equal(row.style.display, 'flex')
  }
  assert.ok(details.contains(card.querySelector('[data-dsh-qwen-balance-notes]')), 'notes 也在展开区内')
  assert.ok(card.textContent.includes('券 923898490070'), 'rows 文本无需点击就已出现')
  assert.ok(card.textContent.includes('未配置阿里云 AccessKey'), 'notes 文本无需点击就已出现')
  assert.equal(card.querySelector('[data-dsh-qwen-balance-error]').style.display, 'none')
  assert.equal(refreshCalls(env).length, 0, '默认展开不应额外触发 refresh')
})

await check('v0.1.1 紧凑样式：弱化小标题 + 大数字 + 弱化明细 + 右上角箭头', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  const head = card.querySelector('[data-dsh-qwen-balance-head]')
  assert.ok(head, '头部应存在')
  const titleEl = head.children[0]
  const labelEl = head.children[1]
  const dotEl = head.children[2]
  const caretEl = head.children[3]
  assert.equal(titleEl.textContent, '千问余额', '小标题应是卡片名')
  assert.equal(titleEl.style.fontSize, '11px')
  assert.equal(titleEl.style.color, 'var(--dsw-alias-label-secondary, #8b949e)', '小标题应弱化')
  assert.equal(labelEl.textContent, '阿里云', '来源标签仍来自 payload.label')
  assert.equal(dotEl.style.display, 'inline-block', '有 tone 时应显示状态点')
  assert.equal(dotEl.getAttribute('data-tone'), 'good')
  assert.equal(caretEl.style.marginLeft, 'auto', '箭头应贴在右上角')
  assert.equal(caretEl.textContent, '▴', '展开态箭头朝上')

  const valueEl = card.children[1]
  const subEl = card.children[2]
  assert.equal(valueEl.textContent, '¥263.66')
  assert.equal(valueEl.style.fontSize, '19px', '数值应是大号字')
  assert.equal(valueEl.style.fontWeight, '600')
  assert.equal(subEl.textContent, '代金券可用', '限定语来自 payload.sub')
  assert.equal(subEl.style.fontSize, '11px')
  assert.equal(subEl.style.color, 'var(--dsw-alias-label-secondary, #8b949e)', '限定语应弱化')

  const row = card.querySelector('[data-dsh-qwen-balance-row="coupon.total"]')
  assert.equal(row.style.fontSize, '11px', '明细行应是弱化小字')
  assert.ok(
    card.querySelector('[data-dsh-qwen-balance-stamp]').textContent.includes('更新'),
    '更新时间应来自宿主 checkedAt',
  )
  assert.ok(!card.textContent.includes('undefined'), '不得把 undefined 渲染出来')
})

await check('v0.1.1 点击整卡 → 收起；再点 → 展开（并 POST refresh）', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  const details = card.querySelector('[data-dsh-qwen-balance-details]')
  const caret = card.querySelector('[data-dsh-qwen-balance-head]').children[3]

  card.click()
  await env.settle()
  assert.equal(details.style.display, 'none', '点击一次应收起')
  assert.equal(caret.textContent, '▾', '收起态箭头朝下')
  assert.equal(caret.getAttribute('aria-label'), '展开')
  const postCall = refreshCalls(env).find((call) => call.init && call.init.method === 'POST')
  assert.ok(postCall, '点击应触发 POST refresh')
  assert.equal(postCall.url, 'api/dsh-qwen-balance/refresh?lang=zh')

  card.click()
  await env.settle()
  assert.equal(details.style.display, 'block', '再点应重新展开')
  assert.equal(caret.textContent, '▴', '展开态箭头朝上')
  const rows = card.querySelectorAll('[data-dsh-qwen-balance-row]')
  assert.equal(rows.length, SAMPLE.rows.length, '应渲染全部 rows')
  assert.ok(card.textContent.includes('券 923898490070'), 'rows 文本应出现')
  assert.ok(card.textContent.includes('$7.66'), '网关剩余应出现')
  assert.ok(card.textContent.includes('现金余额'))
  assert.ok(card.textContent.includes('未配置阿里云 AccessKey'), 'notes 文本应出现')
  // SPEC §3.4：/refresh 只接受 POST，GET 会 405 —— 每次点击都必须 POST 刷新。
  const refreshPosts = refreshCalls(env).filter((call) => call.init.method === 'POST')
  assert.equal(refreshPosts.length, 2, '两次点击应各 POST 一次 refresh')
  assert.equal(
    refreshCalls(env).filter((call) => call.init.method !== 'POST').length,
    0,
    'refresh 端点绝不能走 GET（宿主只接受 POST，GET 会 405）',
  )
  assert.equal(
    overviewCalls(env).filter((call) => call.init.method !== 'GET').length,
    0,
    'overview 只能是 GET',
  )
  assert.equal(
    env.calls.filter((call) => call.init && call.init.method === 'POST' && String(call.url).indexOf('overview') === 0).length,
    0,
    'POST 不能打到 overview 上',
  )
})

await check('tone 映射：good/normal/muted 都落到 data-tone + 颜色', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  // v0.1.1 默认展开，rows 已在 DOM 里，不需要点击。
  const tones = new Set(card.querySelectorAll('[data-tone]').map((el) => el.getAttribute('data-tone')))
  assert.ok(tones.has('good'), '应出现 good tone')
  assert.ok(tones.has('normal'), '应出现 normal tone')
  assert.ok(tones.has('muted'), '应出现 muted tone')
  const couponRow = card.querySelector('[data-dsh-qwen-balance-row="coupon.total"]')
  assert.ok(couponRow, '按 key 找到券合计行')
  const amount = couponRow.children[couponRow.children.length - 1]
  assert.equal(amount.getAttribute('data-tone'), 'good')
  assert.equal(amount.textContent, '¥263.66')
  assert.ok(String(amount.style.color).length > 0, 'tone 应带颜色')
})

await check('语言：navigator.language=en-US → lang=en', async () => {
  const env = createEnv({ language: 'en-US' })
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  assert.equal(overviewCalls(env)[0].url, 'api/dsh-qwen-balance/overview?lang=en')
})

await check('30s 轮询：可见时轮询、document.hidden 暂停、可见后立刻补一次', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const initial = overviewCalls(env).length

  env.advance(29999)
  await env.settle()
  assert.equal(overviewCalls(env).length, initial, '未到 30s 不应取数')
  env.advance(1)
  await env.settle()
  assert.equal(overviewCalls(env).length, initial + 1, '满 30s 应轮询一次')

  env.setHidden(true)
  env.advance(30000)
  await env.settle()
  assert.equal(overviewCalls(env).length, initial + 1, 'hidden 时应暂停轮询')

  env.setHidden(false)
  await env.settle()
  assert.equal(overviewCalls(env).length, initial + 2, '可见时应立刻补一次')
  assert.equal(overviewCalls(env).every((call) => call.init.method === 'GET'), true, '轮询/补一次都应是 GET')
})

await check('栏轨收起（data-sidebar-collapsed）隐藏卡片，恢复后重新显示', async () => {
  const env = createEnv()
  const seat = buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.equal(card.style.display, 'block')

  env.mutate(() => seat.frame.setAttribute('data-sidebar-collapsed', 'true'))
  env.flushFrames()
  assert.equal(card.style.display, 'none', '收起成栏轨后应隐藏')
  assert.equal(card.getAttribute('data-rail'), 'collapsed')

  env.mutate(() => seat.frame.removeAttribute('data-sidebar-collapsed'))
  env.flushFrames()
  assert.equal(card.style.display, 'block', '展开后应恢复显示')
  assert.equal(card.getAttribute('data-rail'), null)
})

await check('栏轨兜底：类名 *_collapsed 与 56px 实测宽度也能隐藏', async () => {
  const env = createEnv()
  const seat = buildSidebar(env.document, { collapsedClass: true })
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.equal(card.style.display, 'none', '侧栏根带 *_collapsed 类时应隐藏')

  seat.root.setAttribute('class', '_2H3hWW_root')
  seat.sidebarCol._measuredWidth = 56
  env.mutate(() => {})
  env.flushFrames()
  assert.equal(card.style.display, 'none', '实测 56px 宽时应隐藏')

  seat.sidebarCol._measuredWidth = 280
  env.mutate(() => {})
  env.flushFrames()
  assert.equal(card.style.display, 'block', '宽度恢复后应显示')
})

await check('栏轨判定只看 footArea→列 这条链，面板内无关 collapsed 区块不误隐藏', async () => {
  const env = createEnv()
  const seat = buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.equal(card.style.display, 'block')

  // 面板里另一个无关的折叠区块（不在 footArea 链上）
  const stray = env.document.createElement('div')
  stray.setAttribute('class', 'somePanel collapsed')
  seat.sidebarCol.appendChild(stray)
  env.flushMutations()
  env.flushFrames()
  assert.equal(card.style.display, 'block', '无关区块不应把卡片隐藏')

  // 真正的侧栏根收起类（在 footArea 链上）仍然生效
  seat.root.setAttribute('class', '_2H3hWW_root _2H3hWW_collapsed')
  env.mutate(() => {})
  env.flushFrames()
  assert.equal(card.style.display, 'none', '链上的 _collapsed 应隐藏卡片')
})

await check('自愈：被 React 拆掉后重挂回「设置」行上方', async () => {
  const env = createEnv()
  const seat = buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')

  card.remove()
  env.flushMutations()
  env.flushFrames()
  assert.ok(card.parentNode === seat.footArea, '被拆掉后应重挂')
  assert.ok(card.nextElementSibling === seat.settingsArea, '重挂后仍紧邻「设置」行')

  // 被挪到末尾（React 重排）→ 回到设置行上方
  seat.footArea.appendChild(card)
  env.flushMutations()
  env.flushFrames()
  assert.ok(card.nextElementSibling === seat.settingsArea, '被挪走后应重新落座')
})

await check('自愈：整块侧栏面板重建后重挂；座位消失期间静默不动', async () => {
  const env = createEnv()
  const seat = buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card.isConnected, '初始应挂在侧栏里')

  // 整面板重建（React 卸载子树）：座位连同卡片一起消失。
  env.mutate(() => {
    seat.sidebarCol.textContent = ''
  })
  env.flushFrames()
  assert.ok(!card.isConnected, '无座位时应静默不动（不抛、不强行塞到别处）')
  assert.ok(env.warns.length === 0, '座位消失不应告警：' + env.warns.join('|'))

  // React 在同一个列容器里重建面板 → 卡片应自己回到「设置」行上方。
  const rebuilt = mountSidebarTree(env.document, seat.sidebarCol, {})
  env.flushMutations()
  env.flushFrames()
  const again = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(again === card, '应复用同一张卡片')
  assert.ok(again.parentNode === rebuilt.footArea, '座位回来后应重挂')
  assert.ok(again.nextElementSibling === rebuilt.settingsArea, '重挂后仍紧邻「设置」行')
  assert.ok(again.isConnected)
  assert.ok(env.warns.length === 0, '重建全程不应告警：' + env.warns.join('|'))
})

await check('没有侧栏座位：静默不挂载、不取数、不告警', async () => {
  const env = createEnv()
  const mod = env.loadClient()
  let disposer = null
  assert.doesNotThrow(() => {
    disposer = mod.apply({})
  })
  assert.equal(typeof disposer, 'function')
  assert.equal(env.document.querySelector('[data-dsh-qwen-balance-card]'), null, '无座位不应插入卡片')
  env.advance(120000)
  await env.settle()
  assert.equal(env.calls.length, 0, '无座位不应取数')
  assert.equal(env.warns.length, 0, '无座位应完全静默')
})

await check('DOM 坏掉：apply 只 console.warn，绝不抛（不白屏）', () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  env.document.createElement = () => {
    throw new Error('no dom here')
  }
  let disposer = null
  assert.doesNotThrow(() => {
    disposer = mod.apply({})
  })
  assert.equal(typeof disposer, 'function', '失败也必须返回可调用 disposer')
  assert.doesNotThrow(() => disposer())
  assert.ok(env.warns.length >= 1, '应至少 warn 一次')
  assert.ok(env.warns.join('|').includes('[dsh-qwen-balance]'))
  // 挂载失败必须尽力自报：state=error、seat 全 false、error 文本带出来。
  const failedReport = lastReport(env)
  assert.ok(failedReport !== null, 'apply 抛错也应尽力自报')
  assert.equal(failedReport.body.state, 'error')
  assert.equal(failedReport.body.seat.sidebar, false)
  assert.equal(failedReport.body.seat.foot, false)
  assert.equal(failedReport.body.seat.usedFallback, false)
  assert.equal(failedReport.body.rows, 0)
  assert.equal(failedReport.body.expanded, true)
  assert.ok(failedReport.body.error.includes('no dom here'), '错误文本应上报：' + failedReport.body.error)

  const env2 = createEnv()
  buildSidebar(env2.document)
  const mod2 = env2.loadClient()
  env2.document.querySelector = () => {
    throw new Error('querySelector exploded')
  }
  assert.doesNotThrow(() => {
    const d = mod2.apply({})
    const card = env2.document.querySelector // 依旧抛，但 apply 已返回
    void card
    d()
  })
  assert.ok(env2.warns.length >= 1)
})

await check('幂等：重复 apply 只留一张卡片', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  mod.apply({})
  await env.settle()
  assert.equal(env.document.querySelectorAll('[data-dsh-qwen-balance-card]').length, 1)
  const reports = reportCalls(env)
  assert.equal(reports.length, 1, '幂等路径不应重复自报')
  assert.equal(parseReport(reports[0]).state, 'mounted')
})

await check('请求失败：保留上次数据 + 追加一行错误', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card.textContent.includes('¥263.66'))

  env.setFetch(async () => {
    throw new Error('network down')
  })
  card.click()
  await env.settle()

  assert.ok(card.textContent.includes('¥263.66'), '错误时应保留上次数据')
  const errorLine = card.querySelector('[data-dsh-qwen-balance-error]')
  assert.equal(errorLine.style.display, 'block')
  assert.ok(errorLine.textContent.includes('刷新失败'), '错误行应出现：' + errorLine.textContent)
  assert.ok(errorLine.textContent.includes('network down'))
  assert.equal(card.getAttribute('data-dsh-qwen-balance-state'), 'error')
  assert.ok(env.warns.length >= 1, '错误路径应 console.warn')
})

await check('HTTP 500 / 非 JSON 也不抛，只记错误行', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')

  env.setFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  env.advance(30000)
  await env.settle()
  assert.ok(card.querySelector('[data-dsh-qwen-balance-error]').textContent.includes('500'))

  env.setFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON')
    },
  }))
  env.advance(30000)
  await env.settle()
  assert.ok(card.textContent.includes('¥263.66'), '数据仍在')
  assert.ok(card.querySelector('[data-dsh-qwen-balance-error]').textContent.includes('Unexpected token'))
})

await check('ok:false + rows:[] 时回显宿主 notes（不自己编财务文案）', async () => {
  const env = createEnv({
    payload: {
      ok: false,
      enabled: true,
      checkedAt: '2026-10-21T04:00:00.000Z',
      lang: 'zh',
      summary: null,
      rows: [],
      notes: ['未配置任何余额来源：请在插件配置里填写阿里云 AccessKey 或中转站地址'],
      sources: { aliyun: { state: 'off', error: null } },
      error: null,
    },
  })
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card.textContent.includes('未配置任何余额来源'), '应回显宿主 notes：' + card.textContent)
  assert.ok(card.textContent.includes('阿里云 AccessKey'))
})

await check('安全：不渲染 sources / 掩码以外的凭据信息', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  card.click()
  await env.settle()
  const allText = card.textContent
  assert.ok(!allText.includes('LTAI5t...EDaN'), '不应渲染 akIdMasked')
  assert.ok(!allText.includes('LTAI'), '不应出现 AK 前缀')
  assert.ok(!/sk-[A-Za-z0-9]/.test(allText), '不应出现任何 sk- 形态密钥')
  assert.ok(!allText.includes('accessKeySecret'))
})

await check('v0.1.1 自报：seat 成功后 POST client-report，body 键/类型正确', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const reports = reportCalls(env)
  assert.equal(reports.length, 1, '一次 seat 只自报一次（幂等 tick 不重复）')
  assert.equal(reports[0].url, 'api/dsh-qwen-balance/client-report', '必须是同源相对路径')
  assert.equal(reports[0].init.method, 'POST')
  assert.ok(String(reports[0].init.headers['content-type']).includes('json'))
  const body = parseReport(reports[0])
  assert.equal(body.state, 'mounted')
  assert.deepEqual(Object.keys(body.seat).sort(), ['foot', 'settings', 'sidebar', 'usedFallback'])
  assert.equal(body.seat.sidebar, true, '找到侧栏列')
  assert.equal(body.seat.foot, true, '找到 footArea')
  assert.equal(body.seat.settings, true, '找到「设置」行座位')
  assert.equal(body.seat.usedFallback, false, '没有用兜底座位')
  assert.equal(typeof body.rows, 'number')
  assert.equal(body.rows, 0, 'seat 时报的是当时的行数（数据还没回来）')
  assert.equal(typeof body.expanded, 'boolean')
  assert.equal(body.expanded, true, '默认展开状态要报上去')
  assert.equal('error' in body, false, '正常挂载不带 error')
  assert.ok(String(reports[0].init.body).includes('"state":"mounted"'))
})

await check('v0.1.1 自报：无「设置」座位时 usedFallback=true，reseat 上报实际行数', async () => {
  const env = createEnv()
  const frame = env.document.createElement('div')
  frame.setAttribute('class', 'BynINW_frame')
  const column = env.document.createElement('div')
  column.setAttribute('class', 'BynINW_sidebarCol')
  column._measuredWidth = 280
  frame.appendChild(column)
  env.document.body.appendChild(frame)
  // 有 footArea，但没有 settingsArea → 走 foot 末尾兜底座位。
  const foot = env.document.createElement('div')
  foot.setAttribute('class', '_2H3hWW_footArea')
  column.appendChild(foot)

  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const first = lastReport(env)
  assert.ok(first, '兜底座位也要自报')
  assert.equal(first.body.seat.foot, true)
  assert.equal(first.body.seat.settings, false)
  assert.equal(first.body.seat.usedFallback, true)
  assert.equal(first.body.state, 'mounted')
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card && card.parentNode === foot, '兜底时卡片应落在 footArea 里')
})

await check('v0.1.1 自报节流：同 state 5s 内不重复，超过 5s 的 reseat 再报一次', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.equal(reportCalls(env).length, 1, '先有 1 条 mounted')

  const knock = async () => {
    env.mutate(() => {
      env.document.body.appendChild(card)
    })
    await env.settle()
  }

  await knock()
  assert.equal(reportCalls(env).length, 2, '第一次 reseat 应上报')
  assert.equal(parseReport(reportCalls(env)[1]).state, 'reseated')
  assert.equal(parseReport(reportCalls(env)[1]).rows, SAMPLE.rows.length, 'reseat 上报应带实际渲染行数')
  assert.ok(card.nextElementSibling === env.document.querySelector('[class*="settingsArea"]'), '重挂后仍贴「设置」行')

  await knock()
  assert.equal(reportCalls(env).length, 2, '同一 state 5s 内不重复上报')

  env.advance(6000)
  await knock()
  assert.equal(reportCalls(env).length, 3, '超过 5s 的 reseat 应再报一次')
  assert.equal(parseReport(reportCalls(env)[2]).state, 'reseated')
  assert.equal(env.warns.length, 0, '自报全程不应产生 warn：' + env.warns.join('|'))
})

await check('v0.1.1 自报失败不影响渲染（fetch 抛错也只是吞掉）', async () => {
  const env = createEnv()
  buildSidebar(env.document)
  const mod = env.loadClient()
  env.setFetch(async (url, init) => {
    if (String(url).indexOf('client-report') === 0) throw new Error('report endpoint down')
    return { ok: true, status: 200, json: async () => env.payload }
  })
  assert.doesNotThrow(() => mod.apply({}))
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card.textContent.includes('¥263.66'), '自报失败不能影响数据渲染')
  assert.equal(card.getAttribute('data-dsh-qwen-balance-state'), 'ready')
  assert.equal(reportCalls(env).length, 1, '仍然尝试上报过')
  assert.equal(
    env.warns.filter((line) => line.includes('report')).length,
    0,
    '自报失败必须静默吞掉：' + env.warns.join('|'),
  )
})

await check('disposer：移除卡片、停掉轮询与自愈', async () => {
  const env = createEnv()
  const seat = buildSidebar(env.document)
  const mod = env.loadClient()
  const disposer = mod.apply({})
  await env.settle()
  const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
  assert.ok(card)

  disposer()
  assert.equal(env.document.querySelector('[data-dsh-qwen-balance-card]'), null, 'disposer 应移除卡片')
  const before = overviewCalls(env).length
  env.advance(120000)
  await env.settle()
  assert.equal(overviewCalls(env).length, before, 'disposer 后不应再轮询')

  seat.sidebarCol.textContent = ''
  buildSidebar(env.document)
  env.flushMutations()
  env.flushFrames()
  assert.equal(env.document.querySelector('[data-dsh-qwen-balance-card]'), null, 'disposer 后不应自愈重挂')
})

await check('空 payload / 极简 payload 也不崩', async () => {
  for (const payload of [null, {}, { ok: false }, { summary: { label: 'x', value: 0, sub: null, tone: 'weird' } }]) {
    const env = createEnv({ payload })
    buildSidebar(env.document)
    const mod = env.loadClient()
    assert.doesNotThrow(() => mod.apply({}))
    await env.settle()
    const card = env.document.querySelector('[data-dsh-qwen-balance-card]')
    assert.ok(card, 'payload=' + JSON.stringify(payload) + ' 时卡片仍应在')
    card.click()
    await env.settle()
    assert.ok(card.textContent.length > 0)
  }
})

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)