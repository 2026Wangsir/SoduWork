# 内置技能

**简体中文** · [English](README.md) · [开发指南](../docs/development.md)

SoduWork 通过各目录的 `SKILL.md` 发现技能。Hub 技能目录、源码桌面客户端和 Runner
打包使用此目录。桌面翻译表中的展示名称不代表技能已安装，也不能代替技能正文。

## 开发技能目录

| 来源 | 技能 |
| --- | --- |
| SoduWork | `browser-use`、`computer-use` |
| Matt Pocock | `code-review`、`codebase-design`、`diagnosing-bugs`、`domain-modeling`、`grill-with-docs`、`improve-codebase-architecture`、`prototype`、`resolving-merge-conflicts`、`tdd`、`wizard` |
| Anthropic | `frontend-design` |
| Superpowers | `using-superpowers`、`brainstorming`、`writing-plans`、`executing-plans`、`subagent-driven-development`、`dispatching-parallel-agents`、`test-driven-development`、`systematic-debugging`、`verification-before-completion`、`requesting-code-review`、`receiving-code-review`、`finishing-a-development-branch`、`using-git-worktrees`、`writing-skills` |

另外包含工程技能使用的追问方法 `grilling`。必要的方法参考文件也随使用它们的技能包
保留，避免单独导出后缺失说明。原有办公、演示文稿、任务、应用及连接器技能继续保留。

## 加载与部署

- 更新 Hub 源码或镜像并重启后加载此目录。所有内置技能默认向组织开放；首次策略升级
  也会重新开放已有内置技能。此后管理员关闭的项会保留，重启不会再次打开；后来新增
  的内置技能默认开放。
- Browser Use、Computer Use、Office 保留原有基础可用规则，个人开关仍独立于组织默认策略。
- 技能正文仍保存在文件中，数据库保存版本化开放策略，不逐条复制技能内容。组织默认
  策略不覆盖已保存的个人选择，也不授予额外工具权限。公司导入包和外部目录技能仍需
  明确开放；导入包不会继承同名内置技能的默认权限。
- 源码客户端读取当前检出目录的技能。已打包的客户端和 Runner 需要重新构建并更新
  才能获得新增资源；只更新 Hub 不会升级已安装客户端的内置文件。
- 技能是操作说明和配套资源，不会安装模型服务、浏览器、外部命令行工具或子代理能力。
  `computer-use` 当前操作 Windows 桌面；安装此技能不代表具备 macOS 原生桌面控制能力。
- 每个引入的技能独立保留许可和来源，见[第三方技能说明](THIRD-PARTY.zh-CN.md)。
  不包含特定宿主的 `agents/openai.yaml` 展示元数据和外部插件钩子。

安装后端测试依赖后，在仓库根目录运行：

```sh
python3 -m unittest discover -s hub-backend -p test_bundled_development_skills.py
python3 -m unittest discover -s hub-backend -p test_skill_policy_defaults.py
node tools/check-public-source.cjs
node tools/check-third-party.cjs
```

回归检查使用隔离数据验证 Hub 发现、Runner 资源发现、导出再导入和管理员策略。
这些结果不代表真实模型执行质量或原生安装包验收结果。
