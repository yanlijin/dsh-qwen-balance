# dsh-qwen-balance

[English](README.md) | [中文](README.zh.md)

<p align="center">
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
  &nbsp;
  <img src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-339933?style=flat-square" alt="Node">
</p>

<p align="center">
  <strong>Alibaba Cloud / Qwen balance card in the DeepSeek Harness (DSH) web sidebar</strong><br>
  <em>Account available and cash balance · coupons (student voucher) balance and expiry · OpenAI-compatible relay quota</em>
</p>

`dsh-qwen-balance` inserts one compact card directly **above the Settings row** in the DSH Web GUI sidebar. A host-side poller measures the sources you configure; the card renders what the host measured and nothing else. The browser never talks to Alibaba Cloud or to a relay, and never sees a secret.

## Screenshot

<!-- Screenshot placeholder: `docs/screenshot.png` has not been captured yet.
     Do not add an <img> tag that points at it until the file exists in this repository. -->

> 📷 **Screenshot placeholder** — the sidebar card (collapsed summary and expanded rows) will be inserted here once `docs/screenshot.png` is captured. Until that file exists in this repository, this README intentionally contains no image reference for it.

## What it shows

| Source | What the card shows | How the host reads it |
| --- | --- | --- |
| **Alibaba Cloud account** | Available amount (可用额度), cash balance, credit amount, currency | BSS OpenAPI `QueryAccountBalance` |
| **Alibaba Cloud coupons** | Total available coupon balance and count; one row per coupon with balance, expiry date and coupon number | BSS OpenAPI `QueryCashCoupons` |
| **Relay / gateway** (0..N) | Remaining quota, plus total/used when the gateway reports them | `GET /dashboard/billing/subscription` + `GET /dashboard/billing/usage`, or `GET /user/balance` |

With nothing configured the card shows a single configuration hint instead of an error.

### The honest part: a DashScope `sk-` key has no balance API

**An official Model Studio (Bailian) / DashScope `sk-` API key has no balance or quota endpoint at all.** There is no documented call that returns the balance of such a key, and the Qwen CLI's OAuth session only exposes usage/quota commands — it has no coupon command either.

So this plugin never asks for your DashScope key. To see real money and real coupons — the cash balance, and a coupon such as the **¥300 student voucher** — it calls the Alibaba Cloud **BSS OpenAPI**, which requires an **AccessKey** (an `LTAI...` key pair, not an `sk-` key). Without an AccessKey the Alibaba Cloud and coupon rows stay empty by design, and the card says so.

## Install

Requirements: DSH `0.2.0-rc.2` or newer, Node `^22.19.0 || >=24.0.0`. There is no build step: `lib/` ships runnable JavaScript, so installing does not compile anything.

### From the plugin market (after this plugin is listed)

DSH ships no index source, and the Discover tab is part of an experimental bundle:

1. Open **Plugins**, select **More** beside **Experimental plugins**, and switch on **Custom plugin markets**. A **Discover** tab then appears next to **Installed**.
2. In **Discover**, choose **Add index source** and enter the community catalog `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`.
3. Search for `dsh-qwen-balance` and confirm the install. The confirmation shows the exact source that will be installed; each index source belongs to the current profile.

[dsh-market](https://github.com/dsh-market/dsh-market) is a visual market that bundles the same list and can be installed with `dsh plugin --profile <profile> add dshmarket`.

> That community catalog currently lists **npm-sourced** versions. v0.1.0 of this plugin ships from GitHub only and is **not published to npm**, so until the entry lands (or if your index source offers an npm install only) use the GitHub command below.

### From GitHub

```bash
dsh plugin --profile <profile> add github:yanlijin/dsh-qwen-balance
```

That command installs the plugin from `github.com/yanlijin/dsh-qwen-balance`; swap `yanlijin` for your own account if you install from a fork.

### From a local checkout (development)

```bash
# 1) create a web-capable profile (skip if it exists; without the web layer the plugin stays pending)
dsh qwen-balance-test --from-default-profile web --dump-config

# 2) install this checkout into that profile
dsh plugin --profile qwen-balance-test add link:E:\sings\plugins\dsh-qwen-balance

# 3) start it: the profile name is a positional — `dsh <profile>`, not `dsh web --profile <profile>`
dsh qwen-balance-test --port 59420 --no-open
```

`tools/install-local.mjs` does those three steps for you (creating the profile from the shipped web template when needed) and prints the exact start command:

```bash
node tools/install-local.mjs                 # installs into the profile "qwen-balance-test"
node tools/install-local.mjs my-profile      # or a profile you name
node tools/install-local.mjs --dry-run       # print the command without running it
```

### What a "profile" is

A DSH **profile** is a named installation under `%USERPROFILE%\.dsh\profiles\<name>` with its own plugin set, configuration and sessions. Plugins are installed per profile, so a plugin only appears in the profile you added it to.

The **`desktop` profile is managed exclusively by the DeepSeek Harness desktop application** — the CLI refuses to touch it (`error: profile "desktop" is managed exclusively by the Electron application`), and the desktop app owns its plugin list. `tools/install-local.mjs` refuses that profile name for the same reason. To try a plugin, create a separate profile (for example `qwen-balance-test`), install there, and start its own web server with `dsh <profile> --port <port>`.

> **Gotcha:** `dsh plugin --profile <new-name> add ...` does create the profile, but with only the `@deepseek-ai/dsh-base` bundle — **no webServer**. `dsh <profile>` then serves no HTTP at all and the plugin sits at `pending (waiting for service: webServer)`. Create the profile with `--from-default-profile web` before adding the plugin.

A newly installed **host** half needs the `dsh web` process to be started (or restarted) before its routes exist; the **browser** half appears after a page refresh. Installing the package is enough — the bundled `cordis.patch.yml` inserts the plugin row into the web plugin roster.

## Configuration

Open the plugin's settings in the DSH Web GUI. The form is generated from the plugin's config schema.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When off, nothing is probed and no route is registered. |
| `pollIntervalSec` | `60` | Host-side probe interval in seconds (30–3600). |
| `showCoupons` | `true` | Show the coupon rows. |
| `showGateways` | `true` | Show the relay/gateway rows. |
| `aliyun.enabled` | `true` | Probe Alibaba Cloud BSS (account balance and coupons). |
| `aliyun.endpoint` | `""` | Empty = `business.aliyuncs.com` (China site). International site: `business.ap-southeast-1.aliyuncs.com`. |
| `aliyun.akId` | `""` | AccessKey ID, plaintext fallback only — see below. |
| `aliyun.akSecret` | `""` | AccessKey secret, plaintext fallback only — **insecure**, see below. |
| `aliyun.useAkFile` | `true` | Allow reading the AK file. |
| `aliyun.akFile` | `""` | Empty = `%USERPROFILE%\.dsh\qwen-coupon.json`. |
| `gateways[]` | `[]` | Relay / gateway definitions (see below). |

Each `gateways[]` entry:

| Field | Meaning |
| --- | --- |
| `name` | Label shown on the row (defaults to a generic "relay" label when empty). |
| `baseUrl` | Base URL of the OpenAI-compatible relay, for example `https://relay.example.com`. |
| `apiKey` | Key sent to that relay, plaintext. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | Name of an environment variable the host reads the key from, for example `RELAY_API_KEY`. |
| `kind` | `auto` (default), `newapi` (one-api / new-api billing endpoints), or `user-balance` (DeepSeek-style `GET /user/balance`). |

## Alibaba Cloud AccessKey: three sources, one priority

The host resolves the AccessKey in this order and uses the first source that yields a pair:

1. **Environment variables** (recommended for a server or a shell profile)

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `ALIYUN_AK_ID` | yes | AccessKey ID |
   | `ALIYUN_AK_SECRET` | yes | AccessKey secret |
   | `ALIYUN_STS_TOKEN` | no | STS token, for temporary credentials |
   | `ALIYUN_BSS_ENDPOINT` | no | BSS endpoint; the international site uses `business.ap-southeast-1.aliyuncs.com` |

   `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` and `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` are accepted as aliases, and `ALIBABA_CLOUD_SECURITY_TOKEN` as the STS alias.

2. **The AK file** — `%USERPROFILE%\.dsh\qwen-coupon.json` by default (`aliyun.akFile` overrides the path, `aliyun.useAkFile: false` disables it):

   ```json
   {
     "aliyunAkId": "LTAI5t...",
     "aliyunAkSecret": "...",
     "aliyunStsToken": "",
     "bssEndpoint": ""
   }
   ```

   `.gitignore` in this repository ignores `qwen-coupon.json`, and the file lives outside the repository anyway. Keep it readable only by your own user account.

3. **The plugin configuration** (`aliyun.akId` / `aliyun.akSecret`) — **last resort only.** These values are stored as plaintext in the profile's plugin configuration, so anyone who can read your home directory can read the key. Use source 1 or 2 whenever you can; only fall back to 3 when neither is available to you.

### Which permissions the AccessKey needs

| Call | Permission |
| --- | --- |
| `QueryAccountBalance` (available / cash / credit) | `bss:DescribeAcccount` |
| `QueryCashCoupons` (coupons and their balances) | `bss:DescribeCoupons` |

Create a **RAM user** and attach the read-only managed policy **`AliyunBSSReadOnlyAccess`**; that is the smallest useful grant here. Do not grant anything else, and do not put an administrator AccessKey in a config file. If the BSS API answers `NotApplicable` for that RAM identity, the account type cannot call it that way — retry with the primary-account (root) AccessKey, which is the one case where the root key is the answer.

Coupons and account balance are **two different numbers**. Alibaba Cloud documents that the available amount (可用额度) does **not** include coupons or stored-value cards, so the coupon row never claims to be part of the account balance.

### International site

If your account is on the Alibaba Cloud international site, set the endpoint to `business.ap-southeast-1.aliyuncs.com` (`ALIYUN_BSS_ENDPOINT`, the `bssEndpoint` key in the AK file, or `aliyun.endpoint` in the plugin config). Calling the China-site endpoint from an international account typically ends in a timeout rather than a clear error message.

## Card fields

The host exposes one snapshot as JSON; the card renders it. **Since v0.1.1 the card starts expanded**: the detail rows are on screen from the first render, with no click needed. Clicking the card collapses it, clicking again expands it — and every expand forces a fresh probe.

| Field | Example | Meaning |
| --- | --- | --- |
| `summary.label` / `.value` / `.sub` | `阿里云` / `¥263.66` / `代金券可用` | The headline the collapsed card shows, plus a short qualifier. |
| `coupon.total` | `¥263.66` | Sum of the balances of all **Available** coupons, with the coupon count. Independent of the account's available amount. |
| `coupon.<number>` | `¥263.66 · expires 2027-10-20` | One row per **Available** coupon, keyed by the coupon number the API returns (for example `coupon.923898490070`), up to five rows; if the API omits the number the key falls back to `coupon.item`. |
| `aliyun.available` | `¥0.01` | Account available amount (可用额度). |
| `aliyun.cash` | `¥0.01` | Cash balance. |
| `aliyun.credit` | `¥0.00` | Credit amount (信控额度). |
| `<gateway>.remaining` | `$7.66` | Remaining relay quota; when the gateway reports them you also get `<gateway>.used`, `<gateway>.total` and `<gateway>.balance` rows. Gateways are keyed by their `id` — `gw1`, `gw2`, … by default. |
| `notes` | — | Localized guidance and error lines, for example "no AccessKey configured". |

Row keys are stable; the visible `label` text follows the requested language. The full snapshot also carries a `sources` block with each source's `state` (`ok` / `off` / `error`), its error message, the raw numbers, and the **masked** AccessKey ID (for example `LTAI5t...EDaN`). Numbers are `number | null` — never `undefined`.

### Polling and language

- The **host** probes every `pollIntervalSec` seconds (default 60; allowed range 30–3600).
- The **card** refreshes from the host every 30 seconds while the tab is visible, pauses while `document.hidden`, and forces a fresh probe (`POST /refresh`) on every expand — including its first render in v0.1.1.
- **Language**: Chinese when `navigator.language` starts with `zh`, otherwise English. `GET /api/dsh-qwen-balance/overview?lang=zh|en` overrides it per request. Only labels change — field names and numbers do not.

### HTTP surface

All three routes are **loopback-only**:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/dsh-qwen-balance/overview?lang=zh\|en` | Latest snapshot (probing once if there is none yet); `cache-control: no-store`; carries the `client` self-report block. |
| `POST` | `/api/dsh-qwen-balance/refresh` | Probe now, then return the same structure. Any other method gets `405`. |
| `POST` | `/api/dsh-qwen-balance/client-report` | **v0.1.1 diagnostics**: the card reports its own mount state; body capped at 2 KB; `200 {"ok":true}` on success. |

`overview.client` is the last self-report the host recorded (`null` means the card never reported):
`{ state, seat:{sidebar,foot,settings,usedFallback}, rows, expanded, error, at }`, where `at` is stamped by the host and cannot be forged by the client.
An unusable body gets `400`, an oversized one `413`, a non-`POST` `405`. The endpoint exists only to answer "did the card actually mount, and does it react to clicks"; it collects no user data.

A request from a non-loopback address gets `403 {"ok":false,"error":"forbidden: loopback-only"}`. When no source is configured the response is still `200`, with `ok:false`, empty `rows` and a guidance line in `notes`. One failing source never hides the others: the failure is recorded in that source's `state`/`error` plus one note line.

## Supported data sources in detail

- **Alibaba Cloud account** — BSS OpenAPI `QueryAccountBalance`, `Version=2017-12-14`, RPC-style signature V1.0 (HMAC-SHA1), host endpoint `business.aliyuncs.com` (international: `business.ap-southeast-1.aliyuncs.com`).
- **Alibaba Cloud coupons** — BSS OpenAPI `QueryCashCoupons` on the same endpoint. The API has no parameter to filter by coupon number, so the host lists the coupons the API returns and counts only `Status=Available` balances into the total. Each coupon carries its number, nominal value, balance, grant/effective/expiry times, applicable products and applicable scenarios.
- **one-api / new-api relays** — `GET /dashboard/billing/subscription` for the limit (`hard_limit_usd`) and `GET /dashboard/billing/usage` for consumption (`total_usage`, reported in **cents**, so the host divides by 100); remaining = limit − usage. `kind: auto` tries this pair first.
- **DeepSeek-style endpoints** — `GET /user/balance` with `balance_infos[]`; the host reads the reported balance and currency. `kind: auto` falls back to this endpoint when the dashboard pair is unavailable.
- **Old one-api builds** answer an unknown route with `200` **and an HTML page**. The host detects a non-JSON body and reports an error on that row instead of parsing the page as data. If such a gateway also lacks `/user/balance`, it simply has no quota API to read.

All probing uses Node's `http`/`https` modules with `agent: false`; the timeout is 15 seconds, and any source error is captured as that source's `state:'error'` with a short message — it never becomes a 500.

## Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| `NotAuthorized` | The RAM policy is missing `bss:DescribeCoupons` and/or `bss:DescribeAcccount`. | Attach `AliyunBSSReadOnlyAccess` to the RAM user, or a custom policy containing both actions. |
| `InvalidAccessKeyId` / `SignatureDoesNotMatch` | Wrong AccessKey ID or secret, a stray space or newline from copy-paste, or a deleted key. | Re-copy the pair; prefer the environment variable or the AK file over the plaintext config field. |
| `NotApplicable` | The calling identity is not applicable for this BSS operation. | Retry with the primary-account (root) AccessKey. |
| Alibaba Cloud rows time out, or never return data | The endpoint does not match the account's site. | Use `business.ap-southeast-1.aliyuncs.com` for the international site. |
| A gateway row shows an error and the raw response looks like a web page | An old one-api build without the billing endpoints (it answers `200` + HTML). | Use `kind: user-balance` if that gateway supports `/user/balance`; otherwise it has no quota endpoint. |
| The card shows only a configuration hint | No source is configured (or all are disabled). | Set an AccessKey (environment variable, AK file, or config) or add a `gateways[]` entry. |
| No card in the sidebar | The plugin is disabled, not installed in this profile, or `dsh web` was not restarted after install. | Check `enabled`, check that you added the plugin to the profile you are running, restart `dsh web`, then refresh the page. |
| The card is visible but **clicking it does nothing** | v0.1.0's click handler fired `GET /refresh` first, while the host only accepts `POST` (GET returns `405`) — so "click to expand" looked completely dead. | Upgrade to **v0.1.1** (starts expanded, clicks use `POST /refresh`). If it still misbehaves, read the `client` block in `GET /api/dsh-qwen-balance/overview`: it records the card's self-reported mount, seat, row count and expanded state. |
| Coupon row is empty although `sk-` billing works in the console | Expected: coupons are only visible through BSS + AccessKey. | Configure an AccessKey with `bss:DescribeCoupons`. |

Failed probes keep the previous numbers on screen and add an error row, so a temporary network problem does not blank the card.

## Privacy and security

- **Secrets stay in the host process.** AccessKey ID/secret, STS token and relay keys are read by the host, used for the outbound request, and never placed in a response payload, a log line or an error message.
- **The browser only ever receives a masked AccessKey ID** — for IDs of 12 characters or fewer the first 2 characters followed by `***`, for longer IDs the first 6 followed by `...` and the last 4 (for example `LTAI5t...EDaN`).
- **The HTTP routes are loopback-only.** `/api/dsh-qwen-balance/*` answers `403` to any non-loopback request, so a LAN peer cannot read your balance or trigger probes.
- **No telemetry, no third-party calls.** The plugin contacts exactly two kinds of destination: the Alibaba Cloud BSS endpoint you configured and the relay `baseUrl` entries you added. It reports nothing anywhere else.
- **Nothing is written to disk** (no cache, no ledger, no debug log by default).
- **Treat the AccessKey as a billing credential.** It can read your bills and coupons; keep it out of the repository, out of screenshots, and out of chat logs.

## Uninstall

```bash
dsh plugin --profile <profile> remove dsh-qwen-balance
```

Or uninstall it from the plugin market. Restart `dsh web` afterwards so the host half is unloaded; the card disappears after a page refresh. Removing the plugin does not touch the AK file — delete `%USERPROFILE%\.dsh\qwen-coupon.json` yourself if you want it gone.

## Development

```bash
node --test                 # host-side unit tests (signature, amount parsing, coupon filtering, gateway fallback, masking)
node tools/install-local.mjs --dry-run
```

There is no bundler and no React: the host half is plain ESM, the browser half is a single file wrapped in `window.__ModuleLoader__.load`. The interface contract lives in [`docs/PLUGIN-SPEC.md`](docs/PLUGIN-SPEC.md).

## Distribution

v0.1.0 ships from GitHub only — it is not published to npm. The entry in [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) installs from this repository.

## License

[MIT](LICENSE)