# @dsh-external/dsh-context-economy

Token-efficient project reading plugin for DSH —— 项目阅读的"上下文经济层"。

把 DSH 内建"项目阅读 + Agent 记忆"里最值得复用、且 DSH 还没直接提供的两个缝做成插件：

1. **项目结构索引（文件树 + 符号表 + import 图）**
   - 按 `mtime+size` 增量自愈：只重扫变更文件，从磁盘真值重建，不信任过期缓存（对齐全套 `dev_heal_links` 哲学的 DSH 版本）。
   - 查询只返回 **相对路径 + 行号 + 短上下文** 指针；命中超 `maxHits` 自动 **落盘到 spill 文件**并返回路径。
2. **byte 级指针切片**
   - `project_slice_read` 不整读文件，按字节窗口读取 + 可选 `find` 定位 + `nextByteOffset` 翻页，专治"单行超大文件行号失效"。
3. 附 `project_cost_probe`：量化指针输出 vs "朴素整文件加载"的 token 节省（验收基线）。

## 工具
| 工具 | 作用 |
|---|---|
| `project_index_status` | 索引状态 + 手动 refresh 自愈扫描 |
| `project_symbols_find` | 按名字/子串查符号（path:line+context，超量落盘） |
| `project_imports` | in/out import 边（谁引用了谁） |
| `project_files` | 缓存 glob（相对路径列表） |
| `project_slice_read` | byte 指针切片（超大单行文件兜底） |
| `project_cost_probe` | 输出/朴素基线 token 对比 |

## 构建（本机情况）
- 本机 `bash` 是坏 WSL 启动器 → `dev_build_plugin` 的 bash 步骤不可用。
- 改用等价流程：运行时 junction 编译依赖 + `node node_modules/typescript/bin/tsc -p tsconfig.json`，`tsc exit=0`。

## 装配状态（截至本次会话）
- profile 已就绪：`~/.dsh/profiles/web/package.json` 的 `dependencies + bundles` 已含本包，链接指向真实目录，junction 正常。
- `dev_install_package / dev_inject_plugin` 的**运行时热装路径**在本沙箱反复失败（loader 对同一 realpath 包吃旧代 + 坏 WSL bash），已证明与插件内容无关（最小插件能跑到 apply；本插件独立 apply 验证注册出全部 6 个工具）。
- **重启一次 web 进程后**，官方 bundles 装配路径加载当前产物，6 个工具应即上线；之后可 `project_cost_probe` 复验。

## 验证（独立于 loader，真实运行）
`node scripts/e2e-self-test.mjs`（动态 import `lib/core.js`）：
- 在 demo 项目（5 文件 / 11 符号 / 4 import）上建索引、符号查询、import 边、byte 切片均通过；
- 成本探针结果已存 `../dsh-demo-project/cost-probe.txt`（单次符号查询约省 **80–93%** 输出 token）。
