/**
 * dsh-qwen-balance · 客户端半（DSH Web GUI 侧栏余额卡片）
 *
 * 形态：window.__ModuleLoader__.load({ id, factory })，宿主按此加载。
 * 约束（见 docs/PLUGIN-SPEC.md §4/§5）：
 *   - 不引入 React / 不引入打包器，纯 DOM 渲染（只用 createElement + textContent）；
 *   - 取数走同源相对路径（GUI 以 <base href="./"> 提供，绝对路径 /api/... 会 404）；
 *   - 卡片里的一切文案都来自宿主 payload 的 label/value/sub/notes，
 *     客户端只保留少量「协议级」文案（加载中 / 刷新失败 / 暂无数据）；
 *   - 绝不渲染 sources（浏览器侧只需要、也只允许看到掩码）；
 *   - 任何异常都只 console.warn，绝不让侧栏白屏。
 *
 * 挂载座位：侧栏「设置」行上方。查找 / 自愈策略与
 * @linxin666/dsh-usage 的 src/client/foot-card-mount.tsx 保持一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qwen-balance',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ---------------------------------------------------------------- 常量
    /** 卡片容器标记：宿主与自愈逻辑都靠它判断「是否已挂载」。 */
    const CARD_ATTR = 'data-dsh-qwen-balance-card'
    const CARD_SELECTOR = '[' + CARD_ATTR + ']'
    const HEAD_ATTR = 'data-dsh-qwen-balance-head'
    const DETAILS_ATTR = 'data-dsh-qwen-balance-details'
    const ROW_ATTR = 'data-dsh-qwen-balance-row'
    const NOTE_ATTR = 'data-dsh-qwen-balance-note'
    const ERROR_ATTR = 'data-dsh-qwen-balance-error'
    /** 侧栏列：与 dsh-usage 的 foot-card-mount 使用同一套选择器（外壳无 data-pane 时靠类名兜底）。 */
    const SIDEBAR_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'
    const FOOT_SELECTOR = '[class*="footArea"]'
    const SETTINGS_SELECTOR = '[class*="settingsArea"]'
    /** 外壳在侧栏收起（56px 栏轨）时给 frame 打的标记。 */
    const COLLAPSED_ATTR = 'data-sidebar-collapsed'
    const COLLAPSED_CLASS_HINT = 'collapsed'
    /** 56px 栏轨的宽度判定上限（含亚像素/边距余量）。 */
    const RAIL_MAX_WIDTH = 80
    /** 同源相对路径：不要写成 /api/...（GUI 的 <base href="./"> 会让它 404）。 */
    const OVERVIEW_PATH = 'api/dsh-qwen-balance/overview'
    const REFRESH_PATH = 'api/dsh-qwen-balance/refresh'
    const POLL_INTERVAL_MS = 30000
    /** 连点保护：短时间内的重复点击只发 GET，不反复 POST。 */
    const CLICK_MIN_GAP_MS = 1500
    /** 上一次请求疑似卡死时，允许后续轮询重新发起。 */
    const INFLIGHT_STALE_MS = 45000
    const ERROR_MAX_CHARS = 140

    const TONE_COLOR = {
      good: 'var(--dsw-alias-state-success-primary, #16a34a)',
      normal: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, #8b949e)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
    }
    const MUTED_COLOR = 'var(--dsw-alias-label-secondary, #8b949e)'
    const BORDER_COLOR = 'var(--dsw-alias-border-l3, rgba(128,128,128,0.28))'
    const FILL_COLOR = 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.10))'

    /** 客户端自有的「协议级」文案，不含任何财务措辞。 */
    const TEXT = {
      zh: { loading: '加载中…', error: '刷新失败', unavailable: '暂无数据', more: '展开', less: '收起' },
      en: { loading: 'Loading…', error: 'Refresh failed', unavailable: 'No data', more: 'Expand', less: 'Collapse' },
    }

    // ---------------------------------------------------------------- 小工具
    const warn = (...args) => {
      try {
        if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
          console.warn('[dsh-qwen-balance]', ...args)
        }
      } catch {
        /* 日志本身绝不能抛 */
      }
    }

    /** 只接受字符串/数字，其余一律空串（不把 undefined 渲染成 "undefined"）。 */
    const pick = (value) => (value === null || value === undefined ? '' : String(value))

    const text = (key) => {
      const table = TEXT[lang] || TEXT.en
      return table[key] !== undefined ? table[key] : TEXT.en[key]
    }

    /** 清空子节点：textContent = '' 在真实 DOM 与测试 stub 下都会移除全部子节点。 */
    const clear = (node) => {
      if (node) node.textContent = ''
    }

    const make = (tag, attrs, css) => {
      const el = document.createElement(tag)
      if (attrs) {
        for (const key of Object.keys(attrs)) el.setAttribute(key, attrs[key])
      }
      if (css) {
        for (const key of Object.keys(css)) el.style[key] = css[key]
      }
      return el
    }

    const paintTone = (el, tone, fallback) => {
      const wanted = TONE_COLOR[tone] !== undefined ? tone : fallback
      el.setAttribute('data-tone', wanted || 'normal')
      el.style.color = TONE_COLOR[wanted] || TONE_COLOR.normal
    }

    const firstNote = (payload) => {
      if (!payload || !Array.isArray(payload.notes)) return ''
      for (const note of payload.notes) {
        const value = pick(note).trim()
        if (value !== '') return value
      }
      return ''
    }

    const describeError = (err) => {
      let raw = ''
      try {
        raw = err && err.message ? String(err.message) : String(err)
      } catch {
        raw = 'unknown error'
      }
      raw = raw.replace(/\s+/g, ' ').trim()
      if (raw === '') raw = 'unknown error'
      return raw.length > ERROR_MAX_CHARS ? raw.slice(0, ERROR_MAX_CHARS) + '…' : raw
    }

    /** 语言：navigator.language 以 zh 开头 → zh，否则 en。 */
    const detectLang = () => {
      try {
        const tag = typeof navigator !== 'undefined' && navigator ? pick(navigator.language) : ''
        return tag.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    // ---------------------------------------------------------------- 状态
    const lang = detectLang()
    /** 最近一次成功快照；请求失败时保留它（错误只追加一行）。 */
    let payload = null
    let error = null
    let expanded = false
    let started = false
    let disposed = false
    let inflight = false
    let inflightSince = 0
    let pollTimer = null
    let lastClickAt = 0
    let frameHandle = null
    let frameScheduled = false
    let railCollapsed = null

    let card = null
    let headEl = null
    let titleEl = null
    let valueEl = null
    let subEl = null
    let caretEl = null
    let errorEl = null
    let detailsEl = null
    let rowsEl = null
    let notesEl = null
    const cleanups = []

    // ---------------------------------------------------------------- DOM 构建
    const buildCard = () => {
      card = make(
        'div',
        { [CARD_ATTR]: '', 'data-dsh-qwen-balance-state': 'loading' },
        {
          display: 'block',
          boxSizing: 'border-box',
          margin: '0 8px 6px',
          padding: '6px 8px',
          borderRadius: '8px',
          border: '1px solid ' + BORDER_COLOR,
          background: FILL_COLOR,
          color: 'var(--dsw-alias-label-primary, inherit)',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '16px',
          cursor: 'pointer',
          userSelect: 'none',
          overflow: 'hidden',
        },
      )

      headEl = make(
        'div',
        { [HEAD_ATTR]: '', role: 'button', tabindex: '0' },
        { display: 'flex', alignItems: 'baseline', gap: '6px' },
      )
      titleEl = make('span', null, { color: MUTED_COLOR, flex: '0 0 auto' })
      valueEl = make('span', null, { fontWeight: '600', flex: '0 0 auto' })
      subEl = make('span', null, {
        color: MUTED_COLOR,
        flex: '1 1 auto',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      })
      caretEl = make('span', null, { color: MUTED_COLOR, marginLeft: 'auto', flex: '0 0 auto' })
      headEl.appendChild(titleEl)
      headEl.appendChild(valueEl)
      headEl.appendChild(subEl)
      headEl.appendChild(caretEl)

      errorEl = make(
        'div',
        { [ERROR_ATTR]: '' },
        { display: 'none', marginTop: '4px', color: TONE_COLOR.warn, overflowWrap: 'anywhere' },
      )

      detailsEl = make('div', { [DETAILS_ATTR]: '' }, { display: 'none', marginTop: '4px' })
      rowsEl = make('div', { 'data-dsh-qwen-balance-rows': '' }, { display: 'block' })
      notesEl = make(
        'div',
        { 'data-dsh-qwen-balance-notes': '' },
        { display: 'block', marginTop: '2px', color: MUTED_COLOR, fontStyle: 'italic' },
      )
      detailsEl.appendChild(rowsEl)
      detailsEl.appendChild(notesEl)

      card.appendChild(headEl)
      card.appendChild(errorEl)
      card.appendChild(detailsEl)
      return card
    }

    // ---------------------------------------------------------------- 渲染
    const renderRows = (current) => {
      clear(rowsEl)
      if (!current || !Array.isArray(current.rows)) return
      for (const row of current.rows) {
        if (!row || typeof row !== 'object') continue
        const label = pick(row.label)
        const value = pick(row.value)
        if (label === '' && value === '') continue
        const line = make(
          'div',
          { [ROW_ATTR]: pick(row.key), 'data-group': pick(row.group) },
          { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '1px 0' },
        )
        const nameEl = make('span', null, {
          color: MUTED_COLOR,
          flex: '0 1 auto',
          minWidth: '0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        })
        nameEl.textContent = label
        const amountEl = make('span', null, { marginLeft: 'auto', flex: '0 0 auto', whiteSpace: 'nowrap' })
        amountEl.textContent = value
        paintTone(amountEl, row.tone, 'normal')
        line.appendChild(nameEl)
        line.appendChild(amountEl)
        rowsEl.appendChild(line)
      }
    }

    const renderNotes = (current) => {
      clear(notesEl)
      if (!current || !Array.isArray(current.notes)) return
      for (const note of current.notes) {
        const value = pick(note)
        if (value === '') continue
        const line = make('div', { [NOTE_ATTR]: '' }, { padding: '1px 0', overflowWrap: 'anywhere' })
        line.textContent = value
        notesEl.appendChild(line)
      }
    }

    const renderError = () => {
      if (error === null) {
        errorEl.textContent = ''
        errorEl.style.display = 'none'
        return
      }
      errorEl.textContent = text('error') + ' · ' + error
      errorEl.style.display = 'block'
    }

    const render = () => {
      if (card === null) return
      const summary = payload && payload.summary && typeof payload.summary === 'object' ? payload.summary : null
      let titleText = ''
      let valueText = ''
      let subText = ''
      if (summary !== null) {
        titleText = pick(summary.label)
        valueText = pick(summary.value)
        subText = pick(summary.sub)
      } else if (payload !== null) {
        // 无摘要（例如未配置任何来源）：只回显宿主给的引导文案，客户端不编财务措辞。
        valueText = firstNote(payload) || text('unavailable')
      } else {
        valueText = text('loading')
      }
      titleEl.textContent = titleText
      valueEl.textContent = valueText
      subEl.textContent = subText
      paintTone(valueEl, summary !== null ? summary.tone : 'muted', 'normal')
      caretEl.textContent = expanded ? '▾' : '▸'
      caretEl.setAttribute('aria-label', expanded ? text('less') : text('more'))

      renderError()
      detailsEl.style.display = expanded ? 'block' : 'none'
      renderRows(payload)
      renderNotes(payload)

      card.setAttribute(
        'data-dsh-qwen-balance-state',
        error !== null ? 'error' : payload !== null ? 'ready' : 'loading',
      )
    }

    // ---------------------------------------------------------------- 座位 / 自愈
    const query = (root, selector) => {
      try {
        return root ? root.querySelector(selector) : null
      } catch (err) {
        warn('querySelector failed:', selector, err)
        return null
      }
    }

    const queryAll = (root, selector) => {
      try {
        if (!root || typeof root.querySelectorAll !== 'function') return []
        return Array.prototype.slice.call(root.querySelectorAll(selector))
      } catch (err) {
        warn('querySelectorAll failed:', selector, err)
        return []
      }
    }

    /**
     * 侧栏列。外壳目前用类名兜底，但同一页里可能同时存在多列
     * （例如移动端抽屉 + 桌面侧栏），因此优先选**带 footArea 座位**的那一列。
     */
    const sidebarColumn = () => {
      const named = query(document, SIDEBAR_SELECTOR)
      if (named !== null) return named
      const candidates = queryAll(document, '[class*="sidebarCol"]')
      for (const candidate of candidates) {
        if (query(candidate, FOOT_SELECTOR) !== null) return candidate
      }
      return candidates.length > 0 ? candidates[0] : null
    }

    const footArea = () => {
      const column = sidebarColumn()
      return column ? query(column, FOOT_SELECTOR) : null
    }

    /** 把卡片插到「设置」行上方；找不到座位时静默不动。 */
    const seat = () => {
      if (card === null) return false
      const foot = footArea()
      if (foot === null) return false
      const settings = query(foot, SETTINGS_SELECTOR)
      if (settings !== null) {
        if (card.parentNode !== foot || card.nextElementSibling !== settings) {
          foot.insertBefore(card, settings)
        }
        return true
      }
      // 外壳换了锚点（没有 Settings 座位）：退回 foot 末尾，至少还在侧栏里。
      if (card.parentNode !== foot) foot.appendChild(card)
      return true
    }

    /** 侧栏收起成 56px 栏轨时隐藏卡片。 */
    const isRailCollapsed = () => {
      const column = sidebarColumn()
      if (column === null) return false
      // 1) 外壳显式标记（frame 上的 data-sidebar-collapsed=true）。
      let node = column
      while (node !== null && node.nodeType === 1) {
        let flagged = null
        try {
          flagged = node.getAttribute ? node.getAttribute(COLLAPSED_ATTR) : null
        } catch {
          flagged = null
        }
        if (flagged !== null && flagged !== '' && flagged !== 'false') return true
        // 2) 类名兜底：侧栏根节点收起时带 *_collapsed。
        let classNames = ''
        try {
          classNames = node.getAttribute ? pick(node.getAttribute('class')) : ''
        } catch {
          classNames = ''
        }
        if (classNames.split(/\s+/).indexOf(COLLAPSED_CLASS_HINT) >= 0) return true
        if (classNames.indexOf('_' + COLLAPSED_CLASS_HINT) >= 0) return true
        node = node.parentNode
      }
      // 2b) 外壳把 _collapsed 打在侧栏根节点上，而它是**列的后代**（列 > root > footArea），
      //     所以还要沿着 footArea → 列 这条链看一眼。只认这条链上的类名，
      //     避免面板里某个无关折叠区块把卡片误隐藏。
      const foot = query(column, FOOT_SELECTOR)
      let scoped = foot !== null ? foot : column
      while (scoped !== null && scoped !== undefined && scoped !== column.parentNode) {
        let scopedClasses = ''
        try {
          scopedClasses = scoped.getAttribute ? pick(scoped.getAttribute('class')) : ''
        } catch {
          scopedClasses = ''
        }
        if (scopedClasses.split(/\s+/).indexOf(COLLAPSED_CLASS_HINT) >= 0) return true
        if (scopedClasses.indexOf('_' + COLLAPSED_CLASS_HINT) >= 0) return true
        scoped = scoped.parentNode
      }
      // 3) 宽度兜底：量到的列宽掉到栏轨量级。
      try {
        let width = 0
        if (typeof column.getBoundingClientRect === 'function') {
          const rect = column.getBoundingClientRect()
          width = rect && typeof rect.width === 'number' ? rect.width : 0
        }
        if (!width && typeof column.offsetWidth === 'number') width = column.offsetWidth
        if (width > 0 && width <= RAIL_MAX_WIDTH) return true
      } catch {
        /* 量不到就当没收起 */
      }
      return false
    }

    const applyRailVisibility = () => {
      if (card === null) return
      const collapsed = isRailCollapsed()
      if (collapsed === railCollapsed) return
      railCollapsed = collapsed
      card.style.display = collapsed ? 'none' : 'block'
      if (collapsed) card.setAttribute('data-rail', 'collapsed')
      else card.removeAttribute('data-rail')
    }

    const tick = () => {
      if (disposed) return
      let seated = false
      try {
        seated = seat()
      } catch (err) {
        warn('seat failed:', err)
      }
      try {
        applyRailVisibility()
      } catch (err) {
        warn('rail visibility failed:', err)
      }
      if (seated && !started) {
        started = true
        startPolling()
        void load(false)
      }
    }

    const schedule = () => {
      if (disposed || frameScheduled) return
      frameScheduled = true
      try {
        const raf = typeof window !== 'undefined' && window ? window.requestAnimationFrame : null
        if (typeof raf === 'function') {
          frameHandle = raf(() => {
            frameScheduled = false
            frameHandle = null
            try {
              tick()
            } catch (err) {
              warn('tick failed:', err)
            }
          })
          return
        }
      } catch {
        /* 落到同步路径 */
      }
      frameScheduled = false
      tick()
    }

    const observeShell = () => {
      try {
        if (typeof MutationObserver !== 'function') return
        const target = document.body || document.documentElement
        if (!target) return
        const observer = new MutationObserver(() => schedule())
        observer.observe(target, { childList: true, subtree: true })
        cleanups.push(() => {
          try {
            observer.disconnect()
          } catch {
            /* ignore */
          }
        })
      } catch (err) {
        warn('observer setup failed:', err)
      }
      try {
        // 栏宽变化不一定伴随 DOM 变更（无 MutationObserver 时尤其需要）。
        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
          const onResize = () => schedule()
          window.addEventListener('resize', onResize)
          cleanups.push(() => {
            try {
              window.removeEventListener('resize', onResize)
            } catch {
              /* ignore */
            }
          })
        }
      } catch {
        /* ignore */
      }
    }

    // ---------------------------------------------------------------- 取数
    const resolveFetch = () => {
      try {
        if (typeof fetch === 'function') return fetch
        if (typeof window !== 'undefined' && window && typeof window.fetch === 'function') return window.fetch
      } catch {
        /* ignore */
      }
      return null
    }

    const requestUrl = (path) => path + '?lang=' + encodeURIComponent(lang)

    const load = async (force) => {
      if (disposed) return
      const now = Date.now()
      if (inflight && now - inflightSince < INFLIGHT_STALE_MS) return
      const doFetch = resolveFetch()
      if (doFetch === null) {
        error = 'fetch unavailable'
        try {
          render()
        } catch (err) {
          warn('render failed:', err)
        }
        return
      }
      inflight = true
      inflightSince = now
      const url = requestUrl(force ? REFRESH_PATH : OVERVIEW_PATH)
      const init = {
        method: force ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }
      try {
        const res = await doFetch(url, init)
        const failed =
          !res ||
          res.ok === false ||
          (typeof res.ok !== 'boolean' && Number(res.status) >= 400) ||
          (typeof res.status === 'number' && res.status >= 400)
        if (failed) {
          throw new Error('HTTP ' + (res && res.status !== undefined && res.status !== null ? res.status : '?'))
        }
        const data = await res.json()
        if (!data || typeof data !== 'object') throw new Error('invalid payload')
        payload = data
        error = null
      } catch (err) {
        // 保留上次数据，只追加一行错误。
        error = describeError(err)
        warn('overview request failed:', error)
      } finally {
        inflight = false
        try {
          render()
        } catch (err2) {
          warn('render failed:', err2)
        }
      }
    }

    // ---------------------------------------------------------------- 轮询 / 交互
    const isHidden = () => {
      try {
        if (document && document.hidden === true) return true
        return !!document && document.visibilityState === 'hidden'
      } catch {
        return false
      }
    }

    const stopPolling = () => {
      if (pollTimer !== null) {
        try {
          clearInterval(pollTimer)
        } catch {
          /* ignore */
        }
        pollTimer = null
      }
    }

    const startPolling = () => {
      stopPolling()
      try {
        pollTimer = setInterval(() => {
          if (disposed || isHidden()) return
          void load(false)
        }, POLL_INTERVAL_MS)
      } catch (err) {
        warn('polling setup failed:', err)
      }
    }

    const onVisibilityChange = () => {
      try {
        if (isHidden()) return
        // 从后台回来立刻补一次。
        void load(false)
      } catch (err) {
        warn('visibility handler failed:', err)
      }
    }

    const onActivate = (ev) => {
      try {
        if (detailsEl !== null && ev && ev.target && detailsEl.contains(ev.target)) return
        expanded = !expanded
        render()
        const now = Date.now()
        const force = now - lastClickAt >= CLICK_MIN_GAP_MS
        lastClickAt = now
        void load(force)
      } catch (err) {
        warn('click handler failed:', err)
      }
    }

    const onKeyDown = (ev) => {
      try {
        if (!ev) return
        const key = ev.key
        if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
        if (typeof ev.preventDefault === 'function') ev.preventDefault()
        onActivate(ev)
      } catch (err) {
        warn('key handler failed:', err)
      }
    }

    // ---------------------------------------------------------------- apply
    const noop = () => {}

    exports.inject = []

    exports.apply = (ctx) => {
      try {
        if (typeof document === 'undefined' || !document) return noop
        // DOM 级幂等：无论是重复 apply 还是 HMR 重注入，都只留一张卡片。
        if (query(document, CARD_SELECTOR) !== null) return noop

        buildCard()
        card.addEventListener('click', onActivate)
        headEl.addEventListener('keydown', onKeyDown)

        const visibilityTarget = document
        if (visibilityTarget && typeof visibilityTarget.addEventListener === 'function') {
          visibilityTarget.addEventListener('visibilitychange', onVisibilityChange)
          cleanups.push(() => {
            try {
              visibilityTarget.removeEventListener('visibilitychange', onVisibilityChange)
            } catch {
              /* ignore */
            }
          })
        }

        observeShell()
        // 先同步落座一次，再靠观察器持续自愈。
        tick()
        schedule()

        return () => {
          if (disposed) return
          disposed = true
          stopPolling()
          for (const cleanup of cleanups.splice(0)) {
            try {
              cleanup()
            } catch {
              /* ignore */
            }
          }
          try {
            if (frameHandle !== null && typeof window !== 'undefined' && window && typeof window.cancelAnimationFrame === 'function') {
              window.cancelAnimationFrame(frameHandle)
            }
          } catch {
            /* ignore */
          }
          frameHandle = null
          try {
            card.remove()
          } catch {
            /* ignore */
          }
          card = null
        }
      } catch (err) {
        warn('apply failed:', err)
        return noop
      }
    }

    return module.exports
  },
})