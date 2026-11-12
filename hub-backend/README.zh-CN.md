# SoduWork Hub（后端）

**简体中文** · [English](README.md) · [开发指南](../docs/development.md#hub-后端)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

SoduWork 的任务与协作中枢，提供身份、权限、执行治理、插件、资料和客户端接入。
FastAPI + SQLAlchemy(async) + PostgreSQL（本地开发可回退 SQLite）。

模块职责与状态归属见[首版范围](../docs/release-scope.md)。

## 快速开始（本地 SQLite，零配置）

```bash
cd hub-backend
python3 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # *nix
# 如需覆盖配置，创建私有 .env；首次体验推荐根目录 sh start.sh
.venv/Scripts/python -m uvicorn app.main:app --reload --port 9080
```

打开 http://127.0.0.1:9080/docs 查看 API 文档，健康检查为 `GET /healthz`。

## 质量门禁

所有后端冒烟都登记在 `quality_manifest.py`，新增脚本未登记会直接阻断发布：

```bash
# 先在专用虚拟环境安装测试依赖（含 Runner 构建契约所需 PyInstaller）
python3 -m pip install -r requirements-test.txt

# 日常提交 / CI：离线发布门禁
python3 quality_gate.py --profile release --scope backend

# 发布前：完整离线回归、客户端测试与管理端生产构建
python3 quality_gate.py --profile extended --scope all

# 查看发布、扩展、真实环境三层清单与前置条件
python3 quality_gate.py --list
```

`live` 层可能连接真实 Hub、Runner、代码平台、模型或业务库，默认拒绝执行，不能用来替代离线发布门禁。详细口径见 [`../docs/release-scope.md`](../docs/release-scope.md)。

冒烟脚本集中在 [`smoke/`](smoke/) 目录。单独运行时，在 `hub-backend/` 目录使用模块命令，例如 `python3 -m smoke.smoke_capabilities`；质量门禁会选择已登记的模块。单元测试和 `tests/` 集成辅助脚本保留现有位置。

## Harness² 推演恢复

Harness² 在原生执行前完成七个无工具推演阶段。仅当模型完整响应明确报告达到输出 token 上限时，整轮允许重试同一阶段一次：预算最多为首次的两倍，同时不得超过 16,384 token 和已配置的模型上限。两次尝试的实际用量均保留，共用原有整轮时限和 token 预算，客户端会显示重试进度。成功恢复后的预算会在本轮后续同类阶段沿用，仍受配置上限约束，不增加重试次数。未完成的计划会被丢弃；此恢复路径不重试异常断流、HTTP 错误或原生执行。持续截断或较低的配置上限仍会在执行前报错。

## 连数据库

在 `.env` 里设 `DATABASE_URL`：

| 场景 | DATABASE_URL |
| --- | --- |
| 本地零配置（默认） | `sqlite+aiosqlite:///./soduwork_hub.db` |
| 自建 PostgreSQL | `postgresql+asyncpg://soduwork:<PASSWORD>@db.example.com:5432/soduwork` |
| 单机 Docker 自部署 | 根目录 `python3 ops/self-host/deploy.py up`，自动生成独立实例的数据库口令 |

> **密钥不入库**：`.env` 已被 `.gitignore` 排除；部署凭据通过密钥管理或环境配置提供，勿写进提交文件。
> 使用专用数据库和最小权限账号；部署与备份恢复见 [`../ops/self-host/README.md`](../ops/self-host/README.zh-CN.md)。实际内部地址和运维记录应单独保管。

## API 概览

- 客户端契约（设备登记 → 管理员激活 → 短期 `Device` 会话；长期设备密钥在 Hub 只存摘要）
  - `GET/POST /api/v1/tasks`、`GET/PATCH/DELETE /api/v1/tasks/{id}`
  - `POST /api/v1/tasks/batch-update`、`POST /api/v1/tasks/clear-done`（只清 done）
  - `POST /api/v1/tasks/{id}/agent/{run|retry|takeover}`
  - `GET/PUT /api/v1/config`
  - `POST /api/v1/clients/enroll`（登记/心跳，激活后签发短期会话）
  - `WS /api/v1/ws?device=<设备ID>&session=<短期会话>`（实时推送）
- 管理端
  - `POST /api/v1/admin/login` `{user,pass}` → 短期登录 token
  - `GET /api/v1/admin/clients`、`GET /api/v1/admin/tasks`（需 `Authorization: Bearer <token>`）
  - `POST /api/v1/admin/dispatch` `{title,...,targets:[设备ID]}` → 平台建任务下发（origin=dispatch）

## 客户端接入

设备长期密钥只由 Electron 主进程持有。客户端通过 `POST /api/v1/clients/enroll` 登记并轮换短期会话，
业务请求使用 `Authorization: Device <session>`，WebSocket 使用同一短期会话；长期密钥不得进入渲染进程、日志或 URL。
任务与流程状态以 Hub 为唯一事实源，本地缓存只用于断网展示和待同步命令，不能反向覆盖服务端新状态。

账号会话目录与来源投影包含 `contentLocation`：旧 Hub 正文为 `hub`，原始终端保留正文为 `source`，源版本匹配的有效迁移副本为 `replica`，无法确认引用时为 `unknown`。该字段不暴露私有副本标识，也不授予访问权限；客户端仍须执行既有账号、Hub 与执行权限检查。不能根据未知位置删除可能独立存在的本地副本。

### 统一需求池升级边界（0053）

需求列表、详情和更新使用原 `/api/v1/tasks` 契约。`requirementContent` 是需求正文；已有交付 Task 的 `title/note` 仍可能包含私人执行上下文，需求编辑应携带 `requirementVersion`，只更新需求投影。`canEditRequirement` 与 `canViewExecution` 分离；共享需求不会开放执行记录、评论或输出附件。

需求项目选择复用 `GET /api/v1/projects` 中有效的 Hub 业务项目、原有组织范围及公开项目。只有需求所属设备和账号能够在从未开始执行时，携带当前 `requirementVersion` 更改或清除 `projectId`；`null` 表示取消关联。已关联仓库的需求固定归属原项目。明确新增的关联必须有效、可见且与仓库一致；未改变的历史关联和仅传仓库的旧调用保留原有行为。个人对话项目不是 Hub 业务项目。

旧需求并入交付 Task 时，完整原记录保存在 `legacy_requirements`，旧创建人、需求方和经办人的范围保存在 `task_requirement_access`。只有部分原需求权限的人只能读取自己的快照和材料，不能改写聚合需求或查看其他原需求。列表、详情、附件访问和 WebSocket 使用同一规则。归档后需先恢复再派活；完成后归档保留验收和完成状态。

升级前必须备份数据库和匹配版本程序。0053 在事务中迁移并删除旧表；文件内容及对象存储键不变。同一交付 Task 的原需求若来自不同可见范围，升级明确失败并回滚，不能静默扩大权限。重复执行不会重复迁移。统一需求开始产生新写入后，自动降级被禁止，应使用升级前数据库备份和对应程序一起回滚。旧 `/work-items` 路由返回 410，旧插件 `work.task.create` 仅作为统一 Task 创建的别名。

隔离验证入口：`python3 -B tests/unified_requirements_upgrade.py --sqlite` 和 `python3 -B tests/unified_requirements_upgrade.py`。后者仅创建随机本机 PostgreSQL 临时实例，完成后停止并清理，不使用业务数据库。权限回归为 `test_unified_requirements_acl.py`，包含真实迁移后的 HTTP 多身份和 WebSocket 投影检查。

## 需求自动化草稿

具有管理权限的用户可将未归档需求的公开内容复制为独立的自动化草稿。打开或取消表单不会创建记录。保存始终创建未启用的自动化，不改变原需求、需求版本或已有自动化关联。之后编辑或启用自动化与原需求相互独立。

此路径的 `POST /api/v1/schedules` 接收 `sourceRequirement: {id, requirementVersion}` 和稳定的 `creationRequestId`。Hub 检查当前管理权限、归档状态和预期版本，随后由服务端生成 `source_requirement` 快照，记录来源 ID、公开标题及版本。响应以 `sourceRequirement` 返回这三项；普通自动化编辑不能替换来源，来源记录也不会扩大对原需求的访问权限。不复制执行路由、凭据或本地模型引用。

同一账号、设备重复发送相同创建请求会返回已创建的自动化；同一标识携带不同内容时返回 409。原需求后来发生变化也不影响恢复丢失的创建响应。迁移 `0088_schedule_requirement_source` 为已有自动化增加默认空 JSON 字段，不推断历史来源，也不改写旧关联。
