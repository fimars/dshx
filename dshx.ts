#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-sys --allow-read --allow-write
/**
 * dshx — 极简启动器 for DeepSeek Harness CLI。
 *
 * 用法：
 *   dshx                     按 ~/.dshx/config.json 记录的来源启动 dsh
 *   dshx use default         记录为官方 npm 版（@deepseek-ai/dsh），启动走全局 dsh
 *   dshx use <owner>/<repo>  记录为 GitHub 源码版，repo 克隆到 ~/.dshx/repos/<owner>/<repo>
 *                            （也接受完整 GitHub URL / .git 后缀）
 *   dshx use                 查看当前记录与已管理的 repo
 *
 * 启动逻辑：
 *   - default (npm)：本地版本 vs registry 最新版本，有更新时提示，随后 `dsh web ...`
 *   - github (源码)：每次启动前 fetch 上游并快进；上游重写了历史（amend / force-push）
 *     导致无法快进时，工作区没有未提交改动就直接对齐上游。HEAD 有变化（或从未构建）时
 *     执行 `pnpm install && pnpm run clean && pnpm run build`，然后 `pnpm dsh web ...`；
 *     同步失败仅警告，不阻塞启动（下次启动再试）。
 *
 * 状态：
 *   ~/.dshx/config.json        当前使用来源
 *   ~/.dshx/repos/<o>/<r>/     GitHub 源码版的工作副本（含构建产物）
 */
import { Select } from "@cliffy/prompt";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG = "@deepseek-ai/dsh";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PKG}/latest`;

const DSHX_DIR = join(homedir(), ".dshx");
const REPOS_DIR = join(DSHX_DIR, "repos");
const CONFIG_PATH = join(DSHX_DIR, "config.json");

const GIT_TIMEOUT_MS = 60_000;

type Config = { source: "default" } | { source: "github"; repo: string };

// ---------- 配置 ----------

function isValidRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

/** 归一化用户输入为 owner/repo（接受完整 GitHub URL / git@ / .git 后缀）。 */
function normalizeRepo(input: string): string | null {
  const s = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return isValidRepo(s) ? s : null;
}

function loadConfig(): Config {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(CONFIG_PATH));
    if (
      raw?.source === "github" && typeof raw.repo === "string" &&
      isValidRepo(raw.repo)
    ) {
      return { source: "github", repo: raw.repo };
    }
  } catch {
    // 不存在或损坏 → 默认官方版
  }
  return { source: "default" };
}

function saveConfig(cfg: Config): void {
  Deno.mkdirSync(DSHX_DIR, { recursive: true });
  Deno.writeTextFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return join(REPOS_DIR, owner, name);
}

// ---------- 命令执行 ----------

interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
}

/** 前台执行命令（继承 stdio），返回是否成功。 */
async function run(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<boolean> {
  try {
    const child = new Deno.Command(cmd, {
      args,
      cwd: opts.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    return status.code === 0;
  } catch {
    return false;
  }
}

/** 执行命令并捕获输出；找不到命令、超时或出错返回 null。 */
async function capture(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<{ code: number; stdout: string; stderr: string } | null> {
  try {
    const child = new Deno.Command(cmd, {
      args,
      cwd: opts.cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (opts.timeoutMs !== undefined) {
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }, opts.timeoutMs).unref();
    }
    const out = await child.output();
    if (out.signal !== null && out.signal !== undefined) return null; // 被超时杀掉
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch {
    return null;
  }
}

// ---------- GitHub 源码版管理 ----------

/** 取多行输出的最后一行非空内容。 */
function lastLine(text: string | undefined): string {
  return (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
    .at(-1) ?? "";
}

/** 在 dir 内执行 git 子命令并丢弃输出，返回是否成功。 */
async function gitOk(dir: string, args: string[]): Promise<boolean> {
  const r = await capture("git", args, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  return r?.code === 0;
}

async function gitShortRev(
  dir: string,
  rev = "HEAD",
): Promise<string | null> {
  const r = await capture("git", ["rev-parse", "--short", rev], {
    cwd: dir,
    timeoutMs: 10_000,
  });
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

/** 确保repo 已克隆到 ~/.dshx/repos/，返回本地路径。失败直接退出。 */
async function ensureRepo(repo: string): Promise<string> {
  const dir = repoPath(repo);
  try {
    await Deno.stat(join(dir, ".git"));
    return dir; // 已存在
  } catch {
    // 需要克隆
  }
  Deno.mkdirSync(join(REPOS_DIR, repo.split("/")[0]), { recursive: true });
  console.error(`dshx: 克隆 https://github.com/${repo}.git → ${dir} …`);
  const ok = await run("git", [
    "clone",
    "--depth",
    "1",
    `https://github.com/${repo}.git`,
    dir,
  ]);
  if (!ok) {
    console.error(
      `dshx: 克隆失败（网络？），可稍后重试或手动执行：\n  git clone --depth 1 https://github.com/${repo}.git ${dir}`,
    );
    Deno.exit(1);
  }
  return dir;
}

type SyncOutcome =
  | { status: "current"; head: string | null }
  | { status: "updated"; head: string | null; resynced: boolean }
  | { status: "failed"; head: string | null; reason: string };

/** 上游引用名（如 origin/shiguredo）；未配置上游时回退 origin/HEAD。 */
async function upstreamRef(dir: string): Promise<string> {
  const r = await capture(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd: dir, timeoutMs: 10_000 },
  );
  const ref = r?.code === 0 ? r.stdout.trim() : "";
  return ref === "" || ref === "@{u}" ? "origin/HEAD" : ref;
}

/** 同步上游最新代码，返回结果供调用方如实报告。 */
async function syncRepo(dir: string): Promise<SyncOutcome> {
  const before = await gitShortRev(dir);
  if (before === null) {
    return { status: "failed", head: null, reason: "不是 git 仓库" };
  }

  // 普通 fetch（不带 --depth）会沿本地已有的 shallow 边界补足到上游最新，
  // 只传输增量且保持快进能力；--depth 1 反而会把新提交记成孤立根，永远无法快进。
  const fetch = await capture("git", ["fetch", "origin"], {
    cwd: dir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (fetch === null || fetch.code !== 0) {
    return {
      status: "failed",
      head: before,
      reason: lastLine(fetch?.stderr) || "拉取超时或 git 不可用",
    };
  }

  const target = await upstreamRef(dir);
  const tip = await gitShortRev(dir, target);
  if (tip === null) {
    return { status: "failed", head: before, reason: `无法解析上游 ${target}` };
  }
  if (tip === before) return { status: "current", head: before };

  // 快进成功且 HEAD 真的移动了才是更新；HEAD 未动说明本地本来就包含上游最新提交
  // （例如本地多一个提交），不用也不该动工作区。
  if (await gitOk(dir, ["merge", "--ff-only", target])) {
    const head = (await gitShortRev(dir)) ?? before;
    return head === before
      ? { status: "current", head: before }
      : { status: "updated", head, resynced: false };
  }

  // 无法快进：上游重写了历史，或者本地基于旧提交另有提交。dshx 的检出只用于构建，
  // 没有值得保留的本地提交，所以没有改动过的跟踪文件就直接对齐上游；有则原样保留。
  // 只看跟踪文件：构建产物（node_modules、lib 等）本来就是 dshx 自己产生的。
  const modified = await capture(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: dir, timeoutMs: 30_000 },
  );
  if (modified === null || modified.stdout.trim() !== "") {
    return {
      status: "failed",
      head: before,
      reason: `无法快进，且 ${dir} 有未提交改动，未同步`,
    };
  }
  if (!await gitOk(dir, ["reset", "--hard", target])) {
    return { status: "failed", head: before, reason: `对齐 ${target} 失败` };
  }
  return { status: "updated", head: tip, resynced: true };
}

/** HEAD 变化或从未构建时，执行 pnpm install + pnpm run build。 */
async function ensureBuilt(dir: string, head: string | null): Promise<void> {
  const marker = join(dir, "node_modules", ".dshx-built");
  let builtAt: string | null = null;
  try {
    builtAt = (await Deno.readTextFile(marker)).trim();
  } catch {
    // 未构建
  }
  if (head !== null && builtAt === head) return;

  console.error("dshx: 需要构建（首次使用或代码有更新）→ pnpm install …");
  if (!(await run("pnpm", ["install"], { cwd: dir }))) {
    console.error("dshx: pnpm install 失败，无法启动。");
    Deno.exit(1);
  }
  // 上一次构建的 lib/ 等产物会按旧代码解析跨包导出，掩盖住当前代码的真实导出，
  // 因此每次都先清掉仓库自己的构建输出再构建。
  console.error("dshx: pnpm run clean …");
  if (!(await run("pnpm", ["run", "clean"], { cwd: dir }))) {
    console.error("dshx: pnpm run clean 失败，无法启动。");
    Deno.exit(1);
  }
  console.error("dshx: pnpm run build …");
  if (!(await run("pnpm", ["run", "build"], { cwd: dir }))) {
    console.error("dshx: pnpm run build 失败，无法启动。");
    Deno.exit(1);
  }
  await Deno.mkdir(join(dir, "node_modules"), { recursive: true });
  await Deno.writeTextFile(marker, head ?? "unknown");
}

async function checkPnpm(): Promise<void> {
  const r = await capture("pnpm", ["--version"], { timeoutMs: 10_000 });
  if (r === null || r.code !== 0) {
    console.error(
      "dshx: 未找到 pnpm（GitHub 源码版需要）。请先安装：\n  npm install -g pnpm\n或：corepack enable",
    );
    Deno.exit(1);
  }
}

// ---------- 官方 npm 版（原有逻辑） ----------

/** 从 npm registry 取最新版本，失败返回 null。 */
async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_LATEST, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/** 取本地已装版本（通过全局 dsh 命令），未安装返回 null。 */
async function currentVersion(): Promise<string | null> {
  const out = await capture("dsh", ["--version"]);
  return out?.code === 0 ? out.stdout.trim() || null : null;
}

/** 启动全局 dsh web，透传剩余参数，以 dsh 的退出码退出。 */
async function launchNpm(args: string[]): Promise<never> {
  const cur = await currentVersion();

  // 未安装 → 直接装最新再启动
  if (cur === null) {
    console.error(`dshx: 未检测到 ${PKG}，正在安装最新版本…`);
    await run("npm", ["install", "-g", `${PKG}@latest`]);
    return launchDsh(args);
  }

  const latest = await latestVersion();

  // 网络失败 → 提示后直接启动当前版本
  if (latest === null) {
    console.error("dshx: 无法获取最新版本信息（网络？），直接启动当前版本。");
    return launchDsh(args);
  }

  // 已是最新 → 直接启动
  if (latest === cur) {
    return launchDsh(args);
  }

  // 有更新，且是交互终端 → 弹选择
  let action: string;
  if (Deno.stdin.isTerminal()) {
    action = await Select.prompt({
      message: `dsh 有新版本 (${cur} → ${latest})`,
      options: [
        { name: `更新到 ${latest} 并启动`, value: "update" },
        { name: `直接启动当前版本 ${cur}`, value: "launch" },
      ],
    });
  } else {
    // 非交互终端（如管道/CI）不悬挂，直接启动当前版本
    console.error(
      `dshx: 有更新 ${cur} → ${latest}，但非交互终端，跳过更新直接启动。`,
    );
    action = "launch";
  }

  if (action === "update") {
    console.error(`dshx: 更新到 ${latest} …`);
    await run("npm", ["install", "-g", `${PKG}@${latest}`]);
  }

  return launchDsh(args);
}

/** 启动 dsh web 并透传参数。 */
async function launchDsh(args: string[]): Promise<never> {
  const child = new Deno.Command("dsh", {
    args: ["web", ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  Deno.exit(status.code ?? 1);
}

// ---------- GitHub 源码版启动 ----------

async function launchRepo(repo: string, args: string[]): Promise<never> {
  await checkPnpm();
  const dir = await ensureRepo(repo);
  const sync = await syncRepo(dir);
  switch (sync.status) {
    case "current":
      if (sync.head) console.error(`dshx: ${repo} @ ${sync.head}（已是最新）`);
      break;
    case "updated":
      console.error(
        `dshx: ${repo} ${
          sync.resynced ? "无法快进，已重新对齐到" : "已更新到"
        } ${sync.head}。`,
      );
      break;
    case "failed":
      console.error(
        `dshx: ${repo} 同步失败（${sync.reason}），继续使用本地已有代码${
          sync.head ? ` @ ${sync.head}` : ""
        }。`,
      );
      break;
  }
  await ensureBuilt(dir, sync.head);

  const child = new Deno.Command("pnpm", {
    args: ["dsh", "web", ...args],
    cwd: dir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  Deno.exit(status.code ?? 1);
}

// ---------- use 子命令 ----------

async function cmdUse(rest: string[]): Promise<void> {
  const target = rest[0];

  // dshx use → 查看当前记录与已管理 repo
  if (target === undefined) {
    await showStatus();
    return;
  }

  // dshx use default
  if (["default", "npm", "official"].includes(target.toLowerCase())) {
    saveConfig({ source: "default" });
    console.error(`dshx: 已记录当前来源 → default（官方 npm: ${PKG}）`);
    return;
  }

  // dshx use <owner>/<repo>
  const repo = normalizeRepo(target);
  if (repo === null) {
    console.error(
      `dshx: 无法识别 '${target}'。用法：\n  dshx use default\n  dshx use <owner>/<repo>`,
    );
    Deno.exit(1);
  }
  saveConfig({ source: "github", repo });
  console.error(`dshx: 已记录当前来源 → ${repo}（GitHub 源码版）`);
  await ensureRepo(repo); // 立即克隆，尽早暴露问题
  console.error("dshx: 下次运行 dshx 将拉取该 repo 最新代码并启动。");
}

async function showStatus(): Promise<void> {
  const cfg = loadConfig();
  console.error(
    `dshx: 当前来源 → ${
      cfg.source === "github"
        ? `${cfg.repo}（GitHub 源码版）`
        : `default（官方 npm: ${PKG}）`
    }`,
  );
  const entries: string[] = [];
  try {
    for await (const owner of Deno.readDir(REPOS_DIR)) {
      if (!owner.isDirectory) continue;
      for await (const name of Deno.readDir(join(REPOS_DIR, owner.name))) {
        if (!name.isDirectory) continue;
        const repo = `${owner.name}/${name.name}`;
        const head = await gitShortRev(repoPath(repo));
        entries.push(`  - ${repo}${head ? ` @ ${head}` : ""}`);
      }
    }
  } catch {
    // 目录不存在
  }
  console.error(
    entries.length
      ? `dshx: 已管理 repo（${REPOS_DIR}）：\n${entries.join("\n")}`
      : `dshx: 尚无已管理 repo（${REPOS_DIR}）`,
  );
}

// ---------- 入口 ----------

function printUsage(): void {
  console.error(`dshx — DeepSeek Harness CLI 启动器

用法：
  dshx                     按上次记录的来源启动 dsh web（透传参数）
  dshx use default         切换为官方 npm 版 (@deepseek-ai/dsh)
  dshx use <owner>/<repo>  切换为 GitHub 源码版（如 shiguredo/deepseek-harness），
                           repo 管理在 ~/.dshx/repos/，每次启动前自动 pull
  dshx use                 查看当前来源与已管理 repo`);
}

async function main(): Promise<void> {
  const argv = Deno.args;

  if (argv[0] === "use") {
    await cmdUse(argv.slice(1));
    return;
  }
  if (["-h", "--help", "help"].includes(argv[0] ?? "")) {
    printUsage();
    return;
  }

  const cfg = loadConfig();
  if (cfg.source === "github") {
    await launchRepo(cfg.repo, argv);
  } else {
    await launchNpm(argv);
  }
}

await main();
