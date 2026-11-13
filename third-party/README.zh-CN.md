# 第三方分发材料

**简体中文** · [English](README.md) · [依赖声明](../NOTICE.zh-CN.md)

本目录保留经过核验的许可原文和来源证据。项目 MIT 许可证不覆盖第三方内容。`manifest.json` 摘要按 UTF-8/LF 计算；更新时核对版权人、条款、固定版本和实际发行物，不能仅改摘要来通过检查。

逐文件来源核验、MIT 适用范围及本地验证构建方式见 [MIT 审查边界](mit-review.md)。第三方原始版权和许可证保持不变。

## 构建接入

- 客户端 beforePack 检查许可快照和锁定版本，收集实际复制的 Pi/SSH 依赖声明；Electron LICENSE 和 Chromium notices 由 electron-builder 保留。
- 许可位于 README 的组件保留全文；缺失原文需要经过审查的固定版本证据，未知缺失项阻断构建。
- Runner 保留 Python 依赖元数据和 wheel 内许可；Hub 保留本目录与项目 LICENSE。随附技能包含 `tools/distribution/PUBLIC-SOURCE.json` 声明的项目自有指南和已核对来源的上游开发技能。每个引入的技能保留原始许可、固定版本来源和适配记录，见[技能许可说明](../skills/THIRD-PARTY.zh-CN.md)。
- 这些检查不是完整 SBOM、漏洞扫描或法律许可认证。

## Hub 镜像中的 Python 依赖

Hub 镜像构建时按 `hub-backend/requirements.txt` 用 pip 安装 Python 依赖。各依赖的原始许可文件随安装保留在镜像的 Python `site-packages` 中对应的 `*.dist-info` 目录里。

**Pillow**：Hub 用它校验和处理图片，包括用户头像（校验后裁成 256×256）、AI 生成图片的格式校验（PNG、JPEG、WEBP）和文件库缩略图。

- 项目：https://python-pillow.github.io/
- 源码：https://github.com/python-pillow/Pillow
- 版本：12.x（`hub-backend/requirements.txt` 限定 `>=12.3,<13`，以镜像实际安装版本为准）
- 许可：MIT-CMU。版权归 Secret Labs AB、Fredrik Lundh、Jeffrey A. Clark 及贡献者所有。

MIT-CMU 许可要求保留版权和许可声明，并且未经书面许可，不得用作者的名字为相关分发做宣传。SoduWork 不修改 Pillow，许可原文保留在镜像中 Pillow 的 `dist-info` 目录。Pillow 的 wheel 还捆绑了 libjpeg、libpng、zlib、libwebp、FreeType 等图像库，这些库的许可同样收录在该目录的许可文件中。

## 二进制发行尚需完成

1. **proxy-agent-negotiate 1.1.0**：固定版本的 npm 包和上游标签声明 MIT，发布负责人已审核并接受该声明用于二进制分发；证据保留在 `licenses/proxy-agent-negotiate-upstream-evidence.txt`。Pi 1.4.0 已移除旧版原生剪贴板依赖。
2. **Windows 外壳对应源码**：[获取清单](windows-shell-corresponding-source.md)已记录版本和核验步骤；具体发行物仍须实际归档 PortableGit/MSYS2/Bash/7-Zip 对应源码、补丁和构建材料，并核对摘要。清单或上游链接不代表某个安装包已完成该项。
3. **各平台最终清单**：`native-artifacts.json` 是源树静态盘点；Windows、macOS、Linux 最终安装包均须由各自构建生成逐件记录和许可材料。
4. **图标和商标**：分开记录图形来源、分发许可与商标使用边界；兼容服务名称不表示官方认证。

当前单机自托管配方不部署 Redis 或 Valkey。下游新增服务组件需自行登记依赖和审查许可。

`public-release.json` 区分已取得的源码证据与尚未完成的二进制发行材料。安装包和容器镜像须针对实际发行物完成上述各项后再发布。
