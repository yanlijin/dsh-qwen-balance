# 收录 PR 物料：把 dsh-qwen-balance 提交到 awesome-dsh-plugin

本文档是**提交收录 PR 所需的全部物料与步骤**，不是自动化脚本。本仓库**不代提 PR**：下面第 4、5 步的 `git push` 与 PR 创建请由仓库维护者本人执行。

## 0. 前置条件

- 本插件已推到 GitHub，仓库名 `dsh-qwen-balance`，默认分支 `main`。
- 本仓库已把 `registry/dsh-qwen-balance.yml` 里的账号填成 `yanlijin`；若你是 fork 后以自己的账号发布，请把本文件与那份 yml 里的 `yanlijin` 全部替换成你的账号。
- 分类选 `usage`（目录里的标题是 "Usage & Billing" / "用量与计费"）。分类键必须取目录已有的那一组，`usage` 是其中之一——不能自造。
- 收录条目只指向 GitHub 仓库，目录不代管代码，所以提交前请确认仓库里 `lib/`、`cordis.patch.yml`、`README.md`、`README.zh.md`、`LICENSE` 都已推送。

## 1. Fork 并克隆

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git switch -c add-dsh-qwen-balance
```

没有 `gh` 就在网页上点 Fork，再手动 clone 自己的 fork。

## 2. 新增一个目录数据文件

- 路径：`data/plugins/yanlijin__dsh-qwen-balance.yml`
- 命名规则：`<owner>__<repo>.yml`，owner 与 repo 之间是**两个下划线**（同名仓库靠 owner 前缀区分）。现有条目就是这么命名的，例如 `data/plugins/2768651338__dsh-effort-slider.yml`。
- 内容：把本仓库 `registry/dsh-qwen-balance.yml` 的原文复制过去（账号已填好 `yanlijin`，无需再改），其余字段一字不改。

字段含义：

| 字段 | 本插件的值 | 说明 |
| --- | --- | --- |
| `url` | `https://github.com/yanlijin/dsh-qwen-balance` | 仓库地址；不带 `.git`、不带分支或路径 |
| `name` | `yanlijin/dsh-qwen-balance` | `owner/repo` 形式，与文件名保持一致 |
| `category` | `usage` | 必须是目录已有的分类键 |
| `description.en` | 见 yml | 单引号包起来的单段文本 |
| `description.zh` | 见 yml | 同上；中英两条内容对等 |

写好的文件内容（已按 `yanlijin` 填好）：

```yaml
url: https://github.com/yanlijin/dsh-qwen-balance
name: yanlijin/dsh-qwen-balance
category: usage
description:
  en: 'Alibaba Cloud / Qwen balance card above the Settings row in the DSH web sidebar: account available and cash balance, coupon balances with expiry dates (student vouchers included) read through the BSS OpenAPI, and OpenAI-compatible relay quota. An official DashScope sk- key has no balance endpoint at all, so real money and coupons require an Alibaba Cloud AccessKey with bss:DescribeCoupons + bss:DescribeAcccount (AliyunBSSReadOnlyAccess is enough); secrets stay in the host process, the browser only sees a masked AccessKey ID, and /api/dsh-qwen-balance/* is loopback-only.'
  zh: 'DSH Web 侧栏「设置」行上方的阿里云 / Qwen 余额卡片：经 BSS OpenAPI 显示账户可用额度与现金余额、代金券余额与到期日（含学生 300 元券），以及 OpenAI 兼容中转站额度。官方百炼 / DashScope 的 sk- key 没有任何余额接口，想看真金白银与代金券必须用带 bss:DescribeCoupons + bss:DescribeAcccount（建议只挂 AliyunBSSReadOnlyAccess）的阿里云 AccessKey；密钥只留在宿主进程，浏览器只拿到掩码后的 AccessKey ID，/api/dsh-qwen-balance/* 仅允许环回访问。'
```

## 3. 提交前自检

- [ ] 文件名是 `yanlijin__dsh-qwen-balance.yml`，落在 `data/plugins/` 下，owner 前缀与 `url` 里的 owner 一致。
- [ ] YAML 能被解析：两空格缩进、没有 Tab、`description` 下只有 `en` / `zh` 两个键。
- [ ] 全文没有残留的 `OWNER` 占位符（本仓库已填 `yanlijin`）。
- [ ] `url` 用浏览器打开可访问，仓库是 public。
- [ ] 描述里没有 URL、没有 emoji、没有裸英文撇号（单引号字符串里出现撇号会让 YAML 解析失败）。
- [ ] 描述不吹能力：已写明「官方 DashScope `sk-` key 没有任何余额接口，额度与代金券要走 BSS + AccessKey」。
- [ ] `git status` / `git diff --stat` 只多出这一个新文件，没有顺带改动别人的条目。

## 4. 提交并推送

```bash
git add data/plugins/yanlijin__dsh-qwen-balance.yml
git commit -m "Add dsh-qwen-balance plugin"
git push -u origin add-dsh-qwen-balance
```

## 5. 打开 PR

- base 仓库 / 分支：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `main`
- head：`<你的账号>:add-dsh-qwen-balance`
- 标题与正文用下面的草稿（正文为英文，标题为英文）。

**标题**

```
Add dsh-qwen-balance — Alibaba Cloud / Qwen balance card for the DSH web sidebar
```

**正文**

```
## What does this plugin do?

`dsh-qwen-balance` puts one compact card directly above the Settings row in the
DSH web sidebar and shows three things:

- Alibaba Cloud account available amount (可用额度) and cash balance, read with
  BSS OpenAPI `QueryAccountBalance`;
- Alibaba Cloud coupon balances with expiry dates and coupon numbers, read with
  BSS OpenAPI `QueryCashCoupons` — this is where a student voucher (for example
  the ¥300 one) shows up;
- remaining quota of one or more OpenAI-compatible relays (new-api / one-api
  `/dashboard/billing/*`, or a DeepSeek-style `GET /user/balance`).

## Honest limitations

An official Model Studio (Bailian) / DashScope `sk-` API key exposes **no
balance or quota endpoint at all**. Real money and real coupons are only visible
through the Alibaba Cloud BSS OpenAPI, which requires an AccessKey with
`bss:DescribeCoupons` + `bss:DescribeAcccount` (`AliyunBSSReadOnlyAccess` is the
smallest useful grant). Without an AccessKey the Alibaba Cloud and coupon rows
stay empty by design and the card says why.

## Install

From GitHub:

    dsh plugin --profile <profile> add github:yanlijin/dsh-qwen-balance

Or from a local checkout:

    dsh qwen-balance-test --from-default-profile web --dump-config
    dsh plugin --profile qwen-balance-test add link:/path/to/dsh-qwen-balance
    dsh qwen-balance-test --port 59420 --no-open

The profile name is a positional argument (`dsh <profile>`); `dsh web` boots the shipped profile literally named `web`.

The bundled `cordis.patch.yml` inserts the plugin row; there is no build step.

## Dependencies

- DSH `>=0.2.0-rc.2`, Node `^22.19.0 || >=24.0.0`.
- One runtime dependency: `@deepseek-ai/schemastery`.
- All probing uses Node's built-in `http`/`https` with `agent: false`; nothing
  else is required.

## Privacy statement

- AccessKey ID/secret, STS token and relay keys are read and used inside the
  host process only; they never appear in a response payload, a log line or an
  error message.
- The browser only receives a masked AccessKey ID (for example `LTAI5t...EDaN`).
- `/api/dsh-qwen-balance/overview` and `/api/dsh-qwen-balance/refresh` are
  loopback-only and answer `403` to any non-loopback request.
- No telemetry and no third-party calls: the plugin contacts only the Alibaba
  Cloud BSS endpoint the user configures and the relay `baseUrl` entries the
  user adds. Nothing is written to disk.

## License

MIT.

## Checklist

- [x] Repository is public and contains `lib/`, `cordis.patch.yml`, `README.md`,
      `README.zh.md`, `LICENSE`, `tools/install-local.mjs`.
- [x] Bilingual README, content equivalent.
- [x] No telemetry, no data collection, loopback-only HTTP surface.
```

## 6. 合并之后

- 目录索引 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 会带上这个条目。用户侧的启用路径是：**Plugins → Experimental plugins 旁的 More → 打开 Custom plugin markets**，然后在出现的 **Discover** 页签里 **Add index source** 填入该地址，再搜索 `dsh-qwen-balance`。
- 按现有条目的规律，站点详情页形如 `https://awesome-dsh-plugin.com/p/yanlijin/dsh-qwen-balance/`（具体以其构建结果为准）。
- 收录后请顺手回本插件 README 的「从插件市场安装」一节确认措辞仍然成立。

## 7. 已知风险与备选做法

- **目录当前收录的是 npm 来源的版本。** 现有 `data/plugins/*.yml` 的 `url` 字段指向仓库，但索引里对应的 `versions[].source` 基本是 `{"type":"npm"}`。本插件 v0.1.0 只从 GitHub 发布，若维护者要求 npm 源，两条路：先把包发到 npm（`npm publish`，`files` 已限定 `lib` / `cordis.patch.yml` / `docs` / `tools`），或在 PR 里说明并请求以 git 源收录（索引格式本身支持 `{"type":"git","url":…,"commit":…}`，但目录是否接受由维护者决定）。
- **只在被要求时改别人已有的条目。** 若目录里已存在别的余额类条目，不要顺手改它，PR 只新增一个文件。
- **不要代提 PR。** 本仓库只准备物料，`git push` 与 PR 创建由维护者本人执行。