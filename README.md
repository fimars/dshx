# dshx

DeepSeek Harness CLI 启动器：记住来源，启动 `dsh web`；状态在 `~/.dshx`。

    deno install -g -n dshx --allow-net --allow-run --allow-env --allow-sys --allow-read --allow-write jsr:@mzk/dshx
    dshx                            # 启动，参数原样透传（不要再写 web，会变成 dsh web web）
    dshx use default                # 切官方 npm 版（别名 npm / official）
    dshx use <owner>/<repo>         # 切 GitHub 源码版（自动 clone / pull / build）
    dshx use                        # 看当前来源与已管理 repo
    dshx help                       # 帮助
