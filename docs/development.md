# 开发指南

**简体中文** · [English](development.en.md) · [文档导航](README.zh-CN.md)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

## 第一次进入项目

先按[启动指南](getting-started.md)运行 `sh start.sh --desktop`，确认能登录，再选择要修改的工程。根目录只放项目入口、许可和贡献说明；依赖、构建与分发配置跟随对应工程。

| 要修改的内容 | 代码入口 | 本工程说明 |
| --- | --- | --- |
| 桌面窗口、对话、用户设置 | `client/main.js`、`client/main/`、`client/core/`、`client/components/` | [桌面客户端](../client/README.zh-CN.md) |
| API、权限、数据、任务执行 | `hub-backend/app/main.py`、`app/api/`、`app/services/`、`runner_main.py` | [Hub 后端](../hub-backend/README.zh-CN.md) |
| 浏览器中的管理页面 | `hub-frontend/src/main.jsx`、`hub-frontend/src/` | [管理端](../hub-frontend/README.zh-CN.md) |
| 技能、插件与工作流 | `skills/`、`hub-backend/plugins/` | [插件协议](plugin-authoring.md) |
| 本地启动与部署 | `start.py`、`tools/dev/`、`ops/self-host/` | [自托管](../ops/self-host/README.zh-CN.md) |
| 分发范围和完整性 | `tools/distribution/`、`tools/export_source.py` | [源码分发](open-source.md) |

上表中的后端 `app/` 和 `runner_main.py` 均相对于 `hub-backend/`。三个工程分别安装依赖；根目录没有统一的 npm 工作区。

## 管理页面

推荐开发循环：一个终端从根目录运行 `sh start.sh`，另一个终端启动 Vite。源码服务默认端口为 **18989**；Vite 默认后端为 **9080**，因此需要显式设置代理目标。

PowerShell：

```powershell
cd hub-frontend
npm ci
$env:SODUWORK_DEV_HUB = 'http://127.0.0.1:18989'
npm run dev
```

macOS / Linux：

```sh
cd hub-frontend
npm ci
SODUWORK_DEV_HUB=http://127.0.0.1:18989 npm run dev
```

打开终端显示的 Vite 地址（默认 **http://localhost:5173**），使用本地 Hub 的账号登录。修改 `src/` 后页面自动更新。完成后在本目录执行：

```sh
npm run build
node --test tests/*.test.mjs
```

## Hub 后端

`app/api/` 接收请求并校验访问权限，`app/services/` 实现业务逻辑，`app/` 下的数据模型与 `migrations/` 管理持久化和迁移。`runner_main.py` 是执行机入口；Hub 与 Runner 的信任和权限应分别处理。

根启动器将代码同步到私有运行副本，**不会热更新正在运行的后端**。修改源码后停止启动器，再运行同一命令，保留原有数据。不要编辑数据目录里的 `application/` 副本。

需要自动重载时，按[后端说明](../hub-backend/README.zh-CN.md)建立独立开发环境并运行 Uvicorn；默认使用 9080 端口。使用隔离数据库和临时账号，配置文件仅保存在本机。数据库结构变更新增 Alembic 迁移；不要删除用户数据来绕过迁移。

后端在自己的环境中执行检查：

```sh
cd hub-backend
python3 -m pip install -r requirements-test.txt
python3 quality_gate.py --list
python3 quality_gate.py --profile release --scope backend
```

完整离线门禁耗时较长；日常修改先运行清单中对应的检查。`live` 检查连接真实服务或模型，需要自行准备隔离环境，不包含在默认离线验证中。

## 桌面客户端

桌面是 Electron + 原生 HTML/CSS/JavaScript，管理页面是独立的 React 应用。主进程位于 `main.js` 和 `main/`，受限 IPC 桥位于 `preload.js`，界面主要位于 `desk.html`、`core/` 和 `components/`。

保持 Hub 运行，另开终端：

```sh
cd client
npm ci
npm start
```

独立启动的客户端保留自己的连接与配置；它与根启动器 `--desktop` 使用的专用配置不同。需要时在登录页更改服务地址。修改主进程后退出应用并重启；修改界面脚本时也应重新打开客户端验证装载顺序和交互。

在 `client/` 运行 `npm test` 和 `npm run check:layout`。Electron 端到端检查见本目录的 `e2e/`，按脚本选择所需环境。`dist/`、`.runtime/` 和生成的 `runner/` 文件是产物，不要提交或复制旧版二进制替代源码。

## 技能和插件

`skills/<name>/SKILL.md` 描述内置技能，包括项目自有指南和已核对来源的上游开发技能，见[技能目录](../skills/README.zh-CN.md)；`hub-backend/plugins/*.json` 提供通用插件与工作流。遵循[插件协议](plugin-authoring.md)保持版本不可变、权限最小化及导入审查。新增内置技能还需要显式更新 `tools/distribution/PUBLIC-SOURCE.json` 的发布范围，并保留原始许可和来源说明。

模型、Codex 等执行器及外部插件使用用户自行配置的凭据和授权。不要把外部商业技能、真实密钥、组织地址或业务样本加入示例。

## 提交前验证

从根目录运行与修改有关的检查：

```sh
python3 -m unittest tools.dev.test_start_local
node tools/check-public-source.cjs
node tools/check-repository-layout.cjs
node tools/check-third-party.cjs
node tools/check-docs.cjs
python3 tools/security/scan_secrets.py --download
```

涉及启动过程时，再运行 `python3 tools/dev/verify_local_start.py --desktop`，需要网络和图形桌面。纯文档修改核对链接和命令即可，不必声称完成未实际运行的平台验收。按[贡献指南](contributing.zh-CN.md)审核并暂存新增源码文件；源码包清单在导出时自动生成，不提交到仓库。

## 注释约定

新增公开接口、安全边界和兼容性说明优先使用英文，描述当前行为及原因。内部讨论、个人经历、临时机器环境和失效实现说明应改写或移除。保留协议标识、存储键、测试语义及第三方许可原文；界面翻译、技能指令和 Prompt 单独验证，不与注释整理混改。

GitHub 自动验证范围和平台限制见[配置说明](../.github/CI.md)。秘密扫描只覆盖当前源码，不能代替私有历史审查。

## 文档与翻译

GitHub 上通过页面顶部的相对链接切换语言，下载后的源码也可沿同样路径阅读，无需文档服务。

- 根目录、组件目录和 `docs/` 文档索引统一使用英文 `README.md` 和中文 `README.zh-CN.md`。原来的 `README.en.md` 和 `docs/index.en.md` 地址保留为新版英文入口链接。
- 根目录 `NOTICE.md` 为英文，中文版为 `NOTICE.zh-CN.md`。`CONTRIBUTING.md`、`SECURITY.md` 为英文，中文版放在 `docs/contributing.zh-CN.md` 和 `docs/security.zh-CN.md`。其他配对指南沿用 `name.md`（中文）/ `name.en.md`（英文）。
- 修改启动命令、前置条件、数据或权限说明时同步两种语言，顶部保留互相切换和返回导航的链接。
- 增加语言时使用明确后缀（例如 `.ja.md`），在首页与文档索引登记已经完成的页面；未翻译内容标明原语言，不提供空页面或把中文链接标作英文。
- 文档使用相对链接，不写死某个 GitHub 仓库地址或私有开发分支，便于 Fork 和源码包复用。
