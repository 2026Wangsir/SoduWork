# SoduWork 自托管快捷部署

**简体中文** · [English](README.md) · [文档导航](../../docs/README.zh-CN.md)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

适用于全新单机部署：一个 Hub、同源管理页面和 PostgreSQL 16。Windows/macOS 使用 Docker Desktop 的 Linux 容器；Linux 使用 Docker Engine 与 Compose v2。主机需 Python 3.12+，不需要安装 Node.js、数据库或公司 CI。镜像从当前源码构建，默认使用 Docker Hub、npm、PyPI 和 PostgreSQL 官方源，不需要访问公司镜像仓库。

这条入口不会修改既有集群配置、NFS、当前数据库或客户端。没有 Redis/Valkey 依赖；多节点部署需要单独设计共享存储与协调配置。

Compose 和 GitHub 发布统一使用 `ops/self-host/Dockerfile`，原来的
`Dockerfile.server` 已合并删除。镜像包含 Pi 0.83.0、Codex 0.147.0、Runner
源码，以及备份、客户端发布包导入和内置插件发布工具。镜像使用 UID/GID 10001
运行，默认只启动 Hub；已有挂载目录必须允许该用户写入，安装 CLI 不等于注册或启动 Runner。
Pi/Codex 的原始许可快照随镜像保存在 `/srv/app/third-party/licenses`，来源和摘要登记在
`third-party/manifest.json`。

默认 `HUB_BASE_IMAGE=deps` 从官方源构建依赖。重复构建时，可用
`docker build --target deps -f ops/self-host/Dockerfile .` 制作依赖基础镜像，
再通过 `--build-arg HUB_BASE_IMAGE=<image@sha256:digest>` 指定经过审核的不可变引用。
基础镜像必须保留 `deps` 阶段的 CLI 版本、Node.js、系统工具和许可材料；Python
依赖会按当前源码重新核对安装。发布构建还通过构建参数设置 `SODUWORK_VERSION`
（完整提交）、`SODUWORK_HUB_VERSION` 和 `SODUWORK_RELEASE_TAG`，本地构建默认版本为 `dev`。

## 一条命令启动

安装并启动 Docker 后，在源码根目录执行：

```sh
# Windows:
py ops/self-host/deploy.py up
# macOS / Linux:
python3 ops/self-host/deploy.py up
```

也可以运行 `ops/self-host/deploy.cmd up` 或 `sh ops/self-host/deploy.sh up`。首次自动建立私有配置，生成互不相同的数据库密码、管理员初始密码、签名密钥与连接器授权加密密钥，然后构建管理页面和后端镜像、迁移新数据库。完成健康检查后才显示就绪地址：**http://127.0.0.1:18989**。初次构建需要联网和几 GB 可用磁盘空间；速度取决于镜像源与网络。

获取本实例的初始管理员密码：

```sh
python3 ops/self-host/deploy.py credentials
```

账号为 `admin`。登录后在用户管理中修改密码。`credentials` 显示的是首次引导密码，不会重置数据库里已修改的密码。默认启动和构建日志不输出明文口令。

按需使用空闲端口与独立实例目录：

```sh
python3 ops/self-host/deploy.py up --port 18990 --data-dir "/private/soduwork-team"
```

目录必须在源码之外且为空。每个目录有独立 Compose 项目名和数据卷；后续操作必须使用同一 `--data-dir`。不支持意外指向远程 Docker daemon 的 context，避免把本机命令运行到另一台服务器。Docker 应使用 Linux 容器模式。

## 停止、重启与检查

```sh
python3 ops/self-host/deploy.py status
python3 ops/self-host/deploy.py logs
python3 ops/self-host/deploy.py stop
python3 ops/self-host/deploy.py up --no-build
```

`stop` 只停止该目录对应的实例，保留数据库、文件和密钥；不会执行 `down -v` 或清理其他 Docker 资源。构建或健康检查失败会返回失败，不把残缺环境当作启动成功；原命令可重试。`--no-build` 用于重启已经成功构建的同版本镜像；更新源码后应使用 `up` 重新构建。

默认数据目录：

| 系统 | 私有配置目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SoduWork\self-host` |
| macOS | `~/Library/Application Support/SoduWork/self-host` |
| Linux | `$XDG_DATA_HOME/soduwork/self-host`，或 `~/.local/share/soduwork/self-host` |

`deployment.json` 内含本实例密码与密钥，仅保存在受限目录，不要提交或发给他人。数据库和业务文件保存在 Docker 命名卷，名称前缀是该文件的 `project`；**配置目录本身不是业务数据备份**。停止服务不删除数据卷，Docker Desktop 的重置/卸载或手动删卷会删除数据。

## 团队访问与执行环境

Hub 与 PostgreSQL 默认都不会裸露在局域网：Hub 仅映射 `127.0.0.1`，PostgreSQL 不映射主机端口。需要团队使用时，在这台服务器配置自己的 HTTPS 反向代理，将其转发到 `127.0.0.1:18989`，支持 WebSocket 和长时间流式响应。首次初始化时设置公开地址：

```sh
python3 ops/self-host/deploy.py up --public-url https://work.example.com
```

`example.com` 是占位地址，必须换成自己的域名。已有实例在停止后修改私有 `deployment.json` 的 `publicUrl`，再运行 `up --no-build`。域名必须为 HTTPS 源地址，不带 `/api`、账号或查询参数。脚本不申请证书、不修改 DNS 或系统防火墙；反向代理上线后仍需验证自己的 HTTPS 登录、文件上传、WebSocket 与流式对话。

桌面客户端连接这个 Hub 地址并登录。模型与连接器使用用户自己的合法授权；仓库不提供服务密钥。默认不在管理容器内自动执行 Agent，云端任务应在管理端登记独立 Runner，本地任务由客户端的 Runner 处理。这样管理服务不会自动获得宿主机 Docker socket 或 SSH 凭据。容器内以普通用户运行，不挂载 Docker socket。

## 更新、备份与回退

首次部署与正式升级不同：升级前停止派发新任务，等待当前任务结束，备份数据库及全部业务文件卷，并单独备份私有配置与当前源码版本。数据库和资料库必须按同一时间点恢复。已有完整加密备份工具见 [full_backup.py](../../hub-backend/full_backup.py)，数据库校验与恢复工具见 [db_admin.py](../../hub-backend/db_admin.py)。组织自己的备份存储需要实际演练恢复，再用于生产。

完成备份后，执行 `python3 ops/self-host/deploy.py stop`，切换到已验证的新源码，再运行 `python3 ops/self-host/deploy.py up`。此入口单实例自动执行版本化数据库迁移；迁移失败不会健康上线。不要同时运行同一数据库的多个迁移进程。回退必须恢复匹配版本的源码、数据库、文件卷和密钥，不能直接用旧源码连接已升级数据库。

此入口管理独立的单机实例。已有多节点部署应使用与其数据库和共享存储匹配的升级流程。

## 网络与验证范围

需要离线部署时，应先在同平台/架构联网构建并准备基础镜像、最终 Hub 镜像、PostgreSQL 镜像和固定依赖缓存，再在目标机执行 `up --no-build`；它不承诺首次断网下载成功。可按组织规则配置 Docker/npm/pip 的镜像代理与 CA，保持 TLS 校验，不建议关闭证书验证。代理故障不会被脚本静默忽略。

开发者检查入口：

```sh
python3 -m unittest tools.dev.test_start_local tools.dev.test_deploy
node --test client/tests/start-client.test.cjs
python3 tools/dev/verify_local_start.py
```

最后一项真实启动独立的源码 SQLite 实例并做 HTTP、持久化和停止验证；不代表 Docker、macOS/Linux 原生桌面或模型推理已验收。跨平台发布应分别运行原生测试，并在独立 Docker 项目完成实际登录与数据重启验证。
