# dsh-qwen-balance · v0.1.0 规格（冻结版）

> 本文件是**接口冻结**。host 半、client 半、打包/文档三方按此并行开发；任何一方要改这里，先改本文件并通知 Lead。

## 1. 目标与形态

一个可安装的 DSH 插件：在 DSH Web GUI 侧栏「设置」行**上方**插入一张紧凑余额卡片，显示：

1. **阿里云账户**：可用额度 / 现金余额 / 信控额度（BSS `QueryAccountBalance`）
2. **阿里云代金券**：可用券合计、券号、单券余额、到期日（BSS `QueryCashCoupons`）
3. **中转站 / 网关余额**（OpenAI 兼容中转站，0..N 个）：`/dashboard/billing/subscription`+`/usage`（one-api/new-api）、`/user/balance`（DeepSeek 风格）
4. 没有任何来源配置时：显示一行配置引导，而不是报错

发行方式（用户已选）：**只发 GitHub 仓库 + 向 awesome-dsh-plugin 精选列表提 PR 收录**，不走 npm。

## 2. 包与仓库

- 仓库/包名：`dsh-qwen-balance`，仓库根目录**就是**包根目录（无 monorepo）
- 版本：`0.1.0`，`license: MIT`，`private: false`
- `type: module`，`main: lib/index.js`
- 装机后由 DSH 直接加载，**安装时不跑构建**：`lib/` 下的文件全部是提交进仓库的可运行 JS（宿主半 = 普通 ESM；客户端半 = `window.__ModuleLoader__.load` 包装的浏览器包）
- 不引入 React、不引入打包器；唯一运行时依赖 `@deepseek-ai/schemastery`（配置 schema）

```
package.json
cordis.patch.yml          # DSH bundle 插桩（insert 本插件）
lib/index.js              # 宿主半入口：cordis 插件（name/inject/Config/apply）
lib/core/bss.js           # 阿里云 RPC 签名 + QueryAccountBalance / QueryCashCoupons
lib/core/gateway.js       # 中转站/网关余额探测
lib/core/ak.js            # AccessKey 来源解析（env > 文件 > 插件配置）
lib/core/view.js          # 快照 → 卡片行（rows/summary），含 i18n 文案
lib/core/i18n.js          # zh/en 文案表
lib/client.js             # 客户端半入口（侧栏卡片）
test/*.test.mjs           # node --test 单测（host 侧，纯函数为主）
tools/install-local.mjs   # 本机安装到指定 profile 的辅助脚本
docs/PLUGIN-SPEC.md       # 本文件
README.md  README.zh.md   # 英文 / 中文说明
LICENSE
```

## 3. 宿主半契约

### 3.1 cordis 插件导出（`lib/index.js`）

```js
export const name = 'dsh-qwen-balance'
export const inject = ['webServer']
export const Config = z.object({ /* 见 3.4 */ })
export const apply = (ctx, config) => { /* 返回 disposer */ }
```

- `apply` 内：注册路由 + 起一个轮询定时器（`config.pollIntervalSec`）+ 保存最近一次快照
- 定时器必须可被 disposer 清理；`pollIntervalSec` 变化时重排（监听 `loader/volatile-update` 或等价时机）
- 插件**不监听**任何 LLM/session 事件，不写磁盘（除可选调试日志）

### 3.2 路由（**仅允许环回**）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-qwen-balance/overview?lang=zh\|en` | 返回最近快照（必要时触发一次抓取）；`cache-control: no-store` |
| POST | `/api/dsh-qwen-balance/refresh` | 立即抓一次后返回同一结构；非 POST → 405 |
| POST | `/api/dsh-qwen-balance/client-report` | **v0.1.1 追加**：浏览器半上报自身挂载状态（诊断用，契约见 §3.6）；非 POST → 405 |

- 非环回请求 → `403 {ok:false,error:"forbidden: loopback-only"}`
- 未知路径不注册（由宿主回 404）

### 3.3 `/overview` 响应（**冻结**）

```jsonc
{
  "ok": true,                       // 至少一个来源成功，且插件已启用
  "enabled": true,
  "checkedAt": "2026-10-21T04:00:00.000Z",
  "lang": "zh",
  "summary": { "key": "summary", "label": "阿里云", "value": "¥263.66", "sub": "代金券可用", "tone": "good" },
  "rows": [
    { "key": "coupon.total", "label": "代金券可用", "value": "¥263.66", "tone": "good",  "group": "coupon" },
    { "key": "coupon.923898490070", "label": "券 923898490070", "value": "¥263.66 · 2027-10-20 到期", "tone": "normal", "group": "coupon" },
    { "key": "aliyun.cash",  "label": "现金余额", "value": "¥0.01", "tone": "muted", "group": "aliyun" },
    { "key": "gw1.remaining","label": "中转站 剩余", "value": "$7.66", "tone": "normal", "group": "gateway" }
  ],
  "notes": ["未配置阿里云 AccessKey（可在插件配置里填，或设置环境变量）"],
  "sources": {
    "aliyun": { "state": "ok|off|error", "error": null, "availableAmount": 0.01, "cashAmount": 0.01, "creditAmount": 0, "currency": "CNY" },
    "coupons": { "state": "ok|off|error", "error": null, "availableBalance": 263.66, "availableCount": 1, "totalCount": 1,
                 "nominalTotal": 300, "nearestExpiry": "2027-10-20T00:00:00Z", "akIdMasked": "LTAI5t...EDaN",
                 "items": [ { "no": "923898490070", "balance": 263.66, "nominal": 300, "status": "Available", "expiry": "2027-10-20T00:00:00Z", "scenarios": "..." } ] },
    "gateways": [ { "id": "gw1", "name": "中转站", "kind": "newapi", "state": "ok", "error": null,
                    "currency": "USD", "total": 20, "used": 12.34, "remaining": 7.66, "balance": null } ]
  },
  "error": null,                    // 插件禁用时为 "disabled"
  "client": null                    // v0.1.1 追加：浏览器半最后一次自报；从未上报时 null（见 §3.6）
}
```

规则：
- **payload 里永不出现明文密钥**；AK 只能以 `akIdMasked`（≤12 位：前 2 位 + `***`；更长：前 6 位 + `...` + 后 4 位）出现
- 无任何来源配置：`ok:false`、`rows:[]`、`notes` 含配置引导，HTTP 仍是 200
- 单个来源失败不影响其它来源；失败写进该来源的 `state/error`，并追加一条 `note`
- 数值字段一律为 `number | null`，**不要**把 `undefined` 序列化进 JSON
- `lang` 只影响 `summary.label/rows[].label/notes` 文案，字段名与数值不变
- **v0.1.1 追加字段**：`client`（`null` 或 `{at,state,seat,rows,expanded,error}`）。这是**追加**——v0.1.0 的字段名、类型、语义一个都没有改动

### 3.4 配置 schema（自动生成的插件配置表单）

```js
z.object({
  enabled:          z.boolean().default(true).volatile(),
  pollIntervalSec:  z.number().min(30).max(3600).default(60).volatile(),
  showCoupons:      z.boolean().default(true).volatile(),
  showGateways:     z.boolean().default(true).volatile(),
  aliyun: z.object({
    enabled:   z.boolean().default(true).volatile(),
    endpoint:  z.string().default('').volatile(),   // 空 = business.aliyuncs.com；国际站 business.ap-southeast-1.aliyuncs.com
    akId:      z.string().default('').volatile(),
    akSecret:  z.string().default('').volatile(),   // 明文风险，文档必须先推荐 env / 文件
    useAkFile: z.boolean().default(true).volatile(),// 允许读 ~/.dsh/qwen-coupon.json
    akFile:    z.string().default('').volatile(),   // 空 = %USERPROFILE%\.dsh\qwen-coupon.json
  }).default({}),
  gateways: z.array(z.object({
    name:      z.string().default(''),
    baseUrl:   z.string().default(''),
    apiKey:    z.string().default(''),
    apiKeyEnv: z.string().default(''),
    kind:      z.union([z.const('auto'), z.const('newapi'), z.const('user-balance')]).default('auto'),
  })).default([]).volatile(),
})
```

> **勘误（2026-10-21，实现期发现）**：数组**本身**标 `volatile`，其**成员字段不要再标** `volatile`。
> schemastery 的 `validateVolatileSchema`（`src/index.ts:488-509`，数组 `inner` 会带 `blocked = true`）要求 volatile 字段位于固定对象路径上，
> 成员字段再标 volatile 会直接抛：
> `ValidationError - $.gateways.*.name volatile fields require a fixed object path without an enclosing volatile field`。
> 交付实现（`lib/index.js:237-243`）按本勘误执行：数组 volatile、成员普通对象，`gateways` 仍是可实时编辑的一个字段。
> 例外：`aliyun` 是普通对象（非 volatile 容器），其字段 `.volatile()` 合法且必须保留。

AK 解析优先级：**环境变量 > AK 文件 > 插件配置**
- 环境变量：`ALIYUN_AK_ID` / `ALIYUN_AK_SECRET` / `ALIYUN_STS_TOKEN` / `ALIYUN_BSS_ENDPOINT`（兼容 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`）
- AK 文件：`{"aliyunAkId","aliyunAkSecret","aliyunStsToken","bssEndpoint"}`（与本机既有 `E:\sings\scripts\lib\aliyun-bss.mjs` 的 `loadAkConfig` 同格式）
- 插件配置里的 `aliyun.akId/akSecret` 兜底

### 3.5 数据来源实现要求

- 阿里云：RPC 风格签名 V1.0 / HMAC-SHA1，`Action=QueryAccountBalance|QueryCashCoupons`、`Version=2017-12-14`、`SignatureMethod=HMAC-SHA1`、`SignatureNonce`、`Timestamp`(ISO, 毫秒带 Z)、可选 `SecurityToken`
- 一律 `node:http`/`node:https` + `agent:false`（**不要用 global fetch/undici**：本机已确认「undici keep-alive + process.exit」在 Windows 上会崩 `UV_HANDLE_CLOSING`）
- 网关探测按 `kind`：`auto` = 先 `/dashboard/billing/subscription`（`hard_limit_usd`）再 `/dashboard/billing/usage`（`total_usage` 单位**美分**，/100）；抓不到再试 `/user/balance`（`balance_infos[]`）；旧版 one-api 会对未知路由回 `200 + HTML`，必须识别并降级为 error
- 超时默认 15s；任一来源的异常必须被捕获成 `state:'error'` + 简短消息，**不得**冒泡成 500

### 3.6 v0.1.1 追加：`client-report` 与 `client` 字段（向后兼容）

为什么有：卡片「有没有挂上、点了有没有反应」在宿主侧原本完全不可观测——用户实测报「点着没反应」时只能靠截图猜。所以浏览器半在每次 seat 成功后自报一次，宿主把它带回 `overview.client`。

`POST /api/dsh-qwen-balance/client-report`

| 项 | 约定 |
| --- | --- |
| 请求体 | JSON 对象，≤ 2048 字节；`state` 必须是 `mounted` / `reseated` / `error` 之一 |
| 成功 | `200 {ok:true}`，并记为「最后一次上报」保存在宿主内存（**不落盘、不写日志正文**） |
| 非法 state / 非 JSON / 非对象 | `400 {ok:false,error:"invalid client report"}` |
| 超过 2048 字节 | `413 {ok:false,error:"payload too large"}` |
| 非 POST（含 GET/HEAD） | `405 {ok:false,error:"method not allowed"}` |
| 非环回 | `403 {ok:false,error:"forbidden: loopback-only"}` |

字段归一化（宿主强制，`normalizeClientReport`）：`seat` 只保留 `{sidebar,foot,settings,usedFallback}` 四个布尔；`rows` 取非负整数；`expanded` 取布尔；`error` 截断 200 字符并压平空白；其余字段一律丢弃。`overview.client` 的 `at` 由**宿主**填（收到时刻的 ISO 串），不采信客户端时间。

## 4. 客户端半契约（`lib/client.js`）

- 文件形态（**必须**，宿主按此加载）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-qwen-balance',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    // ... exports.inject / exports.apply
    return module.exports
  },
})
```

- 只导出 `inject`（可为 `[]`）与 `apply(ctx)`
- `apply` 里：往侧栏「设置」行上方插入 `<div data-dsh-qwen-balance-card>`，内部自己渲染（纯 DOM，不用 React）；页面无该座位时静默不挂载
- 取数：同源相对路径 `api/dsh-qwen-balance/overview?lang=<zh|en>`（GUI 以 `<base href="./">` 提供，**不要**写 `/api/...` 绝对路径）
- 轮询：标签页可见时 30s；`document.hidden` 时暂停；`POST api/dsh-qwen-balance/refresh` 用于点击刷新
- 渲染要求：紧凑；**v0.1.1 起默认展开**——首次渲染就把全部 `rows` 显示出来（用户要求「打开就能看、不用点」），点击整卡 = 收起/展开 + 强制刷新一次；`tone` 映射颜色（good/normal/muted/warn）；出错显示一行错误 + 上次数据保留
- **v0.1.1 起自报挂载状态**：每次 seat/reseat 成功后 `POST api/dsh-qwen-balance/client-report`，body `{state, seat:{sidebar,foot,settings,usedFallback}, rows, expanded, error?}`（同一 state 5s 内不重复上报；`apply` 抛错时尽力上报 `{state:'error',error}`）；上报必须 try/catch 吞掉，**绝不允许影响渲染或轮询**
- 任何异常都不能让侧栏白屏：整个 `apply` 用 try/catch 包住，出错只 console.warn
- 语言：`navigator.language` 以 `zh` 开头 → `zh`，否则 `en`

## 5. 安全红线（验证方会重点打）

1. 浏览器侧永远拿不到、也永远不请求任何密钥；`overview` 里只有 `akIdMasked`
2. `/overview`、`/refresh`、`/client-report` 非环回一律 403
3. 日志、错误消息、notes 里不得出现明文 AK / STS / 网关 key（只有掩码）
4. 代金券余额是**独立**于「可用额度」的数字，文案不得暗示已计入可用额度
5. `README` 必须说清：AK 建议用环境变量或 `~/.dsh/qwen-coupon.json`，插件配置里的明文只作最后兜底

## 6. 验收标准（v0.1.0）

- 一个**全新 profile** 能装上并跑起来：`dsh <test> --from-default-profile web --dump-config`（建出带 webServer 的 profile）→ `dsh plugin --profile <test> add link:<repo>` → `dsh <test> --port 59xxx --no-open` → `/api/dsh-qwen-balance/overview` 200 且结构符合 §3.3，GUI 的客户端模块清单里出现 `dsh-qwen-balance/client.js`（Lead 已实测：2026-10-21，测试 profile `qwen-balance-test`）
- `node --test`（不带路径；Node 24 起 `node --test test/` 会报 `Cannot find module ...\test`）全绿；host 核心纯函数（签名、金额解析、券筛选、网关降级、掩码）单测覆盖
- 用 mock BSS + mock 网关跑通：券合计、现金余额、网关剩余三类行都渲染出来
- 不配置任何来源时不报错，只给配置引导
- 断网/错误 AK 时卡片保留上次数据并显示错误行
- README（中英）+ LICENSE + 收录 PR 物料齐备
- **v0.1.1 增量验收**（独立复验见 `out/plugin-verify/delta-v011-verify.md`）：`client-report` 的 200/400/413/405/403 全覆盖、`overview.client` 反映最后一次上报、v0.1.0 字段清单除新增 `client` 外零改动、客户端默认展开 + 上报 body 正确 + 上报失败不影响渲染