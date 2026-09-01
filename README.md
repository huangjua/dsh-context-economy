> **AI 生成声明**
> 本插件由 **DSH(DeepSeek Harness)搭载 DeepSeek V4 Flash** 编写,开发过程中使用了
> [myDshPresets](https://github.com/0liveiraaa/myDshPresets) 插件。

# @dsh-external/dsh-context-economy

> **一句话**：项目阅读的"上下文经济层"——符号/import 索引 + byte 级切片，把读代码的 token 成本打下来（实测单次符号查询省 **80–93%** 输出 token）。

把 DSH 内建"项目阅读 + Agent 记忆"里最值得复用、但 DSH 还没直接提供的两个缝做成插件：**指针式懒加载** + **byte 级切片**。查询只返回相对路径 / 行号 / 短上下文指针，超量结果落盘留指针，绝不整文件加载。

## 核心亮点

- **项目结构索引**（文件树 + 符号表 + import 图）：按 `mtime+size` 增量自愈，只重扫变更文件。
- **byte 级指针切片** `project_slice_read`：按字节窗口读 + `find` 定位 + `nextByteOffset` 翻页，专治"单行超大文件行号失效"。
- **成本量化** `project_cost_probe`：指针输出 vs 朴素整文件加载的 token 节省对比。

## 优点与权衡

| 👍 优点 | ⚠️ 权衡 / 边界 |
|---|---|
| 直接命中 token 成本痛点，省 80–93% | 与 DSH 内建项目阅读能力重叠 |
| byte 级切片兜底超大单行文件 | 功能面窄（只读，无写入） |
| mtime+size 增量自愈，不信任过期缓存 | 四个插件里最老（后续主要是 alpha.3 适配） |

## 借鉴的优秀项目

| 项目 | 借鉴了什么 |
|---|---|
| DSH 内建项目阅读 + Agent 记忆 | 指针式懒加载、mtime 自愈派生状态、超量落盘留指针 |
| 0liveiraaa/myDshPresets | 开发过程使用的 DSH preset |

---

Token-efficient project reading plugin for DSH —— 项目阅读的"上下文经济层"。

把 DSH 内建"项目阅读 + Agent 记忆"里最值得复用、且 DSH 还没直接提供的两个缝做成插件：

1. **项目结构索引（文件树 + 符号表 + import 图）**
   - 按 `mtime+size` 增量自愈：只重扫变更文件，从磁盘真值重建，不信任过期缓存（对齐全套 `dev_heal_links` 哲学的 DSH 版本）。
   - 查询只返回 **相对路径 + 行号 + 短上下文** 指针；命中超 `maxHits` 自动 **落盘到 spill 文件**并返回路径。
2. **byte 级指针切片**
   - `project_slice_read` 不整读文件，按字节窗口读取 + 可选 `find` 定位 + `nextByteOffset` 翻页，专治"单行超大文件行号失效"。
3. 附 `project_cost_probe`：量化指针输出 vs "朴素整文件加载"的 token 节省（验收基线）。

## 这个插件是怎么写出来的
- **灵感来源**：先拆解 DSH 自带的"项目阅读 + Agent 记忆"能力,提取出最值得复用的模式——指针式懒加载(`read` 的精确行段、`grep` 只回命中行、`glob` 只回路径)、mtime 自愈派生状态、超量结果落盘留指针。
- **骨架**：用 DSH 插件生产线 `dev_scaffold_plugin` 生成 hybrid 形态,然后自己实现了两个真正缺的部分:
  1. `src/core.ts`——增量项目索引(文件树 + 轻量符号表 + import 图),按 `mtime+size` 只重扫变更文件;外加 byte 级切片 `sliceRead`(单行超大文件兜底)。
  2. `src/index.ts`——用 `defineTool` 注册 6 个 `project_*` 工具,全部返回 path:line 指针、超量落盘。
- **构建**：本机 `bash` 是坏 WSL 启动器,`dev_build_plugin` 不可用;改用运行时 junction 链接编译依赖 + 本地 `tsc` 编译,产物 `lib/` 干净通过。
- **验证**：`scripts/e2e-self-test.mjs` 独立跑通索引/符号/import/切片,并在 demo 项目上量化出单次符号查询约省 **80–93%** 输出 token。
- **发布**：git 推送 GitHub,`npm pack` 打 tgz,再用 GitHub CLI 创建 `v0.0.1` Release 并附带包。

## 工具
| 工具 | 作用 |
|---|---|
| `project_index_status` | 索引状态 + 手动 refresh 自愈扫描；Part D 起带 heal 历史/趋势/staleMs/缓存损坏计数 |
| `project_symbols_find` | 按名字/子串查符号（path:line+context，超量落盘）；`ranking=true` 时匹配度优先 + 所在文件 PageRank 降序（默认 false 保持旧顺序） |
| `project_imports` | in/out import 边；`direction=hotspots` 被引用 top-k；`direction=orphans` 孤立文件（in=0 且 out=0） |
| `project_files` | 缓存 glob（相对路径列表） |
| `project_slice_read` | byte 指针切片（超大单行文件兜底）；`mode=tail` 尾部窗口（日志）；`re=true` 正则 find（默认字面量不变） |
| `project_json_read` | 有界 JSON 顶层键分页（key + byte 区间 + ≤240 字符摘要，超量落盘，配合 slice_read 回跳精读） |
| `project_cost_probe` | 输出/朴素基线 token 对比（点测，未改动） |
| `project_savings` | 常驻记账查询：累计三类指针查询的节省（按 root/工具过滤、聚合、最近 N 次、超量落盘） |

## 常驻记账（Part A：`project_cost_probe` 点测 → `project_savings` 常驻记账）

每次 `project_symbols_find` / `project_imports` / `project_slice_read` 调用自动累计
"朴素整文件读取 vs 指针输出"的差，追加写入 `~/.dsh/project-index/savings.jsonl`（append-only）：
每行 `{ts, root, tool, argsHash, chars, naiveBytes, savedTokens, failed}`。

- `chars` = `JSON.stringify(工具输出).length`（指针输出的响应开销，response accounting）
- `naiveBytes` = 朴素基线：`symbols_find`→`matchedFileBytes`；`slice_read`→`totalBytes`；`imports`→被查文件字节数
- `savedTokens` = `max(0, estimateTokens(naiveBytes) − estimateTokens(chars))`（与 cost_probe 同口径，≈4字符/token）
- `argsHash` = `sha1(tool|root|canonicalArgs)` 前 16 位 → 聚合里的 `dupCalls`（hash suppression 记账视角：重复命中可识别、不当作新发现）
- `failed` = 该次调用是否失败（失败仍记一行，聚合含 `failures` 计数；工具行为不变，照常抛错）

`project_savings` 查询工具：
- 参数：`root`（按 root 过滤）、`tool`（按工具过滤）、`limit`（内联最近条数，缺省 `maxHits`）
- 返回：`aggregate`（calls/failures/dupCalls/chars/naiveBytes/savedTokens/savedPct）、
  `byTool`/`byRoot` 分组（ccusage 式聚合口径）、`recent`（最近 N 次）；超 `limit` 的旧行落盘 spill 返回路径。

配置：`savingsEnabled`（默认 `true`；`false` 时零开销直通，不写文件也不 stringify）、
`savingsMaxRows`（默认 500，超量淘汰最旧行——engramory cap hook 思路）。
JSONL 写失败静默（对齐现有 log 哲学）。

验收基线：`scripts/savings-bench.mjs` —— 60 次对照实验（20 symbols + 20 imports + 20 slices），
同 query 集分别打指针工具与朴素整文件基线，token 用 estimateTokens 统一口径（对齐
[leantoken measurement.md](https://github.com/morluto/leantoken/blob/main/docs/measurement.md)）。
结果 JSON 落 `~/.dsh/project-index/savings-bench-*.json`，并 `evidence_create/evidence_add` 登记。
黄金对比：`scripts/probe-snapshot.mjs` 复刻 cost_probe 输出，改造前后 diff 应为空。

## 借鉴来源登记（Part A）

| 来源仓库 | license | 搬了什么 | 怎么改的 |
|---|---|---|---|
| [morluto/leantoken](https://github.com/morluto/leantoken) | MIT OR Apache-2.0 | `leantoken.savings` 工具语义（response accounting / hash suppression / failures / explicit observation limits） | 只搬契约语义，未复制源码：逐字段映射成自有 `SavingsRow`/`aggregate` schema（chars/naiveBytes/savedTokens/argsHash/failed + `savingsMaxRows` 观测上限） |
| [leantoken docs/measurement.md](https://github.com/morluto/leantoken/blob/main/docs/measurement.md) | MIT OR Apache-2.0 | 60 次对照实验结构（同 query 集分别打内建 read/grep 与指针工具，统计输入 token） | 照抄实验结构写成 `scripts/savings-bench.mjs`（20 symbols + 20 imports + 20 slices = 60 runs），token 口径用自有 `estimateTokens(≈4字符/token)` |
| [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) | NOASSERTION | usage 聚合口径（按 session/model 聚合、趋势） | 只借结构不搬代码：`project_savings` 的 byTool/byRoot 分组聚合 |
| [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) | MIT | compactions/prunes 统计口径 | 字段命名参考（calls/naiveBytes/savedTokens/savedPct） |
| [tinqiao-oss/engramory](https://github.com/tinqiao-oss/engramory) | MIT | cap hook（总量封顶 + 淘汰） | 借鉴思路：`savingsMaxRows` 超量淘汰最旧行 |

> NOASSERTION 来源（ccusage）仅借结构未复制代码，按任务 §1 许可条款不引入其 LICENSE 文件；
> 其余来源均未复制源码（纯 TS 自实现），故无需随附 LICENSE。

## 图中心度（Part B：`project_imports` hotspots/orphans + `project_symbols_find` ranking）

在现有 import 边上构建有向图（节点 = 索引内全部文件），`ensure()` 时算好入度 / PageRank / 孤立文件，
随缓存落盘（**缓存结构升级 `VERSION 5`，旧 version=4 缓存自然失效重建**）：

- `src/core.ts` 新增 `buildGraph(imports, allFiles?) → { indegree, ranks, orphans }`；PageRank 直译自
  aider repomap 所用 networkx `_pagerank_python`（阻尼 0.85、收敛阈值 `N*1e-6`、迭代封顶 100、
  稀疏邻接、纯 JS 零依赖，文件头注明来源）。
- `orphans` = 索引内 `in=0 且 out=0` 的文件（孤立点，含无符号文件）；外部 specifier（包名/`node:`）
  不在节点集内，其边被忽略。
- `project_symbols_find` 新增 `ranking` 参数（**默认 false**：false 时输出与升级前逐字节一致；
  true 时按"匹配度（完整名 > 前缀 > 子串）优先，组内按所在文件 PageRank 降序"排序——只作并列
  排序键，不改变命中集合）。
- `project_imports` 的 `direction` 扩展 `hotspots`（被引用 top-k：indegree 降序→rank 降序，
  返回 file+indegree+rank+短上下文）与 `orphans`（孤立文件）；两者超量落盘；`out/in` 仍要求 `file`。

参考值（`fixtures/graph-demo` 6 节点：环 a→b→c→a + hub（被 a,d 引用，indegree=2）+ 孤立 e）：
`a=0.2490  b=0.1729  c=0.2140  hub=0.2299  d=0.0671  e=0.0671`（与 networkx 同构计算误差 <1e-3）。
验收基线：`scripts/e2e-self-test.mjs` Part B 段（orphans 精确、PageRank 双参考交叉验证、
ranking 排序语义、hotspots 排序）+ `scripts/symbols-snapshot.mjs` 黄金对比（ranking=false 与升级前
逐字节一致）。

## 借鉴来源登记（Part B）

| 来源仓库 | license | 搬了什么 | 怎么改的 |
|---|---|---|---|
| [paul-gauthier/aider](https://github.com/paul-gauthier/aider) `repomap.py` | Apache-2.0 | PageRank 排序用法（`get_ranked_tags` → `nx.pagerank`） | 按 Q2 决策：hermes-agent 无 repo-map/PageRank 实现（issue #535 未落地）→ 直译 aider 所用算法；`src/core.ts` 文件头注明 |
| [networkx](https://github.com/networkx/networkx) `pagerank_alg.py`（aider repomap L382 注释所引） | BSD-3-Clause | `_pagerank_python` 算法（稀疏邻接、dangling 均匀分配、err<N*tol） | 纯 JS 重写，未逐行复制源码；参数对齐 alpha=0.85 / tol=1e-6 / max_iter=100；非收敛时返回末代 + `converged:false` 而非抛错 |
| [agentpatterns-ai Repository Map Pattern](https://github.com/agentpatterns-ai)（35★） | — | "token 预算内取 top-k 符号"策略 | 只作模式参考不可抄码：hotspots 的 top-k + 超量落盘 |
| [morluto/leantoken](https://github.com/morluto/leantoken) | MIT OR Apache-2.0 | `search` 的 ranked 语义 | 借鉴：`ranking` 只作并列排序键，不改变命中集合 |

## slice 增强与有界 JSON 分页（Part C：tail / 正则 find / `project_json_read`）

- `sliceRead` 新增 `mode:'window'|'tail'`（**默认 window 不变**）：tail 从文件尾部读窗口，
  起始偏移 `max(0, total-lengthBytes)`，返回值带 `tailOffset`（日志 append 场景，连续两次读窗口正确下移）。
- `find` 新增 `re:true`（**默认 false 字面量子串不变**，大小写不敏感）：正则模式（`i` 标志），
  ReDoS 防护 = `find.length ≤ 256` + 每 64KB 块内正则执行超 10ms 抛 `slice_find_regex_timeout`
  （`regexFirstMatch` 导出，`budgetMs<0` 可确定性触发超时）。
- 新增工具 `project_json_read`：有界 JSON 顶层键分页——`scanJsonKeys` 按 64KB 块流式扫描顶层
  `{...}`（不 `JSON.parse` 整文件，超大/超深 JSON 不 OOM），返回
  `[{key, byteStart, byteEnd, preview≤240字符}]`；`byteStart/byteEnd` 可配合
  `project_slice_read` 回跳精读（e2e 用 9.7MB 单行 JSON 验证一致）；超量落盘；顶层非对象给出
  typed 诊断（`topLevel: array/primitive/error` + 头部预览）。只读文件，遵循既有 fs-sandbox 策略。

验收基线：`scripts/e2e-self-test.mjs` Part C 段（tail 连续两次读、re:false/re:true、长度上限、
超时机制、9.7MB JSON 4000 键分页 + 回跳精读）+ `scripts/slice-snapshot.mjs` 黄金对比
（re:false/window 与升级前逐字节一致）。

## 借鉴来源登记（Part C）

| 来源仓库 | license | 搬了什么 | 怎么改的 |
|---|---|---|---|
| [morluto/leantoken](https://github.com/morluto/leantoken) | MIT OR Apache-2.0 | `read`（按符号/行范围精确读）与 `json`（bounded live JSON，paged keys + typed diagnostics）字段契约 | 逐项对照契约实现；`project_json_read` 的 entries/typed diagnostics 结构对齐 leantoken json 语义 |
| [openai/codex](https://github.com/openai/codex) | Apache-2.0 | `view` 工具的 head/tail 语义 | 借鉴：`sliceRead` 的 `mode:'tail'` 尾部窗口 |
| node 原生 `readSync` 反向块读 | — | 自实现 | tail 用 `total-lengthBytes` 定位起始偏移，不整读文件；JSON 扫描器用 64KB 块流式 + 深度计数跳过值（不自造 JSON.parse） |

## heal 时间序列（Part D：`project_index_status` 历史/趋势/stale/损坏提示）

- daemon 每次 `ensure()` 的 `scannedBytes/rescannedFiles/added/dropped/symbols/imports` 追加为
  `~/.dsh/project-index/heal-history.jsonl`（append-only，行带 `root`，多 root 共享）。
  在 `save()` 后同 tick 内写入（不加新定时器——后台任务串行红线）。
- 封顶：行数超 `historyMaxRows`（config，默认 200）或字节超 1MB → 删最旧行保留尾部（engramory cap hook）。
- `project_index_status` 新增：`history[]`（最近 N 次，`history` 参数缺省 10）、`trend`
  （末行 vs 前一行增量）、`staleMs`（距上次 heal 滞后）、`consistency: 'reconcile_working_tree'`
  （对齐 leantoken 一致性术语：本插件每次查询都对账工作树）、`cacheCorruptCount`（本进程内
  cacheFile 解析失败次数，自愈重建提示）、`historyCorruptLines`。旧字段不变（root/files/symbols/
  imports/updatedAt/scannedBytes/...），旧消费者不受影响。
- 行为对齐工具描述：`refresh:true` 才强制 heal（每次 heal 追加一行 history）；不带 refresh 的
  status 不再**反复**隐式扫描——但首次 status（`lastReport` 为空）会自动建索引一次，
  保住升级前"status 显示真实计数"的语义（避免全新 root 返回全零 + staleMs 天文数字）。

验收基线：`scripts/e2e-self-test.mjs` Part D 段（连续 3 次 heal → 3 行且与 lastReport 逐字段一致；
`historyMaxRows=3` + 5 次 heal → 裁剪保留尾部 3 行；坏缓存 → `cacheCorruptCount` 计数 + 自愈重建；
staleMs ≥ 0）。

## 借鉴来源登记（Part D）

| 来源仓库 | license | 搬了什么 | 怎么改的 |
|---|---|---|---|
| 自家 daemon log（直搬自家） | BSD-3-Clause | 每次 heal 已计算全部指标并写 logFile | 结构化落盘为 `heal-history.jsonl`（不再靠字符串日志）；history 由新写入行构成，不重算旧数据 |
| [morluto/leantoken](https://github.com/morluto/leantoken) | MIT OR Apache-2.0 | `consistency` 双模式术语（`indexed_generation` / `reconcile_working_tree`） | 借鉴：status 报告当前一致性模式 `reconcile_working_tree` + `staleMs` |
| [tinqiao-oss/engramory](https://github.com/tinqiao-oss/engramory) | MIT | cap hook（总量封顶 + 淘汰） | 借鉴：heal-history 行数/字节双封顶，删最旧保留尾部 |

## 全量回归与交付（Part E）

- **黄金对比**：默认配置下升级前 6 工具输出 vs 升级后逐字节一致。锚定脚本：
  `scripts/probe-snapshot.mjs`（cost_probe）、`scripts/symbols-snapshot.mjs`（findSymbols
  ranking=false）、`scripts/slice-snapshot.mjs`（sliceRead 字面量/window）——改造前后 diff 均为空；
  e2e Part E 段再锚定 status 旧字段 / listFiles / findImports(out/in) / findSymbols / slice / estimateTokens。
- **bench 基线**：`scripts/savings-bench.mjs` 60 runs `saved=839t (32.3%)`，Part A 与 Part E 两次结果
  一致（默认行为零回归），已登记证据包 `dsh-context-economy-savings-bench`（3 文件，verify PASS）。
- **装配**：`cordis.patch.yml` 保持单条 insert（本插件）未改动，无新冲突；与 profile 现有 bundles 并存，
  仅需重载本插件（`dev_reload_package`）即生效，无需重新装配。
- **提交纪律**：A/B/C/D/E 各一个独立 commit（`9249b7d`/`b7faade`/`858e95b`/`fb91437`/`<E>`），
  每部分 `git revert <commit>` 可独立回滚。

## 生命周期与发布包（2026-08-27 修订）

**生命周期（Part A）**：工具注册与后台自愈定时器都绑定到同一插件生命周期——
- 工具注册走 `ctx.effect(() => ctx.tools.register(t), label)`（borrow dsh-local-memory /
  dsh-session-index 范式）：热重载/卸载时 cordis 自动注销，reload 不产生重复工具；
- 定时器用 Node 全局 `setInterval` + `unref`（不阻进程退出），并在
  `ctx.effect(() => () => clearInterval(timer))` 里注册清理：apply 一次只产生一个 timer，
  dispose 后 timer 与注册资源全部消失，连续 reload 不叠加。
- 回归测试：`test/lifecycle.test.ts`（fake ctx + fake timer，零真实等待）覆盖
  首载/dispose/同进程重载/两次 reload/缓存清理，`npm test` 运行。

**发布包（Part B）**：
- `files` 已补 `cordis.patch.yml` 与 `README.md`（此前 tgz 缺 patch 文件导致
  打包后安装无法装配 bundle）；`package-lock.json` 旧包名 `@dsh-external/dsh-project-index`
  已更正为 `@dsh-external/dsh-context-economy`；
- `scripts/pack-check.mjs`（`npm run pack:check`）：`npm pack --dry-run --json` 断言
  运行必需文件齐全、无开发残留、包名正确；并从干净临时目录解包 → junction 运行时依赖 →
  import `lib/index.js` → apply 启动成功（8 工具）→ dispose 清理通过。
- 整合入口：`npm run check` = typecheck + test + pack:check。

**开发源/安装副本分离（约束 5）**：
- 当前目录是可独立构建的开发副本，源码、`lib/` 与 `node_modules/` 在同一目录内；
- 发布时只复制 `lib/`、`package.json`、`cordis.patch.yml` 和 `README.md` 到安装副本；
- 构建与运行时都解析本目录的 alpha.3 依赖树，不依赖外部 checkout 或 junction。

## 构建与验证

```bash
npm run typecheck
npm run check:dsh-contract
npm test
npm run pack:check
```

## 装配状态（截至本次会话）
- profile 已就绪：`~/.dsh/profiles/web/package.json` 的 `dependencies + bundles` 已含本包，链接指向真实目录，junction 正常。
- `dev_install_package / dev_inject_plugin` 的**运行时热装路径**在本沙箱反复失败（loader 对同一 realpath 包吃旧代 + 坏 WSL bash），已证明与插件内容无关（最小插件能跑到 apply；本插件独立 apply 验证注册出全部 6 个工具）。
- **重启一次 web 进程后**，官方 bundles 装配路径加载当前产物，6 个工具应即上线；之后可 `project_cost_probe` 复验。

## 验证（独立于 loader，真实运行）
`node scripts/e2e-self-test.mjs`（动态 import `lib/core.js` 与 `lib/savings.js`）：
- 在 demo 项目（5 文件 / 11 符号 / 4 import）上建索引、符号查询、import 边、byte 切片均通过；
- 成本探针结果已存 `../dsh-demo-project/cost-probe.txt`（单次符号查询约省 **80–93%** 输出 token）；
- 常驻记账（Part A）：10 次混合查询经 `wrapMeasured` 真实落账、逐行 savedTokens 与手算差 ≤1 token、
  累计聚合一致；`savingsEnabled:false` 零开销、JSONL 写失败静默、`savingsMaxRows` 淘汰均覆盖；
- 图中心度（Part B）：6 节点图 demo orphans 精确、PageRank 双参考误差<1e-3、ranking 语义、hotspots；
- slice/JSON（Part C）：tail 连续两次读、re:false/re:true、ReDoS 防护、9.7MB 单行 JSON 分页 + 回跳精读。

`node scripts/savings-bench.mjs` —— 60 次对照实验基线（结果存 `~/.dsh/project-index/savings-bench-*.json`）。
