/* Presentation catalog for bundled Skills; executable SKILL.md files remain unchanged. */
(function (global) {
  const rows = {
    'browser-use': [
      ['浏览器操作', '浏览网页、操作页面并核实结果。'], ['Browser Use', 'Browse, interact with pages and verify results.'],
      ['ブラウザー操作', 'ウェブページを閲覧・操作し、結果を確認します。'], ['브라우저 사용', '웹페이지를 탐색하고 조작하며 결과를 확인합니다.']],
    'computer-use': [
      ['电脑操作', '在授权范围内操作桌面应用并检查结果。'], ['Computer Use', 'Operate desktop apps within granted permissions and verify results.'],
      ['パソコン操作', '許可された範囲でデスクトップアプリを操作し、結果を確認します。'], ['컴퓨터 사용', '허용된 범위에서 데스크톱 앱을 조작하고 결과를 확인합니다.']],
    office: [
      ['Office 文档', '创建、编辑与检查文档、表格和演示文稿。'], ['Office Documents', 'Create, edit and inspect documents, spreadsheets and presentations.'],
      ['Office 文書', '文書、表計算、プレゼンテーションを作成・編集・確認します。'], ['Office 문서', '문서, 스프레드시트, 프레젠테이션을 만들고 편집하며 확인합니다.']],
    pptx: [
      ['演示文稿', '制作与修改幻灯片，检查排版和内容。'], ['Presentations', 'Create and revise slides; check layout and content.'],
      ['プレゼンテーション', 'スライドを作成・修正し、レイアウトと内容を確認します。'], ['프레젠테이션', '슬라이드를 만들고 수정하며 레이아웃과 내용을 확인합니다.']],
    'frontend-design': [
      ['前端设计', '设计并实现有辨识度、可使用的网页界面。'], ['Frontend Design', 'Design and implement distinctive, usable web interfaces.'],
      ['フロントエンド設計', '使いやすく個性のあるウェブ画面を設計・実装します。'], ['프런트엔드 디자인', '개성 있고 사용하기 편한 웹 화면을 설계하고 구현합니다.']],
    'skill-studio': [
      ['技能创建与优化', '创建、调整、验证并导出可复用的技能包。'], ['Skill Authoring', 'Create, improve, validate and export reusable skill packages.'],
      ['スキル作成・改善', '再利用可能なスキルを作成・改善・検証・エクスポートします。'], ['스킬 제작 및 개선', '재사용 가능한 스킬을 만들고 개선하며 검증하고 내보냅니다.']],
    'mcp-studio': [
      ['连接器配置', '编写连接器配置，检查权限并指导连接测试。'], ['Connector Configuration', 'Prepare connector configurations, review permissions and guide connection tests.'],
      ['コネクター設定', '接続設定を作成し、権限を確認して接続テストを支援します。'], ['커넥터 설정', '연결 설정을 작성하고 권한을 확인하며 연결 테스트를 안내합니다.']],
    'app-developer': [
      ['即用开发', '制作、安装并验证可直接使用的应用。'], ['App Development', 'Build, install and verify ready-to-use apps.'],
      ['アプリ開発', 'すぐに使えるアプリを作成・インストール・検証します。'], ['앱 개발', '바로 사용할 수 있는 앱을 만들고 설치하며 검증합니다.']],
    'product-incubator': [
      ['产品孵化', '从产品需求推进到实现、验证和可交付成果。'], ['Product Incubator', 'Take product requirements through implementation, verification and delivery.'],
      ['製品開発支援', '製品要件から実装、検証、成果物の納品まで進めます。'], ['제품 개발 지원', '제품 요구사항부터 구현, 검증, 납품까지 진행합니다.']],
    'agent-product-design': [
      ['智能体产品设计', '梳理智能体产品的用户流程、能力与交付边界。'], ['Agent Product Design', 'Define user flows, capabilities and delivery boundaries for agent products.'],
      ['エージェント製品設計', 'エージェント製品の利用フロー、機能、納品範囲を整理します。'], ['에이전트 제품 설계', '에이전트 제품의 사용자 흐름, 기능, 납품 범위를 정리합니다.']],
    brainstorming: [
      ['需求与方案探索', '澄清目标、比较方案并形成设计共识。'], ['Brainstorming', 'Clarify goals, compare approaches and agree on a design.'],
      ['アイデア検討', '目標を明確にし、案を比較して設計方針をまとめます。'], ['아이디어 탐색', '목표를 명확히 하고 방안을 비교하여 설계 방향을 정합니다.']],
    'writing-plans': [
      ['编写实施计划', '把已确认的设计拆成可执行、可验证的步骤。'], ['Implementation Planning', 'Turn an agreed design into actionable, verifiable steps.'],
      ['実装計画作成', '合意した設計を実行・検証できる手順に分けます。'], ['구현 계획 작성', '합의된 설계를 실행하고 검증할 수 있는 단계로 나눕니다.']],
    'executing-plans': [
      ['执行实施计划', '按计划推进工作，并在检查点验证结果。'], ['Plan Execution', 'Carry out an implementation plan and verify checkpoints.'],
      ['計画の実行', '計画に沿って作業を進め、各チェックポイントで検証します。'], ['계획 실행', '계획에 따라 작업하고 각 점검 단계에서 결과를 검증합니다.']],
    'writing-skills': [
      ['编写技能', '编写、测试并完善可重复使用的技能说明。'], ['Writing Skills', 'Author, test and refine reusable skill instructions.'],
      ['スキルの執筆', '再利用可能なスキルの手順を作成・テスト・改善します。'], ['스킬 작성', '재사용 가능한 스킬 지침을 작성하고 테스트하며 개선합니다.']],
    'code-review': [
      ['代码审查', '检查代码正确性、风险和可维护性。'], ['Code Review', 'Review code correctness, risks and maintainability.'],
      ['コードレビュー', 'コードの正確性、リスク、保守性を確認します。'], ['코드 검토', '코드의 정확성, 위험, 유지보수성을 확인합니다.']],
    'requesting-code-review': [
      ['发起代码审查', '整理变更和验证证据，发起有针对性的审查。'], ['Request Code Review', 'Prepare changes and verification evidence for focused review.'],
      ['コードレビュー依頼', '変更内容と検証結果を整理してレビューを依頼します。'], ['코드 검토 요청', '변경 내용과 검증 결과를 정리하여 검토를 요청합니다.']],
    'receiving-code-review': [
      ['处理审查意见', '核实审查建议，修正问题并验证影响。'], ['Review Feedback', 'Evaluate review feedback, resolve issues and verify impact.'],
      ['レビュー対応', 'レビュー提案を検証し、問題を修正して影響を確認します。'], ['검토 의견 처리', '검토 제안을 확인하고 문제를 수정하며 영향을 검증합니다.']],
    'systematic-debugging': [
      ['系统化调试', '收集证据、定位根因并验证修复。'], ['Systematic Debugging', 'Gather evidence, identify root causes and verify fixes.'],
      ['体系的デバッグ', '証拠を集め、根本原因を特定して修正を検証します。'], ['체계적 디버깅', '증거를 수집하고 근본 원인을 찾아 수정 결과를 검증합니다.']],
    'diagnosing-bugs': [
      ['故障诊断', '复现故障，追踪原因并制定修复步骤。'], ['Bug Diagnosis', 'Reproduce failures, trace causes and plan corrective steps.'],
      ['不具合診断', '不具合を再現し、原因を追跡して修正手順をまとめます。'], ['오류 진단', '오류를 재현하고 원인을 추적하여 수정 절차를 정합니다.']],
    'test-driven-development': [
      ['测试驱动开发', '先建立失败用例，再实现并重构。'], ['Test-Driven Development', 'Start with a failing test, implement behavior, then refactor.'],
      ['テスト駆動開発', '失敗するテストから始め、実装後にリファクタリングします。'], ['테스트 주도 개발', '실패하는 테스트부터 작성하고 구현 후 리팩터링합니다.']],
    tdd: [
      ['测试驱动工作流', '通过失败、通过、重构的循环实现需求。'], ['TDD Workflow', 'Implement requirements through the fail, pass and refactor cycle.'],
      ['テスト駆動フロー', '失敗、成功、リファクタリングのサイクルで要件を実装します。'], ['테스트 주도 작업 흐름', '실패, 통과, 리팩터링의 순환으로 요구사항을 구현합니다.']],
    'verification-before-completion': [
      ['完成前验证', '在报告完成前运行检查并核对实际证据。'], ['Verify Before Completion', 'Run checks and inspect evidence before reporting completion.'],
      ['完了前の検証', '完了を報告する前にチェックを実行し、証拠を確認します。'], ['완료 전 검증', '완료를 보고하기 전에 검사를 실행하고 실제 증거를 확인합니다.']],
    'delivery-check': [
      ['交付检查', '检查交付文件、验收标准和必要的验证证据。'], ['Delivery Check', 'Check deliverables, acceptance criteria and required evidence.'],
      ['納品チェック', '成果物、受入基準、必要な検証結果を確認します。'], ['납품 점검', '산출물, 검수 기준, 필요한 검증 증거를 확인합니다.']],
    'using-git-worktrees': [
      ['Git 工作区隔离', '为开发任务准备独立工作区并验证隔离。'], ['Git Worktrees', 'Prepare an isolated worktree for development and verify isolation.'],
      ['Git 作業ツリー', '開発用の独立した作業ツリーを準備し、分離を確認します。'], ['Git 작업 트리', '개발용 독립 작업 트리를 준비하고 격리를 확인합니다.']],
    'finishing-a-development-branch': [
      ['完成开发分支', '验证变更并整理分支合并与交付步骤。'], ['Finish a Development Branch', 'Verify changes and prepare branch integration and delivery.'],
      ['開発ブランチの完了', '変更を検証し、ブランチ統合と納品を準備します。'], ['개발 브랜치 완료', '변경을 검증하고 브랜치 통합 및 납품을 준비합니다.']],
    'resolving-merge-conflicts': [
      ['解决合并冲突', '理解双方变更意图，整合冲突并回归验证。'], ['Resolve Merge Conflicts', 'Reconcile both change sets and run regression checks.'],
      ['マージ競合の解決', '双方の変更意図を理解し、競合を解決して回帰検証します。'], ['병합 충돌 해결', '양쪽 변경 의도를 이해하고 충돌을 해결한 뒤 회귀 검증합니다.']],
    'subagent-driven-development': [
      ['分工开发', '拆分开发任务并逐项审查集成结果。'], ['Delegated Development', 'Split development tasks and review integrated results.'],
      ['分担開発', '開発タスクを分担し、統合結果を順にレビューします。'], ['분담 개발', '개발 작업을 나누고 통합 결과를 차례로 검토합니다.']],
    'dispatching-parallel-agents': [
      ['并行任务分派', '识别可独立执行的任务，协调并行处理。'], ['Parallel Task Dispatch', 'Identify independent tasks and coordinate parallel work.'],
      ['並列タスクの割り当て', '独立して実行できるタスクを見つけ、並列作業を調整します。'], ['병렬 작업 배정', '독립적으로 실행할 작업을 찾아 병렬 작업을 조율합니다.']],
    'using-superpowers': [
      ['技能使用指南', '识别适用的工作方法并按技能流程开展任务。'], ['Skill Usage Guide', 'Select relevant methods and follow their workflow.'],
      ['スキル利用ガイド', '適切な作業方法を選び、スキルの手順に沿って進めます。'], ['스킬 사용 안내', '적절한 작업 방법을 선택하고 스킬 절차에 따라 진행합니다.']],
    'improve-codebase-architecture': [
      ['架构改进', '分析模块边界、依赖和维护成本，制定改进方案。'], ['Architecture Improvement', 'Assess module boundaries, dependencies and maintenance costs.'],
      ['アーキテクチャ改善', 'モジュール境界、依存関係、保守コストを分析します。'], ['아키텍처 개선', '모듈 경계, 의존성, 유지보수 비용을 분석합니다.']],
    'codebase-design': [
      ['代码架构设计', '设计职责明确、便于扩展和验证的代码结构。'], ['Codebase Design', 'Design clear, extensible and verifiable code structures.'],
      ['コード構造設計', '責務が明確で拡張・検証しやすいコード構造を設計します。'], ['코드 구조 설계', '책임이 명확하고 확장 및 검증이 쉬운 코드 구조를 설계합니다.']],
    'domain-modeling': [
      ['领域建模', '梳理业务概念、关系、规则和系统边界。'], ['Domain Modeling', 'Define business concepts, relationships, rules and system boundaries.'],
      ['ドメインモデリング', '業務概念、関係、ルール、システム境界を整理します。'], ['도메인 모델링', '업무 개념, 관계, 규칙, 시스템 경계를 정리합니다.']],
    grilling: [
      ['方案追问', '逐项澄清方案中的未知条件、依赖和取舍。'], ['Plan Interview', 'Clarify unknowns, dependencies and trade-offs in a plan.'],
      ['計画の聞き取り', '計画の未確定事項、依存関係、判断の選択肢を順に確認します。'], ['계획 질문', '계획의 미확정 사항, 의존성, 선택에 따른 장단점을 차례로 확인합니다.']],
    'grill-with-docs': [
      ['文档核查', '结合文档追问关键细节并验证设计假设。'], ['Document Review', 'Question key details and validate design assumptions against documentation.'],
      ['文書の精査', '文書を基に重要な詳細と設計上の前提を確認します。'], ['문서 점검', '문서를 바탕으로 핵심 세부사항과 설계 가정을 확인합니다.']],
    prototype: [
      ['原型制作', '将想法转为可演示、可验证的交互原型。'], ['Prototyping', 'Turn ideas into demonstrable, testable interaction prototypes.'],
      ['プロトタイプ制作', 'アイデアを実演・検証できる操作可能な試作品にします。'], ['프로토타입 제작', '아이디어를 시연하고 검증할 수 있는 인터랙션 시제품으로 만듭니다.']],
    img2threejs: [
      ['图片转三维场景', '根据参考图构建可交互的三维场景。'], ['Image to 3D Scene', 'Build an interactive 3D scene from a reference image.'],
      ['画像から三次元シーン', '参考画像を基に操作可能な三次元シーンを作成します。'], ['이미지를 3D 장면으로', '참고 이미지를 바탕으로 조작 가능한 3D 장면을 만듭니다.']],
    'mcp-tools': [
      ['连接器工具', '发现并调用已授权的连接器能力。'], ['Connector Tools', 'Discover and invoke authorized connector capabilities.'],
      ['コネクターツール', '許可されたコネクター機能を検索して呼び出します。'], ['커넥터 도구', '허가된 커넥터 기능을 찾고 호출합니다.']],
    'timesheet-fill': [
      ['工时填报', '整理工作记录并按规则填写工时。'], ['Timesheet Entry', 'Organize work records and complete timesheets according to policy.'],
      ['工数入力', '作業記録を整理し、ルールに沿って工数を入力します。'], ['작업 시간 입력', '작업 기록을 정리하고 규칙에 따라 시간을 입력합니다.']],
    task: [
      ['需求执行', '理解需求、安排执行并整理交付结果。'], ['Task Execution', 'Understand requirements, organize execution and prepare deliverables.'],
      ['タスク実行', '要件を理解し、実行を整理して成果物を準備します。'], ['작업 실행', '요구사항을 이해하고 실행을 조율하며 산출물을 정리합니다.']],
    wizard: [
      ['工作向导', '引导完成结构化工作流程和必要检查。'], ['Workflow Wizard', 'Guide structured workflows and required checks.'],
      ['作業ウィザード', '体系的な作業フローと必要な確認を案内します。'], ['작업 마법사', '체계적인 작업 흐름과 필요한 점검을 안내합니다.']],
  };
  const packs = Object.fromEntries(['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].map((locale, index) =>
    [locale, Object.fromEntries(Object.entries(rows).flatMap(([id, values]) =>
      [['builtin.skill.' + id + '.name', values[index][0]], ['builtin.skill.' + id + '.description', values[index][1]]]))]));
  if (typeof module !== 'undefined' && module.exports) { module.exports = packs; return; }
  global.SoduWorkLocaleMessages = Object.freeze(Object.assign(Object.create(null), global.SoduWorkLocaleMessages,
    Object.fromEntries(Object.entries(packs).map(([locale, values]) =>
      [locale, Object.freeze(Object.assign(Object.create(null), global.SoduWorkLocaleMessages?.[locale], values))]))));
})(globalThis);
