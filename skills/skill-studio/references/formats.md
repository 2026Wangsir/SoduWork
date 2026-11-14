# 兼容布局与导出边界

这些目标共用 Agent Skills 的 SKILL.md，不是五套互相独立的业务标准。保持一份业务源文件，通过布局适配进入不同宿主。核对日期：2026-09-08。

| 导出目标 | 压缩包中的路径 | 使用方式 |
| --- | --- | --- |
| portable | 技能名/SKILL.md | 解压到目标支持的 Skill 根目录 |
| codex | .agents/skills/技能名/SKILL.md | 解压到项目根；保留 agents/openai.yaml |
| claude | .claude/skills/技能名/SKILL.md | 解压到项目根，按 Claude Code 的 Skill 入口调用 |
| copilot | .github/skills/技能名/SKILL.md | 解压到项目根，在支持 Agent Skills 的 Copilot 中使用 |
| soduwork | 技能名/SKILL.md | .skill 走现有技能预检与导入，安装后在技能列表中启用 |

SoduWork 的 .skill 是标准 ZIP，保留原始 Skill 名称及全部实际材料。包中仅包含一个完整技能目录；安装预检检查路径、文件数量、大小、frontmatter 与资源。版本用于导出文件名与报告，技能内容以校验摘要标识。

只有 Codex 目标在缺少 agents/openai.yaml 时补充展示字段；已有文件原样保留，不覆盖策略。其他文件逐字节保留。无需为纯 Skill 伪造 .codex-plugin/plugin.json、MCP 服务或工作流。

## 校验器的范围

工具使用 Node.js 18+ 标准库。接受 UTF-8 SKILL.md；frontmatter 支持顶层字符串/布尔/数字、字符串块（|、> 及 -/+ 修饰）、metadata 的两空格缩进字符串映射。复杂 YAML（anchors、tags、序列、嵌套对象等）拒绝导出并提示；不要偷偷改掉已有配置来通过检查。校验对象是可移植子集，不是完整 YAML 解析器。

name 长度 1–64，使用小写字母、数字和单连字符；description 非空且不超过 1024 字符。必需字段必须为字符串。引用检查覆盖 Markdown 链接，不验证任意正文/脚本里的动态路径。包最多 64 文件、合计 8 MiB，拒绝符号链接、隐藏目录、可执行安装程序、密钥文件和非跨平台文件名。只做常见凭据扫描，不替代人工脱敏和安全审核。

结构正确不等于业务正确；脚本不会运行候选 Skill。完成后应另做业务案例测试。导出不安装、不上传，不修改原包。

## 宿主差异

Claude 的 context、agent、model、hooks、disable-model-invocation、user-invocable 等配置不是通用标准。存在这些字段时，仅允许 portable 和 claude 目标；需要其他宿主时先人工设计等效方案。
agents/openai.yaml 是 Codex 专有配置；有该文件时只允许 portable 和 codex 目标，避免在别处悄悄丢掉调用限制或依赖声明。
allowed-tools 由各宿主解释，不会自动转换成系统授权。SoduWork 不从它猜测网络、MCP 或运行权限；需要工具时在安装后显式配置和确认。仓库级指令（AGENTS.md、CLAUDE.md）不等同于 Skill。

## 官方参考

- [Agent Skills 规范](https://agentskills.io/specification)
- [OpenAI Skill 指南](https://developers.openai.com/codex/skills/)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [VS Code / Copilot Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
