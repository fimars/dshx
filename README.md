# dshx

DeepSeek Harness CLI 启动器：记住来源，启动 `dsh web`；状态在 `~/.dshx`。
仓库：<https://github.com/fimars/dshx>

## Install

    deno install -g -n dshx --allow-net --allow-run --allow-env --allow-sys --allow-read --allow-write jsr:@mzk/dshx

## Usage

    dshx                                # 启动，参数原样透传（不要再写 web，会变成 dsh web web）
    dshx use default                    # 切官方 npm 版（别名 npm / official）
    dshx use <owner>/<repo>             # 切 GitHub 源码版（只留上游 HEAD 一份快照，自动构建）
    dshx use shiguredo/deepseek-harness # 例：具体的某个源码版
    dshx use                            # 看当前来源与已管理 repo
    dshx help                           # 帮助

仓库里的 `scripts/run-repos.sh` 用 dshx 启动两个已有检出：

    bash scripts/run-repos.sh shiguredo  # 时雨堂分支版（默认）
    bash scripts/run-repos.sh official   # 官方上游版
    bash scripts/run-repos.sh both       # 两个一起起，端口 7399 与 7400
