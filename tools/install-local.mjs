#!/usr/bin/env node
/**
 * dsh-qwen-balance — local install helper.
 *
 * Registers THIS checkout as a dsh plugin in a dedicated profile, then prints
 * the exact command that starts that profile's own web server.
 *
 *   node tools/install-local.mjs                 # profile "qwen-balance-test"
 *   node tools/install-local.mjs my-profile      # a profile of your choosing
 *   node tools/install-local.mjs --profile p     # same, flag form
 *   node tools/install-local.mjs --port 59421    # print a different port
 *   node tools/install-local.mjs --dry-run       # print the command, run nothing
 *
 * Zero dependencies. Node ^22.19.0 || >=24.0.0.
 *
 * The `desktop` profile is managed exclusively by the DeepSeek Harness desktop
 * application, so this script refuses it outright (the CLI refuses it too).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROFILE = 'qwen-balance-test';
const DEFAULT_PORT = 59420;
const FORBIDDEN_PROFILES = new Set(['desktop']);

/** Repository root = the parent of this script's directory. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `用法: node tools/install-local.mjs [profile] [选项]

  profile                 装进哪个 dsh profile（默认 ${DEFAULT_PROFILE}）
  --profile <name>        同上，flag 形式
  --port <number>         打印启动命令时使用的端口（默认 ${DEFAULT_PORT}）
  --dry-run               只打印将要执行的命令，不真的执行
  -h, --help              显示本帮助

本脚本会执行:
  dsh <profile> --from-default-profile web --dump-config   # profile 尚不存在时，用官方 web 模板建一个
  dsh plugin --profile <profile> add link:${PLUGIN_ROOT}

然后打印:
  启动：dsh <profile> --port <port>
`;

function fail(message) {
  process.stderr.write(`错误: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { profile: '', port: DEFAULT_PORT, dryRun: false, help: false };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--profile' || arg === '--port') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} 缺少取值`);
      i += 1;
      if (arg === '--profile') options.profile = value;
      else options.port = value;
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.slice('--profile='.length);
    } else if (arg.startsWith('--port=')) {
      options.port = arg.slice('--port='.length);
    } else if (arg.startsWith('-')) {
      fail(`未知选项 ${arg}（用 --help 查看用法）`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 1) fail(`只接受一个 profile 位置参数，收到 ${positionals.length} 个`);
  if (positionals.length === 1) {
    if (options.profile) fail('profile 给了两次（位置参数与 --profile）');
    options.profile = positionals[0];
  }

  return options;
}

/** Locate the dsh CLI: $DSH_CLI, then the npm global shim, then PATH. */
function findDshCli() {
  const isWindows = process.platform === 'win32';
  const shim = isWindows ? 'dsh.cmd' : 'dsh';
  const candidates = [];

  if (process.env.DSH_CLI) candidates.push({ path: process.env.DSH_CLI, explicit: true });

  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  candidates.push({ path: join(appData, 'npm', shim), explicit: false });
  candidates.push({ path: join(homedir(), '.local', 'bin', shim), explicit: false });
  candidates.push({ path: join(homedir(), 'AppData', 'Roaming', 'npm', shim), explicit: false });

  for (const candidate of candidates) {
    if (candidate.explicit) {
      if (existsSync(candidate.path)) return candidate.path;
      fail(`DSH_CLI 指向的文件不存在: ${candidate.path}`);
    }
    if (existsSync(candidate.path)) return candidate.path;
  }

  const probe = spawnSync(isWindows ? 'where' : 'which', [shim], { encoding: 'utf8' });
  const found = (probe.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (probe.status === 0 && found) return found;

  fail(
    `找不到 dsh CLI（找过 ${candidates.map((c) => c.path).join('、')}，以及 PATH 上的 ${shim}）。\n` +
      '       请安装 dsh，或用 DSH_CLI=/path/to/dsh 指定。',
  );
  return '';
}

/** Quote one argv element for a shell command line (Windows cmd needs this). */
function quoteArg(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

function formatCommand(command, args) {
  return [command, ...args].map(quoteArg).join(' ');
}

function runCommand(command, args, dryRun, options = {}) {
  if (dryRun) {
    process.stdout.write(`  [dry-run] ${formatCommand(command, args)}\n`);
    return 0;
  }
  // `quiet` still forwards stderr so a failure stays diagnosable.
  const stdio = options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit';
  // A .cmd shim needs cmd.exe. Passing ONE command line (instead of an args
  // array) is what keeps Node from emitting DEP0190 for shell: true.
  const result = process.platform === 'win32'
    ? spawnSync(formatCommand(command, args), { stdio, shell: true })
    : spawnSync(command, args, { stdio });
  if (result.error) fail(`执行失败: ${result.error.message}`);
  return result.status === null ? 1 : result.status;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (!options.profile) options.profile = DEFAULT_PROFILE;
const profile = options.profile.trim();
if (!profile) fail('profile 不能为空');

if (FORBIDDEN_PROFILES.has(profile.toLowerCase())) {
  fail(
    `profile "${profile}" 由 DeepSeek Harness 桌面应用独占管理，本脚本不会碰它。\n` +
      `       请换一个 profile，例如: node tools/install-local.mjs ${DEFAULT_PROFILE}`,
  );
}

const port = String(options.port ?? DEFAULT_PORT);
if (!/^\d+$/.test(port)) fail(`--port 必须是数字，收到 "${port}"`);

if (!existsSync(join(PLUGIN_ROOT, 'package.json'))) {
  fail(`${PLUGIN_ROOT} 下没有 package.json，看起来不是 dsh-qwen-balance 仓库根目录`);
}

const dshCli = findDshCli();
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profile);
const profileExists = existsSync(join(profileDir, 'package.json'));
const initArgs = [profile, '--from-default-profile', 'web', '--dump-config'];
const addArgs = ['plugin', '--profile', profile, 'add', `link:${PLUGIN_ROOT}`];

process.stdout.write(`dsh-qwen-balance 本地安装\n`);
process.stdout.write(`  插件目录 : ${PLUGIN_ROOT}\n`);
process.stdout.write(`  profile  : ${profile}${profileExists ? '（已存在）' : '（将用官方 web 模板新建）'}\n`);
process.stdout.write(`  dsh CLI  : ${dshCli}\n`);
if (options.dryRun) process.stdout.write('  模式     : dry-run（不执行任何命令）\n');
process.stdout.write('\n');

if (profileExists) {
  process.stdout.write('1) profile 已存在，跳过模板初始化\n');
} else {
  process.stdout.write('1) 用官方 web 模板新建该 profile（少了这层就没有 webServer，插件会一直 pending）\n');
  process.stdout.write('     （这一步会输出整棵配置树，已静音；失败时 stderr 仍会显示）\n');
  const initStatus = runCommand(dshCli, initArgs, options.dryRun, { quiet: true });
  if (initStatus !== 0) {
    fail(
      `初始化 profile 失败（退出码 ${initStatus}）。\n` +
        '       请换一个已存在的 web profile（例如 dsh web 用的那个），或用 --profile 指定。',
    );
  }
}

process.stdout.write('\n2) 把本仓库作为 link 插件装进该 profile\n');
const status = runCommand(dshCli, addArgs, options.dryRun);
if (status !== 0) {
  fail(`dsh plugin add 失败（退出码 ${status}）。`);
}

process.stdout.write('\n3) 启动该 profile 的 web 服务（宿主半需要它启动后才会注册路由）\n');
process.stdout.write(`启动：dsh ${profile} --port ${port}\n`);
process.stdout.write('　　　（dsh 会把 `<profile>` 当位置参数：是 `dsh <profile>`，不是 `dsh web --profile <profile>`）\n');
process.stdout.write('\n打开它打印的 http://127.0.0.1:' + port + '/?token=... 地址，刷新页面后侧栏出现余额卡片。\n');
process.stdout.write(`卸载: dsh plugin --profile ${profile} remove dsh-qwen-balance\n`);