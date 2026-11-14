# 登录提示实施计划

**简体中文** · [English](2026-11-14-login-feedback.md)

**目标：** 密码登录时区分账号不存在和密码错误，使用已确认的字段提示和找回入口。

**设计：** 保留两个密码登录接口、账号解析和尝试次数限制。分别返回 HTTP 401 与 `ACCOUNT_NOT_FOUND`、`PASSWORD_INCORRECT`；页面按错误码展示本地化字段提示，其他错误沿用现有处理。无需增加账号查询接口或数据库迁移。

**技术：** FastAPI、SQLAlchemy、Electron 页面 JavaScript/CSS、Python unittest 和 Node 测试工具。

- [x] 在 `hub-backend/test_email_auth.py` 增加两个接口的测试，覆盖账号不存在、密码错误、设备和账号数据不变、尝试次数持久记录。确认新增测试先失败，再拆分 `app/api/client_auth.py` 和 `app/api/client_email_auth.py` 的验证分支。
- [x] 在 `client/tests/email-auth-policy.test.cjs` 增加字段提示、焦点、编辑清除、模式切换、多语言、找回入口和其他错误的行为测试。确认先失败，再调整 `components/client-auth/email-auth.js`、`account-center.css` 和 `core/locales/builtin-ui.js`。兼容密码重置及旧服务的统一错误。
- [x] 运行客户端 `npm test`、后端邮箱认证测试，以及公开源码、第三方、文档和密钥扫描检查。使用模拟接口和隔离配置，在真实 Chromium 中验证提示位置、焦点、错误清除、找回导航及密码显示状态复位。审查差异，说明无法执行的检查。

用户已在对话中确认设计并要求开始实施。在当前对话完成，保留修改供审阅，不自动提交。
