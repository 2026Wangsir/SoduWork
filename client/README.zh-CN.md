# SoduWork 桌面客户端

**简体中文** · [English](README.md) · [开发指南](../docs/development.md#桌面客户端)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

当前工作区使用 Electron 与原生 HTML/CSS/JavaScript；管理端的 React 构建不参与桌面渲染。

## 模块边界

| 位置 | 职责 |
| --- | --- |
| `main.js`、`main/` | 应用启动、原生窗口、设备身份、更新、文件及执行底座；覆盖窗生命周期在 `main/desktop-overlay.cjs` |
| `preload.js` | 受限的渲染端 IPC 接口；不向页面开放通用 Node 权限 |
| `desk.html`、`desk-boot.js` | 主工作区的资源装载与启动 |
| `index.html` | 透明桌宠及快捷工具覆盖窗 |
| `core/` | 客户端状态、同步、语言及共享基础能力 |
| `components/requirements/` | 需求池、单一需求抽屉、派活生命周期及共享表单字段 |
| `components/` 其它目录 | 对话、AI 团队、插件等界面模块；共用执行选择器保留在 `panels/` |
| `theme/`、`assets/`、`vendor/` | 主题、素材及带许可的随附依赖 |
| `tests/`、`e2e/` | 单元/契约检查与 Electron 场景验证；不随产品安装 |
| `scripts/`、`build/` | 运行时准备、打包与原生安装支持 |
| `runner/`、`dist/`、`.runtime/` | 生成的 Runner、发行包和随附运行时；不作为源码维护 |

普通对话、需求执行与目标使用同一会话链路：`panels-chat` → `conversationSession` → 主进程会话 IPC → `agent-runtime` → Pi 或 Runner。AI 团队点击工作打开对应会话；需求抽屉按需展开共享 TaskTrace。桌面竖条直接进入需求池，不保留旧任务看板、旧详情聊天框或独立 AI 工位会话。旧 `detail` 链接继续定位同一条需求，不新增数据记录。

三端结构、派活规则和保留的兼容边界见 [当前需求工程结构](../docs/release-scope.md)。

渲染脚本按 HTML 中的顺序共享作用域。拆分时同时核对资源引用、顶层声明、调用顺序和 Electron 加载；单独语法检查不足以证明页面可用。

原生历史和下载的会话副本在列出、读取、恢复和修改时均遵守账号与 Hub 边界，离线使用也不例外。归属未知的归档需要明确导入为独立的只读副本。缓存正文不授予需求或云端会话的执行权限；定位已验证的原生来源时必须保留原有底座、模型和权限。

浏览器同时支持 IndexedDB 与 Web Locks 时，远端通知历史和回执标记使用账号隔离的事务存储；本地提醒继续使用既有 localStorage 缓存。迁移只有在持久化提交成功后才清理旧快照，写入失败会保留旧快照以便重试。不具备这些浏览器能力的环境保持既有缓存行为。

需求的交付区域支持通过原生保存框，将单条验收摘要导出为 Markdown。导出需要执行记录查看权限和已经固定的交付版本。摘要读取一致快照，区分当前需求正文与已记录的验收标准；缺失的验证结果或运行归属明确标为未记录。导出不会通过验收或修改需求。

同一区域提供默认折叠的派发说明。新桌面派发按每次获准进入队列的执行轮次，保存用户明确填写的补充内容、选择的提交方式及当次实际提交方式，执行失败也保留记录。本机、Runner 和工作流共用这一回执链路。同轮重试不能覆盖说明，后续轮次单独保存；只有原有执行记录查看权限的用户可以读取。旧客户端和缺少明确快照的历史条目显示为未记录，不从聊天内容、截断的旧上下文或当前路由推测补齐。

## 开发与验证

首次体验推荐根目录的 `sh start.sh --desktop`。根目录启动器在专用 `venv/` 中安装 Hub 和 Runner 依赖，并明确将生成的桌面副本绑定到同一 Python 解释器。独立开发时保持 Hub 运行，在 `client/` 安装依赖 `npm ci` 后执行 `npm start`，三种桌面系统共用这一入口；这种方式使用安装了 `requirements-runner.txt` 的 `../hub-backend/.venv`。两种方式都执行当前后端源码，不要手工复制旧发行版 Runner 代替当前源码。

`npm test` 运行客户端的单元和契约检查。`npm run check:layout` 检查源码与生成目录的边界。`e2e/` 脚本应按文件声明选择隔离夹具或真实服务：隔离界面通过不等于真实模型、用户账号或线上交付验证通过。

Windows 执行服务在工具初始化前加入原生 Job Object。专用 Windows PowerShell 辅助进程持有该对象，退出时确认其中的进程全部结束，包括中间 Windows 父进程已经退出的 Git Bash 后代进程。这是生命周期清理机制，不是安全沙箱；Linux 和 macOS 继续使用现有的进程树清理。

验收摘要的隔离验证命令为 `node e2e/acceptance-summary-export.cjs /absolute/evidence/directory /path/to/test/python`。Python 环境需要后端测试依赖。该脚本验证真实原生 IPC、设备认证与保存字节，保存框选择由测试注入，不使用真实模型或生产账号。

## Windows 打包

Windows 交互式安装器提供英语、简体中文、日语和韩语，默认匹配 Windows 界面语言，不支持的语言回退为英语；用户可在安装前手动选择。静默更新不显示语言选择框。安装器语言不会覆盖桌面端已保存的界面语言。macOS 和 Linux 保持各自平台的安装界面。

1. 在后端虚拟环境安装 `../hub-backend/requirements-runner-build.txt`。
2. 执行 `npm run build` 或 `npm run build-portable`。
3. 发布前按当前发布门禁验证最终安装包、升级与回滚。

两种打包入口都会执行 `prepare:runner`，从 `runner_main.py` 和 `runner.spec` 重建单文件 Runner。源码、技能和依赖清单是唯一构建输入；已有 EXE 不会跳过编译。应用打包排除测试文件，Runner 资源只选择单文件可执行程序。

Windows 原生安装输入由 `scripts/payload-sources.cjs` 按清单摘要冻结，再生成 NSIS 资源表，避免文件系统过滤层向不同构建进程暴露不同字节。源文件在清单生成后发生变化时构建立刻失败。冻结输入每目录最多 64 个文件，避免编译器对大目录反复扫描；安装与验包共用一个解包函数，保留压缩与逐文件校验，旧版本的安装兼容例外见验证器。`.runtime/installer/payload-sources/` 是可重建的中间产物，不提交仓库。原生安装及其故障注入测试共用构建目录，应顺序执行。

Windows 卸载默认保留本地应用数据。交互式向导提供可选清理：显示完整目录，用户勾选并二次确认后，仅删除当前 Windows 账户的 `%APPDATA%\SoduWork` 目录，遇到目录链接则拒绝清理。外部工作区、其他 Windows 账户、Hub 服务数据和自定义 `SODUWORK_USER_DATA` 目录不在清理范围内。静默卸载与升级保留数据；旧的 `--delete-app-data` 参数会被拒绝，不能绕过确认。

OpenCode 为可选底座，不再随客户端分发，也不会在构建时下载。Agent 管理继续识别本机安装，并提供主动安装入口。`build-light` 已退役，常规构建统一采用轻量配方。

本机模型可搭配任意本地受管底座，包括 Pi、Qwen、OpenCode、DeepSeek Harness、Kimi、Harness2 和 Codex Harness。Codex、Claude 账号型底座保留各自的模型目录。本地 Agent 默认模型加密保存，并按当前 Hub、设备和账号隔离；对话、需求执行和本机自动化使用这些选择。新建对话、会话输入框、需求安排执行及自动化表单在未选择模型或所选模型已删除时，均使用第一个可用模型。本地模型排在 Hub 模型之前，有效的已有选择保持不变。既有会话切换到替代模型继续对话时，保留原会话历史。本地模型调用不消耗 Hub 模型额度，但仍须满足正常的账号和执行权限。

在 Agent 管理中，受管底座未保存模型或原模型已删除时，会显示并测试列表中的第一个可用模型。本地模型排在 Hub 模型之前，有效的已有选择继续保留。自动回退不会改写加密保存的偏好。没有可用模型时仍显示不可用；安全存储读取失败会报错，不会被当作模型删除。运行 `node e2e/agent-single-model-default.cjs /absolute/evidence/directory` 可通过真实 Electron 界面、加密存储和私有 IPC 验证默认选择、删除回退及测试路由。该测试中的 Hub 与 Runner 回执为模拟数据，不调用真实模型服务。

本机自动化定时执行时，会先验证设备模型映射的归属，再按相同规则解析模型并创建会话。它保留自动化原来保存的偏好，只在本次执行使用替代模型。对于已保存的 Hub 模型被删除的自动化，需要同时部署客户端和 Hub 改动，由 Hub 允许原设备重新解析缺失的选择。远程目标与账号型底座保留原有准入规则。目录读取失败或不完整不代表模型已删除；本地模型可以离线使用，也不意味着可以自动替换尚未确认状态的 Hub 模型。

云端对话、远程派发和 Hub 管理的工作流不接受本地模型引用。本地 Agent 测试通过桌面的私有 Runner 管道执行，不向 Hub 发布模型配置或测试日志。Pi 可使用本地 OpenAI 兼容图片模型直接生图，成果保存在本机工作区，支持 base64 图片数据或同源成果链接；尚未提供本地视频生成功能。无法验证账号归属的旧自动化模型映射会保留在加密存储中，并要求用户重新选择模型。本地模型准入 E2E 使用真实 Electron 进程和模拟的本机服务，覆盖默认选择、删除、账号隔离与配额行为。

底座名单、显示信息、模型归属及权限声明来自 `../hub-backend/app/agent_catalog.json`，打包复制到 `resources/agent_catalog.json`；不在渲染端再维护第二份支持名单。扩展方式见 [Agent 扩展约定](../docs/release-scope.md)。
