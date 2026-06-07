# WOS Aide CLI 使用 Demo

本文展示两条完整流程：

1. 从 WOS 检索结果 URL 或 UUID 获取文献数据和 WOSID，再提取作者信息。
2. 从已有 WOSID CSV 创建 Task，再提取作者信息。

最终交付物都是一个完整的 `tasks/<task-id>/` 数据包。

## 1. 安装

直接从 GitHub Release 安装：

```bash
npm install --global github:iihciyekub/wos-aide-cli#v0.3.0
npx playwright install chromium
wos-aide
```

本地开发安装：

```bash
npm install
npm link
npx playwright install chromium
npm run verify
```

安装后可以启动交互导航：

```bash
wos-aide
```

也可以直接使用命令：

```bash
wos-aide --help
```

检查或安装最新稳定版本：

```bash
wos-aide update --check
wos-aide update
```

## 2. 创建独立工作目录

建议不要在 CLI 源码目录中保存下载数据。创建一个独立目录：

```bash
mkdir my-wos-project
cd my-wos-project
wos-aide init
```

查看当前工作区：

```bash
wos-aide workspace
```

默认情况下，所有 Task、断点记录和 SID 配置都会保存在当前目录下的
`tasks/` 中：

```text
my-wos-project/
  tasks/
    config.json
    index.json
    latest
    <task-id>/
```

后续应在同一个 `my-wos-project` 目录中运行命令。CLI 不会自动向父目录
查找工作区。如果需要从其他目录操作它，可以使用：

```bash
wos-aide list --tasks-root "/path/to/my-wos-project/tasks"
```

## 3. 获取并保存 WOS SID

先在浏览器中登录 Web of Science。

打开浏览器开发者工具的 Console，执行：

```js
window.sessionData.BasicProperties.SID
```

复制返回的 SID，然后执行：

```bash
wos-aide sid
```

CLI 会隐藏输入内容，快速验证 SID，并在成功后保存到 `tasks/config.json`。
执行 `run` 或 `authors` 时，如果没有 SID，也会自动提示输入并验证。

WOS Session 失效后，CLI 会提示当前 SID 已失效，并允许立即输入新 SID。
新 SID 验证成功后会自动更新保存。

在 CI 或非交互脚本中不会出现输入提示，必须使用：

```bash
wos-aide run --sid "YOUR_SID" --uuid "<uuid>"
WOS_SID="YOUR_SID" wos-aide authors --task "ai-literature-demo"
```

## Demo A：从 WOS URL 创建完整 Task

假设已经在 WOS 页面完成检索，并获得 summary URL：

```text
https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1
```

### A1. 下载文献数据并提取 WOSID

```bash
wos-aide run \
  --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1" \
  --task "ai-literature-demo" \
  --task-label "AI literature demo"
```

也可以直接使用结果集 UUID：

```bash
wos-aide run \
  --uuid "<wos-result-set-uuid>" \
  --task "ai-literature-demo"
```

完成后重点文件包括：

```text
tasks/ai-literature-demo/raw/full-record/   原始 WOS 文献导出数据
tasks/ai-literature-demo/data/wosids.csv    标准化 WOSID 列表
tasks/ai-literature-demo/data/full_records.txt
tasks/ai-literature-demo/summary.json
```

### A2. 提取作者信息

```bash
wos-aide authors \
  --task "ai-literature-demo" \
  --concurrency 3
```

输出包括：

```text
tasks/ai-literature-demo/authors/raw-json/
tasks/ai-literature-demo/authors/normalized-json/
tasks/ai-literature-demo/authors/authors.csv
tasks/ai-literature-demo/authors/authors.jsonl
tasks/ai-literature-demo/authors/checkpoint.json
tasks/ai-literature-demo/authors/failures.json
```

如果运行中断，重新执行同一个命令即可继续：

```bash
wos-aide authors --task "ai-literature-demo" --concurrency 3
```

只重试失败记录：

```bash
wos-aide authors --task "ai-literature-demo" --failed-only
```

## Demo B：从已有 WOSID CSV 创建完整 Task

准备一个 CSV，例如 `input/wosids.csv`：

```csv
wosid
WOS:000123456700001
WOS:000123456700002
WOS:000123456700003
```

CSV 也可以包含其他字段，只要存在 `wosid` 或 `UT` 列：

```csv
title,UT,note
Example One,WOS:000123456700001,first
Example Two,WOS:000123456700002,second
```

### B1. 导入 CSV

```bash
wos-aide import \
  --csv "./input/wosids.csv" \
  --task "imported-wosids-demo" \
  --task-label "Imported WOSID demo"
```

CLI 会验证 WOSID、转为大写、去重，并生成：

```text
tasks/imported-wosids-demo/data/wosids.csv
tasks/imported-wosids-demo/data/wosids_detailed.csv
tasks/imported-wosids-demo/data/wosids.json
tasks/imported-wosids-demo/manifest.json
tasks/imported-wosids-demo/summary.json
```

### B2. 提取作者信息

```bash
wos-aide authors \
  --task "imported-wosids-demo" \
  --concurrency 3
```

这一步与 URL/UUID Task 完全相同。

## 3. 查看和验证 Task

列出所有 Task：

```bash
wos-aide list
```

查看最新 Task：

```bash
wos-aide show --latest
```

验证指定 Task：

```bash
wos-aide validate --task "ai-literature-demo"
```

获得 Task 的实际目录：

```bash
wos-aide path --task "ai-literature-demo"
```

验证通过后，可以直接压缩并交付整个 Task 目录。不要只交付
`authors.csv`，因为完整 Task 还包含原始数据、标准化 JSON、失败记录、
断点状态和处理摘要，便于复查和继续处理。

## 4. 常用调试命令

只处理前 20 个 WOSID：

```bash
wos-aide authors --task "ai-literature-demo" --limit 20
```

从第 101 个 WOSID 开始：

```bash
wos-aide authors --task "ai-literature-demo" --from-index 101
```

重新抓取已经完成的记录：

```bash
wos-aide authors --task "ai-literature-demo" --force
```

从已有原始作者 JSON 重建标准化数据和聚合文件：

```bash
wos-aide authors --task "ai-literature-demo" --rebuild-only
```

## 5. 使用注意事项

- URL、UUID 和作者信息提取都需要有效的 WOS SID。
- CSV 导入本身不需要 SID，但后续作者提取需要。
- 请根据 WOS 响应速度调整 `--concurrency` 和 `--cooldown-ms`。
- WOS 页面结构变化可能影响作者提取，应保留 raw JSON 和失败记录。
- Task 是完整交付单位，也是后续新增 CLI 命令的统一输入和输出载体。
