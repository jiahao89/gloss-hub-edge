# GlossaHub 下一代企业级翻译与多语言协同平台 重构工程白皮书与文档总览 (v2.0 精炼聚焦版)

> **文档标识**：`GLOSSA-HANDOFF-00-INDEX`  
> **文档版本**：v2.0 (Engineering Architecture Release - Focused Edition)  
> **归档路径**：`/Users/jacko/Projects/glossa-hub/handoff/00_INDEX_AND_OVERVIEW.md`  
> **编写日期**：2026-09-28  
> **核心原则**：**取消未曾使用的审核工作流与繁重 RBAC 权限体系，系统全力聚焦于两大核心生命线——“明确细致的变更记录与时光机”以及“高精准固件版本对比 Diff 引擎”。**  

---

## 1. 重构愿景与战略聚焦（减负增效）

GlossaHub 是迈金科技（Magene）用于管理全球化智能 GPS 骑行码表、室内骑行台、心率带、功率计及移动端 App 的**核心多语言资产与固件词条协同平台**。

在经历多轮业务验证后，团队对核心诉求进行了重大精简与聚焦：
1. **彻底取消审核流（No Review Bottleneck）**：
   在实际固件协同研发中，多级审核状态机（Draft $\rightarrow$ Pending Review $\rightarrow$ Approved $\rightarrow$ Rejected）从未真正发挥作用，反而带来了状态维护的繁琐与噪音。新架构彻底摒弃审核流，词条仅保留直观的“已翻译/未翻译”、“是否封板加锁”状态。
2. **取消层层设卡的 RBAC 权限（Trust-Based Collaboration）**：
   团队内部属于互信协同场景，五级 RBAC 拦截徒增认知门槛。新系统转为“全员协作者”模式，登录即可协同编辑。
3. **全面聚焦两大核心价值**：
   * **明确的变更记录（Audit Trail & Snapshots）**：精准记录谁在何时（东八区）修改了哪个词条的哪种语言，前后 Diff 红绿双列直观展现，提供带“后悔药”机制的一键时光机回退；
   * **专业精准的版本对比（Version Diff Engine）**：快速对比两个固件版本间的新增、删除与修改，智能清洗标点空格等假差异，支持单语种过滤比对与一键增量合并。

---

## 2. 核心战略关切响应矩阵

| 核心战略方向 | 过去痛点 | 下一代破局方案 | 对应专项文档 |
| :--- | :--- | :--- | :--- |
| **功能更合理 (减负)** | 审核状态机冗余累赘；RBAC 权限过度设计；缺乏屏幕物理字长意识。 | **取消审核流与 RBAC**；建立透明的变更审计追溯；支持真多产品线隔离；建立硬件屏幕物理字符上限（Max Chars）防御。 | [01_PRODUCT_REQUIREMENTS_SPEC.md](./01_PRODUCT_REQUIREMENTS_SPEC.md) |
| **明确的变更记录** | 变更详情粗糙，历史快照不可见，回退缺少安全感。 | 字段级变更捕获（精确到单个词条单门语言前后变化）；Git 风格双列红绿 Diff；带后悔药机制的不可变时光机。 | [01_PRD](./01_PRODUCT_REQUIREMENTS_SPEC.md) / [03_DB](./03_DATABASE_SCHEMA_AND_MIGRATION.md) |
| **专业的版本对比** | 缺乏跨版本深层次比对，被全半角标点空格假差异干扰，无法按语言细看。 | 智能假差异归一化清洗；新增/删除/修改三维标记；单语种变动快速筛选；一键选择性合并同步到目标表。 | [01_PRD](./01_PRODUCT_REQUIREMENTS_SPEC.md) / [02_ARCH](./02_SYSTEM_ARCHITECTURE_DESIGN.md) |
| **翻译速度与准确性** | 单次翻译需 5~10 秒；批量易超时；偶发漏掉 `%s` 占位符或字数超长。 | 向量化 TM 记忆库毫秒级直通（精确匹配 0 成本 <20ms）；微批聚合单次往返；自动化 L10n QA 质检（占位符、标点硬性拦截）。 | [04_TRANSLATION_ENGINE_AND_AI_PIPELINE.md](./04_TRANSLATION_ENGINE_AND_AI_PIPELINE.md) |
| **翻译 API 问题 (脱离 Dify)** | Dify 协议层冗余开销大、网络波动大、缺乏精细重试、私有化部署繁重。 | 自建**多供应商直连网关**：直连 DeepSeek-V3（主力性价比）/ Claude 3.5 / 本地 Qwen2.5；智能毫秒级熔断轮询与结构化 JSON 输出。 | [04_TRANSLATION_ENGINE_AND_AI_PIPELINE.md](./04_TRANSLATION_ENGINE_AND_AI_PIPELINE.md) |
| **设计水准保持与升华** | 大表格高频打字卡顿、重渲染严重。 | 延续深邃 Dark Mode 与高斯模糊玻璃质感；引入 TanStack Virtual 虚拟网格（万级词条 60FPS 极速跟手）；专业沉浸式译员工作台。 | [05_UI_UX_DESIGN_SYSTEM_AND_CAT_STUDIO.md](./05_UI_UX_DESIGN_SYSTEM_AND_CAT_STUDIO.md) |

---

## 3. 技术选型总表 (精炼轻量版)

| 层次 | 现存技术栈 (Legacy v1.2) | 下一代重构技术栈 (Modern v2.0) | 选型核心考量 |
| :--- | :--- | :--- | :--- |
| **后端框架** | Express.js 4.x (CommonJS) | **Fastify + TypeScript** | 吞吐提升 3~4 倍，冷启动 <80ms，内置编译期类型安全与极速 JSON 序列化。 |
| **系统架构** | Monolithic Routes (1822行单体) | **Clean Architecture (分层整洁架构)** | 剥离审核与复杂权限后，架构极其轻量，聚焦 Term / Diff / Audit / AI 四大核心模块。 |
| **持久层 / ORM**| SQLite + Postgres 手写字符串 SQL | **Drizzle ORM + 统一 PostgreSQL 16** | 彻底消灭双数据库手写 SQL 泥潭，统一使用 Docker (本地) + Supabase (线上)，原生支持 pgvector。 |
| **数据建模** | `translations` 单列 JSON 粗粒度反模式 | **`terms` + `term_translations` 细粒度行** | 消除并发锁冲突，便于按语种比对与按语种审计，通过兼容视图 `view_terms_legacy` 无损平移旧业务。 |
| **前端状态** | `useState` + `localStorage` + `useRef` | **TanStack Query + Zustand** | 专业级服务端数据缓存与自动失效，原子化局部响应，打字整表零重绘。 |
| **表格渲染** | 原生 `<table>` 简单分页 | **高性能虚拟滚动 (TanStack Virtual)** | 支持万级数据量平滑滚动，固定列与横向 16+ 语言流畅滑动。 |
| **AI 翻译中枢** | Dify 单一工作流 HTTP 转发代理 | **自研直连网关 (DeepSeek/Claude) + 向量 TM** | 摆脱 Dify 依赖，网络延迟骤降 80%，三级加速流水线 + 占位符质检自纠错。 |
| **工程交付** | 网页手工下载 CSV / 研发写脚本 | **`glossa-cli` 命令行 + GitOps 流水线** | 源码自动提取新词，封板一键编译生成固件嵌入式 C 语言头文件（`strings_lang.h`/`.c`）。 |

---

## 4. 重构文档套件索引

```
/Users/jacko/Projects/glossa-hub/handoff/
├── 00_INDEX_AND_OVERVIEW.md                 # [当前文档] 总览、战略减负、核心聚焦与技术总表
├── 01_PRODUCT_REQUIREMENTS_SPEC.md          # 需求规格：明确的变更记录、版本Diff引擎与功能优化
├── 02_SYSTEM_ARCHITECTURE_DESIGN.md         # 后端架构：Fastify轻量微单体、Diff/Audit领域服务与兼容垫片
├── 03_DATABASE_SCHEMA_AND_MIGRATION.md      # 数据库规范：精炼Schema设计、审计快照结构与平滑迁移
├── 04_TRANSLATION_ENGINE_AND_AI_PIPELINE.md # 翻译专项：脱离Dify、多模型直连、极速与准确性方案
├── 05_UI_UX_DESIGN_SYSTEM_AND_CAT_STUDIO.md # 前端设计：Design Tokens、Diff对比视图与沉浸式工作台
└── 06_MIGRATION_EXECUTION_AND_GITOPS.md     # 业务平移路线、研发CLI自动化与回滚预案
```
