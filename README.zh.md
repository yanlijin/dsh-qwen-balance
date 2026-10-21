# dsh-qwen-balance

[English](README.md) | 中文

<p align="center">
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
  &nbsp;
  <img src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-339933?style=flat-square" alt="Node">
</p>

<p align="center">
  <strong>DeepSeek Harness（DSH）Web 侧栏里的阿里云 / Qwen 余额卡片</strong><br>
  <em>账户可用额度与现金余额 · 代金券（学生券）余额与到期日 · OpenAI 兼容中转站额度</em>
</p>

`dsh-qwen-balance` 在 DSH Web GUI 侧栏的「设置」行**正上方**插入一张紧凑卡片。宿主侧按你配置的来源轮询取数，卡片只渲染宿主量到的结果。浏览器既不直连阿里云、也不直连中转站，更拿不到任何密钥。

## 截图

<!-- 截图占位：docs/screenshot.png 尚未提供。
     在该文件真实存在于本仓库之前，不要添加指向它的 <img> 标签。 -->

> 📷 **截图占位** — 侧栏卡片（收起时的一行摘要与展开后的各行）会在 `docs/screenshot.png` 拍好后插到这里。在该文件真实存在于本仓库之前，本 README 刻意不写任何指向它的图片引用。

## 卡片显示什么

| 来源 | 卡片显示 | 宿主如何取数 |
| --- | --- | --- |
| **阿里云账户** | 可用额度、现金余额、信控额度、币种 | BSS OpenAPI `QueryAccountBalance` |
| **阿里云代金券** | 可用券合计与张数；每张券一行，含余额、到期日、券号 | BSS OpenAPI `QueryCashCoupons` |
| **中转站 / 网关**（0..N 个） | 剩余额度；网关提供时另显示总额与已用 | `GET /dashboard/billing/subscription` + `GET /dashboard/billing/usage`，或 `GET /user/balance` |

一个来源都没配置时，卡片显示一行配置引导，而不是报错。

### 必须说清的实话：DashScope 的 `sk-` key 没有余额接口

**官方百炼（Model Studio）/ DashScope 的 `sk-` API key 没有任何余额或额度接口。** 没有哪个已公开的调用能返回这种 key 的余额；千问 CLI 的 OAuth 登录态也只有用量 / 套餐类命令，同样没有代金券命令。

所以本插件从不向你索取 DashScope 的 key。想看到真金白银和真代金券——现金余额，以及**学生认证 300 元券**这类代金券——它调的是阿里云 **BSS OpenAPI**，需要一对 **AccessKey**（`LTAI...` 形式的 AK/SK，不是 `sk-` key）。没有 AccessKey 时，阿里云与代金券两行按设计留空，卡片会直接说明原因。

## 安装

要求：DSH `0.2.0-rc.2` 或更高，Node `^22.19.0 || >=24.0.0`。没有构建步骤：`lib/` 里就是可直接运行的 JavaScript，安装时不编译任何东西。

### 从插件市场安装（本插件被收录后）

DSH 自带不带索引源，Discover 页签属于实验性插件包：

1. 打开 **Plugins**，点 **Experimental plugins**（实验性插件）旁的 **More**，打开 **Custom plugin markets**（自定义插件市场）。此时 **Installed** 旁会出现 **Discover** 页签。
2. 在 **Discover** 里选 **Add index source**（添加索引源），填入社区目录 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`。
3. 搜索 `dsh-qwen-balance`，在确认框里核对来源后安装。每个索引源属于当前 profile。

[dsh-market](https://github.com/dsh-market/dsh-market) 是内置同一份列表的可视化市场，可用 `dsh plugin --profile <profile> add dshmarket` 安装。

> 该社区目录目前收录的是 **npm 来源**的版本。本插件 v0.1.0 只从 GitHub 发布、**未发 npm**，因此在该条目落地之前（或你的索引源只提供 npm 安装时），请用下面的 GitHub 命令安装。

### 从 GitHub 安装

```bash
dsh plugin --profile <profile> add github:yanlijin/dsh-qwen-balance
```

上面的命令从 `github.com/yanlijin/dsh-qwen-balance` 安装；如果你是从自己的 fork 安装，把 `yanlijin` 换成你自己的账号。

### 从本地仓库安装（开发用）

```bash
# 1) 建一个能跑 web 的 profile（已存在就跳过；少了 web 层，插件会一直 pending）
dsh qwen-balance-test --from-default-profile web --dump-config

# 2) 把本仓库装进该 profile
dsh plugin --profile qwen-balance-test add link:E:\sings\plugins\dsh-qwen-balance

# 3) 启动：profile 名是位置参数 —— 是 `dsh <profile>`，不是 `dsh web --profile <profile>`
dsh qwen-balance-test --port 59420 --no-open
```

`tools/install-local.mjs` 会替你做完这三步（profile 不存在时自动用官方 web 模板建，然后打印启动命令）：

```bash
node tools/install-local.mjs                 # 装进 qwen-balance-test 这个 profile
node tools/install-local.mjs my-profile      # 或你自己指定的 profile
node tools/install-local.mjs --dry-run       # 只打印命令，不执行
```

### profile 是什么

DSH 的 **profile** 是 `%USERPROFILE%\.dsh\profiles\<name>` 下一个具名的安装体，有自己独立的插件集、配置与会话。插件按 profile 安装，因此插件只会出现在你把它装进去的那个 profile 里。

**`desktop` profile 由 DeepSeek Harness 桌面应用独占管理**——CLI 会直接拒绝碰它（`error: profile "desktop" is managed exclusively by the Electron application`），它的插件列表归桌面应用所有。`tools/install-local.mjs` 出于同样的理由拒绝使用这个 profile 名。要试插件，请另建一个 profile（例如 `qwen-balance-test`），装进去，再用 `dsh <profile> --port <端口>` 启动它自己的 web 服务。

> **踩坑**：`dsh plugin --profile <新名字> add ...` 会顺手建出 profile，但只带 `@deepseek-ai/dsh-base` 一个 bundle——**没有 webServer**。这时 `dsh <profile>` 不会起 HTTP 服务，插件会停在 `pending (waiting for service: webServer)`。所以先用 `--from-default-profile web` 建 profile，再装插件。

新装的**宿主半**需要 `dsh web` 进程启动（或重启）后路由才存在；**浏览器半**刷新页面即可生效。装包本身就够了——随包发布的 `cordis.patch.yml` 会把插件行插进 web 插件花名册。

## 配置

在 DSH Web GUI 里打开本插件的设置，表单由插件自己的配置 schema 生成。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后不探测、不注册路由。 |
| `pollIntervalSec` | `60` | 宿主侧探测周期（秒，30–3600）。 |
| `showCoupons` | `true` | 是否显示代金券行。 |
| `showGateways` | `true` | 是否显示中转站行。 |
| `aliyun.enabled` | `true` | 是否探测阿里云 BSS（账户余额与代金券）。 |
| `aliyun.endpoint` | `""` | 空 = `business.aliyuncs.com`（国内站）；国际站填 `business.ap-southeast-1.aliyuncs.com`。 |
| `aliyun.akId` | `""` | AccessKey ID，仅作明文兜底，见下文。 |
| `aliyun.akSecret` | `""` | AccessKey Secret，仅作明文兜底，**不安全**，见下文。 |
| `aliyun.useAkFile` | `true` | 是否允许读取 AK 文件。 |
| `aliyun.akFile` | `""` | 空 = `%USERPROFILE%\.dsh\qwen-coupon.json`。 |
| `gateways[]` | `[]` | 中转站 / 网关定义（见下表）。 |

每条 `gateways[]` 条目：

| 字段 | 含义 |
| --- | --- |
| `name` | 该行显示的名称（留空时用通用的「中转站」文案）。 |
| `baseUrl` | OpenAI 兼容中转站的基址，例如 `https://relay.example.com`。 |
| `apiKey` | 发给该中转站的 key，明文。优先用 `apiKeyEnv`。 |
| `apiKeyEnv` | 宿主读取 key 的环境变量名，例如 `RELAY_API_KEY`。 |
| `kind` | `auto`（默认）、`newapi`（one-api / new-api 的 billing 端点）或 `user-balance`（DeepSeek 风格 `GET /user/balance`）。 |

## 阿里云 AccessKey：三种来源与优先级

宿主按下面的顺序解析 AccessKey，取第一个能凑齐一对的来源：

1. **环境变量**（服务器或 shell 配置里推荐这种方式）

   | 变量 | 是否必需 | 含义 |
   | --- | --- | --- |
   | `ALIYUN_AK_ID` | 必需 | AccessKey ID |
   | `ALIYUN_AK_SECRET` | 必需 | AccessKey Secret |
   | `ALIYUN_STS_TOKEN` | 可选 | STS Token，临时凭据用 |
   | `ALIYUN_BSS_ENDPOINT` | 可选 | BSS 端点；国际站用 `business.ap-southeast-1.aliyuncs.com` |

   别名同样接受：`ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` 与 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`，STS 别名则为 `ALIBABA_CLOUD_SECURITY_TOKEN`。

2. **AK 文件** —— 默认 `%USERPROFILE%\.dsh\qwen-coupon.json`（`aliyun.akFile` 可改路径，`aliyun.useAkFile: false` 可整体关闭）：

   ```json
   {
     "aliyunAkId": "LTAI5t...",
     "aliyunAkSecret": "...",
     "aliyunStsToken": "",
     "bssEndpoint": ""
   }
   ```

   本仓库的 `.gitignore` 已忽略 `qwen-coupon.json`，而且这个文件本来就在仓库之外。请确保只有你自己的账户能读它。

3. **插件配置里的 `aliyun.akId` / `aliyun.akSecret`** —— **只在万不得已时用。** 这两个值以明文存进 profile 的插件配置里，能读你用户目录的人就能读到这对密钥。能用第 1 或第 2 种就用；确实都没有时再退回第 3 种。

### AccessKey 需要哪些权限

| 调用 | 权限点 |
| --- | --- |
| `QueryAccountBalance`（可用额度 / 现金 / 信控） | `bss:DescribeAcccount` |
| `QueryCashCoupons`（代金券及其余额） | `bss:DescribeCoupons` |

建议新建一个 **RAM 用户**，只挂只读托管策略 **`AliyunBSSReadOnlyAccess`**——这就是这里最小可用的授权。不要多给任何权限，也不要把管理员 AccessKey 写进配置文件。如果该 RAM 身份调用 BSS 时返回 `NotApplicable`，说明这种账号类型不能用这种方式调用——改用主账号（root）的 AccessKey，这是少数确实该用主账号 AK 的场合。

代金券与账户余额是**两个独立的数字**。阿里云官方文档明确：可用额度**不包含**代金券与储值卡余额，因此卡片里的代金券行永远不会声称自己已计入可用额度。

### 国际站

如果你的账号在阿里云国际站，把端点设为 `business.ap-southeast-1.aliyuncs.com`（可用 `ALIYUN_BSS_ENDPOINT`、AK 文件里的 `bssEndpoint`，或插件配置里的 `aliyun.endpoint`）。国际站账号去调国内站端点，通常会以超时收场，而不是给你一条明确的错误信息。

## 卡片字段

宿主把最近一次快照以 JSON 形式暴露出来，卡片只负责渲染。收起时只显示头条，点击后展开全部行。

| 字段 | 示例 | 含义 |
| --- | --- | --- |
| `summary.label` / `.value` / `.sub` | `阿里云` / `¥263.66` / `代金券可用` | 收起状态下卡片展示的头条数值，加一句简短限定语。 |
| `coupon.total` | `¥263.66` | 所有 **Available** 状态代金券的余额合计，附张数。与账户可用额度互相独立。 |
| `coupon.<券号>` | `¥263.66 · 2027-10-20 到期` | 每张 **Available** 券一行，key 用接口返回的券号（例如 `coupon.923898490070`），最多五行；接口没给券号时回退成 `coupon.item`。 |
| `aliyun.available` | `¥0.01` | 账户可用额度。 |
| `aliyun.cash` | `¥0.01` | 现金余额。 |
| `aliyun.credit` | `¥0.00` | 信控额度。 |
| `<网关>.remaining` | `$7.66` | 中转站剩余额度；网关提供时另带 `<网关>.used`、`<网关>.total`、`<网关>.balance` 行。网关 key 用它的 `id`，默认是 `gw1`、`gw2`… |
| `notes` | — | 本地化的引导与错误行，例如「未配置 AccessKey」。 |

行的 `key` 是稳定契约；可见的 `label` 文案跟随请求语言。完整快照里还有 `sources` 块，记录每个来源的 `state`（`ok` / `off` / `error`）、错误消息、原始数值，以及**掩码后**的 AccessKey ID（例如 `LTAI5t...EDaN`）。数值一律为 `number | null`，不会是 `undefined`。

### 轮询与语言

- **宿主**每 `pollIntervalSec` 秒探测一次（默认 60，允许 30–3600）。
- **卡片**在标签页可见时每 30 秒向宿主取一次，`document.hidden` 时暂停；点击卡片会立刻强制探测一次。
- **语言**：`navigator.language` 以 `zh` 开头用中文，否则用英文；`GET /api/dsh-qwen-balance/overview?lang=zh|en` 可按单次请求覆盖。语言只影响文案，不影响字段名与数值。

### HTTP 接口

两个路由都**只允许环回**：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/dsh-qwen-balance/overview?lang=zh\|en` | 最近一次快照（还没有就触发一次抓取）；`cache-control: no-store`。 |
| `POST` | `/api/dsh-qwen-balance/refresh` | 立即探测一次后返回同一结构。其它方法返回 `405`。 |

非环回地址的请求一律 `403 {"ok":false,"error":"forbidden: loopback-only"}`。一个来源都没配置时，响应仍是 `200`，只是 `ok:false`、`rows` 为空、`notes` 里带一行配置引导。单个来源失败不会遮住其它来源：失败写进该来源的 `state`/`error`，并追加一条 note。

## 支持的数据来源细节

- **阿里云账户** —— BSS OpenAPI `QueryAccountBalance`，`Version=2017-12-14`，RPC 风格签名 V1.0（HMAC-SHA1），端点 `business.aliyuncs.com`（国际站 `business.ap-southeast-1.aliyuncs.com`）。
- **阿里云代金券** —— 同一端点上的 BSS OpenAPI `QueryCashCoupons`。该接口**没有**按券号过滤的参数，所以宿主列出接口返回的全部券，只把 `Status=Available` 的余额计入合计。每张券带券号、面额、余额、发放 / 生效 / 到期时间、适用产品与适用场景。
- **one-api / new-api 中转站** —— `GET /dashboard/billing/subscription` 取上限（`hard_limit_usd`），`GET /dashboard/billing/usage` 取消耗（`total_usage`，单位是**美分**，宿主会除以 100）；剩余 = 上限 − 消耗。`kind: auto` 会先试这一对端点。
- **DeepSeek 风格端点** —— `GET /user/balance` 的 `balance_infos[]`；宿主读取其中的余额与币种。`kind: auto` 在拿不到 dashboard 那一对时回落到它。
- **旧版 one-api** 对未知路由会回 `200` **加一个 HTML 页面**。宿主识别出非 JSON 响应体后，把该行标成错误，而不是把网页当数据解析。如果这类网关同时也没有 `/user/balance`，那它就是单纯没有可读的额度接口。

所有探测一律走 Node 的 `http`/`https` 模块且 `agent: false`；超时 15 秒；任何来源的异常都会被收敛成该来源的 `state:'error'` 加一句简短消息，绝不会冒泡成 500。

## 常见错误与对策

| 现象 | 可能原因 | 怎么办 |
| --- | --- | --- |
| `NotAuthorized` | RAM 策略里缺 `bss:DescribeCoupons` 和 / 或 `bss:DescribeAcccount`。 | 给该 RAM 用户挂 `AliyunBSSReadOnlyAccess`，或含这两个 action 的自定义策略。 |
| `InvalidAccessKeyId` / `SignatureDoesNotMatch` | AK ID 或 Secret 填错、复制时多带了空格或换行，或密钥已被删除。 | 重新复制；优先用环境变量或 AK 文件，不要用明文配置字段。 |
| `NotApplicable` | 当前调用身份不适用于该 BSS 操作。 | 改用主账号（root）AccessKey。 |
| 阿里云相关行超时或始终没有数据 | 端点与该账号所在站点不匹配。 | 国际站请用 `business.ap-southeast-1.aliyuncs.com`。 |
| 中转站行报错，原始响应看起来是一个网页 | 旧版 one-api 没有 billing 端点（它对未知路由回 `200` + HTML）。 | 若该网关支持 `/user/balance`，改用 `kind: user-balance`；否则它确实没有额度接口。 |
| 卡片只显示一行配置引导 | 一个来源都没配置（或全部被关掉）。 | 配置 AccessKey（环境变量 / AK 文件 / 插件配置），或添加一条 `gateways[]`。 |
| 侧栏里根本没有卡片 | 插件被停用、没装进当前 profile，或装完没有重启 `dsh web`。 | 检查 `enabled`、确认装进了正在运行的那个 profile、重启 `dsh web`，然后刷新页面。 |
| 控制台里 `sk-` 账单正常，代金券行却是空的 | 正常现象：代金券只能通过 BSS + AccessKey 看到。 | 配置一个带 `bss:DescribeCoupons` 的 AccessKey。 |

探测失败时卡片会保留上一次的数字并追加一行错误，因此临时断网不会让卡片变空白。

## 隐私与安全

- **密钥只留在宿主进程里。** AccessKey ID/Secret、STS Token、中转站 key 由宿主读取、用于发起请求，绝不会出现在响应 payload、日志行或错误消息里。
- **浏览器只拿到掩码后的 AccessKey ID** —— 12 位及以内取前 2 位加 `***`；更长的取前 6 位加 `...` 再加后 4 位（例如 `LTAI5t...EDaN`）。
- **HTTP 路由只允许环回。** `/api/dsh-qwen-balance/*` 对任何非环回请求回 `403`，局域网里的机器既读不到你的余额，也无法触发探测。
- **不采集任何数据，也不调第三方。** 插件只访问两类目标：你配置的阿里云 BSS 端点，以及你添加的 `gateways[]` 里的 `baseUrl`。除此之外不向任何地方上报。
- **不写磁盘**（默认没有缓存、没有台账、没有调试日志）。
- **把 AccessKey 当成账单凭据对待。** 它能读你的账单与代金券；请让它远离仓库、截图和聊天记录。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-qwen-balance
```

也可以在插件市场里卸载。之后重启 `dsh web` 以卸载宿主半；刷新页面后卡片消失。卸载不会动 AK 文件——如果你希望它一并消失，请自行删除 `%USERPROFILE%\.dsh\qwen-coupon.json`。

## 开发

```bash
node --test                 # 宿主侧单测：签名、金额解析、券筛选、网关降级、掩码
node tools/install-local.mjs --dry-run
```

没有打包器，也没有 React：宿主半是普通 ESM，浏览器半是用 `window.__ModuleLoader__.load` 包起来的单文件。接口契约见 [`docs/PLUGIN-SPEC.md`](docs/PLUGIN-SPEC.md)。

## 发行方式

v0.1.0 只从 GitHub 发布，**不发 npm**。[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 里的条目也是从本仓库安装。

## License

[MIT](LICENSE)