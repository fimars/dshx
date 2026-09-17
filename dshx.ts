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
 *   - github (源码)：每次启动前先 `git pull --ff-only` 拉最新代码，HEAD 有变化
 *     （或从未构建）时执行 `pnpm install && pnpm run build`，然后 `pnpm dsh web ...`；
 *     pull 失败仅警告，不阻塞启动（下次启动再试）。
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

async function gitShortHead(dir: string): Promise<string | null> {
  const r = await capture("git", ["rev-parse", "--short", "HEAD"], {
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

/** 尽力拉取最新代码（--ff-only），返回 { head, updated }。失败仅警告。 */
async function pullRepo(
  dir: string,
  repo: string,
): Promise<{ head: string | null; updated: boolean }> {
  const before = await gitShortHead(dir);
  const r = await capture("git", ["pull", "--ff-only"], {
    cwd: dir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r === null || r.code !== 0) {
    const detail = r?.stderr.trim().split("\n").at(-1) ??
      (r === null ? "超时或命令不可用" : "");
    console.error(
      `dshx: ${repo} git pull 失败${
        detail ? `（${detail}）` : ""
      }，使用本地已有代码。`,
    );
    return { head: before, updated: false };
  }
  const after = await gitShortHead(dir);
  return { head: after, updated: before !== null && before !== after };
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
  const { head, updated } = await pullRepo(dir, repo);
  if (updated) {
    console.error(`dshx: ${repo} 已更新到 ${head}。`);
  } else if (head) {
    console.error(`dshx: ${repo} @ ${head}（已是最新）`);
  }
  await ensureBuilt(dir, head);

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
        const head = await gitShortHead(repoPath(repo));
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
