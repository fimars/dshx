# dshx

> DeepSeek Harness CLI 的极简启动器。
>
> 更多信息：<https://jsr.io/@mzk/dshx>。

- 按上次记录的来源启动 `dsh web`，并透传参数：

  `dshx {{参数}}`

- 切换为官方 npm 版：

  `dshx use default`

- 切换为 GitHub 源码版（自动 clone / pull / build）：

  `dshx use {{owner}}/{{repo}}`

- 查看当前来源与已管理的 repo：

  `dshx use`

- 显示帮助：

  `dshx help`

---

## NAME

`dshx` — DeepSeek Harness CLI 启动器

## SYNOPSIS

```
dshx [参数...]
dshx use
dshx use default | npm | official
dshx use <owner>/<repo>
dshx help | -h | --help
```

## DESCRIPTION

`dshx` 解决两个问题：不必每次手动敲长串权限标志，以及**在官方 npm 版与 GitHub
源码版之间一键切换**。

首次运行按官方 npm 版启动；`dshx use` 记录到一个配置文件，之后每次 `dshx`
都按该记录工作。无论哪种来源，`dshx` 最后都是执行
`dsh web`，并把多余参数原样透传过去。

**所有 `dshx` 自身的提示信息都写到 stderr**，stdout 完全留给 `dsh`
子进程，因此可以安全地重定向。

## COMMANDS

| 命令                      | 行为                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `dshx [参数...]`          | 按记录的来源启动 `dsh web <参数>`                                 |
| `dshx use`                | 查看当前来源，并列出 `~/.dshx/repos/` 下所有已管理 repo 及其 HEAD |
| `dshx use default`        | 记录为官方 npm 版（`@deepseek-ai/dsh`）；别名 `npm`、`official`   |
| `dshx use <owner>/<repo>` | 记录为 GitHub 源码版，并立即克隆到本地                            |
| `dshx help`               | 显示用法；别名 `-h`、`--help`                                     |

`<owner>/<repo>` 接受完整 GitHub URL、`git@github.com:` 前缀以及 `.git`
后缀，均会被归一化。

## 启动流程

### 官方 npm 版（`default`）

1. `dsh --version` 探测本地版本。
2. 未安装 → `npm install -g @deepseek-ai/dsh@latest` 后启动。
3. 已安装 → 向 npm registry 查最新版。
4. 有更新且**在交互终端** →
   弹出选择：「更新到最新版并启动」或「直接启动当前版本」。
5. 有更新但**非交互终端**（管道 / CI）→ 不阻塞询问，直接启动当前版本。
6. 网络失败 → 提示后直接启动当前版本。

### GitHub 源码版

1. 检查 `pnpm` 是否可用，缺失则退出。
2. 若 `~/.dshx/repos/<owner>/<repo>` 不存在 → `git clone --depth 1`。
3. `git pull --ff-only`（超时 60
   秒）。**失败只警告，不阻塞启动**，下次运行再试。
4. 若 HEAD 变化或从未构建 → `pnpm install && pnpm run build`。
5. 执行 `pnpm dsh web <参数>`。

构建标记写入 `<repo>/node_modules/.dshx-built`，内容为构建时的
HEAD。两者一致即跳过构建，因此日常启动不会重复编译。

## FILES

| 路径                                                    | 说明                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `~/.dshx/config.json`                                   | 记录当前来源，形如 `{"source":"default"}` 或 `{"source":"github","repo":"owner/name"}` |
| `~/.dshx/repos/<owner>/<repo>/`                         | GitHub 源码版的工作副本（含构建产物）                                                  |
| `~/.dshx/repos/<owner>/<repo>/node_modules/.dshx-built` | 构建标记，记录已构建的 HEAD                                                            |

配置文件不存在或损坏时，一律回退为官方 npm 版。

## EXIT STATUS

| 码   | 含义                                                                           |
| ---- | ------------------------------------------------------------------------------ |
| `0`  | 成功                                                                           |
| `1`  | `dshx` 自身失败：克隆失败、缺少 `pnpm`、`pnpm install` / `pnpm run build` 失败 |
| 其他 | `dsh` 子进程的退出码，原样透传                                                 |

## REQUIREMENTS

| 依赖                         | 何时需要                              |
| ---------------------------- | ------------------------------------- |
| [Deno](https://deno.com) 2.x | 从源码或 JSR 安装运行                 |
| `npm`                        | 官方 npm 版                           |
| `git`                        | GitHub 源码版                         |
| `pnpm`                       | GitHub 源码版                         |
| `dsh`（`@deepseek-ai/dsh`）  | 官方 npm 版；缺失时 `dshx` 会自动安装 |

## INSTALL

从 JSR 安装（推荐）：

```sh
deno install -g -n dshx \
  --allow-net --allow-run --allow-env --allow-sys --allow-read --allow-write \
  jsr:@mzk/dshx
```

从源码编译为独立二进制：

```sh
deno task compile   # 产出 bin/dshx
deno task link      # 软链到 ~/.local/bin/dshx
```

也可以直接执行带 shebang 的源码：

```sh
chmod +x dshx.ts && ./dshx.ts
```

> 权限标志是必需的：`dshx` 需要联网查版本、调起 `git`/`pnpm`/`npm`/`dsh`，并读写
> `~/.dshx`。
>
> 经 `deno install` 安装时，**shebang 里的标志会被忽略**。
>
> 必须在安装命令上显式传入权限标志（见上方示例）。

## EXAMPLES

```sh
# 首次运行：自动装好官方版并启动
dshx

# 带参数启动，参数原样透传给 dsh web
dshx --port 8080

# 切到官方 npm 版
dshx use default

# 切到某个 GitHub 源码版，并立即克隆
dshx use shiguredo/deepseek-harness

# 也可以用完整 URL 或 SSH 形式
dshx use https://github.com/shiguredo/deepseek-harness.git
dshx use git@github.com:shiguredo/deepseek-harness

# 查看当前来源与所有已管理 repo
dshx use
```

## CAVEATS

- **不要把 `web` 写进参数**。`dshx` 已隐含 `dsh web`，写 `dshx web` 会变成
  `dsh web web`。
- 第一个参数若为 `use`、`help`、`-h`、`--help`，会被 `dshx` 拦截，不会透传。
- 运行目录无关紧要；`dshx` 的状态全部集中在 `~/.dshx`。

## SEE ALSO

- JSR 包页：<https://jsr.io/@mzk/dshx>
- GitHub 仓库：<https://github.com/fimars/dshx>
