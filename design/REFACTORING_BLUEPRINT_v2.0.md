# GlossaHub 下一代企业级多语言协同与版本管理平台 架构演进与重构方案 (v2.0 精炼版)

> **文档标识**：`GLOSSA-ARCH-REFACTOR-2026-V2`  
> **文档性质**：核心系统架构规划与重构工程白皮书（业务减负与核心聚焦版）  
> **更新日期**：2026-09-28  
> **战略调整原则**：**取消未使用的审核工作流与繁重 RBAC 权限矩阵，将系统核心能力全面聚焦于“毫秒级变更记录追踪”与“高精准固件版本对比 Diff”**。  

---

## 目录
1. [重构动机与战略聚焦（减负与核心强化）](#1-重构动机与战略聚焦减负与核心强化)
2. [业务无缝平移与零停机策略](#2-业务无缝平移与零停机策略)
3. [核心聚焦一：全维度细粒度变更记录与时光机 (Audit Trail)](#3-核心聚焦一全维度细粒度变更记录与时光机-audit-trail)
4. [核心聚焦二：专业固件版本差分对比与合并引擎 (Diff Engine)](#4-核心聚焦二专业固件版本差分对比与合并引擎-diff-engine)
5. [轻量化后端系统架构 (Fastify + TypeScript)](#5-轻量化后端系统架构-fastify--typescript)
6. [精炼数据库模型演进 (Drizzle ORM + PostgreSQL)](#6-精炼数据库模型演进-drizzle-orm--postgresql)
7. [前端应用与交互体验方案 (双工作台 + 虚拟滚动)](#7-前端应用与交互体验方案-双工作台--虚拟滚动)
8. [智能翻译引擎专项 (脱离 Dify 直连模型 + 向量 TM)](#8-智能翻译引擎专项-脱离-dify-直连模型--向量-tm)
9. [研发工程闭环与实施路线图](#9-研发工程闭环与实施路线图)

---

## 1. 重构动机与战略聚焦（减负与核心强化）

### 1.1 战略减负：去掉伪需求，回归真实业务价值
经过团队多轮迭代验证，系统在过去的设计中存在过度设计：
*   **取消复杂的审核工作流（Review Workflow）**：
    历史设计的 `DRAFT` / `PENDING_REVIEW` / `APPROVED` / `REJECTED` 状态机在实际跨国固件协同中从未真正启用，反而增加了录入和批量导出的状态噪音与操作负担。重构后**彻底移除复杂的审核状态机**，词条仅保留直观的“已翻译/未翻译”、“是否加锁封板”两种基本状态。
*   **取消层层设卡的 RBAC 权限系统**：
    实际业务场景属于**团队内部信任协作**，以往的“系统超管 / 项目拥有者 / 编辑者 / 语言审校人 / 只读人员”五级权限与多层中间件拦截不仅徒增系统复杂度，还经常导致团队成员因“权限不足”无法协同。重构后**取消复杂 RBAC**，采用“全员协作者”模式——登录即可协同编辑，系统将全部精力投入到**“精确记录谁在什么时间改了什么”**，通过透明的审计追溯代替粗暴的权限封锁。

### 1.2 战略强化：固件研发的两大真正生命线
固件多语言管理的本质不是内容审批，而是**版本的严谨迭代与变更的可逆追溯**：
1.  **明确且不可篡改的变更记录（Audit Trail & Snapshots）**：
    精确到“哪个词条的哪种语言、由谁、在何时（CST 东八区）、从什么值改成了什么值”，支持 Git 风格的红绿双列 Diff 查看，并支持一键时光机回退撤销。
2.  **高精度智能版本对比引擎（Version Diff Engine）**：
    两个固件版本之间（例如 `v2.0` vs `v2.1`），毫秒级计算出**新增 (ADD)**、**删除 (DEL)** 与**修改 (MOD)**，自动清洗空格标点等假差异，支持单语种维度筛选比对，并能一键选择性合并同步到目标版本。

---

## 2. 业务无缝平移与零停机策略

保证现有 15+ 款码表项目的上万条历史词条、各版本数据表与审计记录零中断平移：
1.  **数据双视图兼容（Dual-View Parity）**：
    底层将粗粒度 `translations` JSON 字段拆解为规整的 `term_translations` 行数据，同时在 PostgreSQL 中提供 `view_terms_legacy` 兼容视图，保证历史导出脚本和自动化测试（如 `test_full_api.py`）读取零修改。
2.  **API Facade 兼容垫片**：
    保留现有的所有旧路由路径（`/api/tables/:tableId/sync`、`/api/sync-table` 等），垫片层自动将入参解构成新模型，输出组装为旧格式，确保业务平滑过渡。

---

## 3. 核心聚焦一：全维度细粒度变更记录与时光机 (Audit Trail)

```mermaid
graph TD
    A[用户单条编辑 / 批量AI翻译 / 导入更新] --> B[事务开启 DB Transaction]
    B --> C[对比 term_translations 前后字段变更]
    C --> D[生成字段级 Diff: { field, old_val, new_val, lang }]
    D --> E[写入不可变快照表 term_snapshots]
    D --> F[写入审计日志表 audit_change_logs]
    E & F --> G[事务安全提交]
    
    H[用户点击: 查看变更历史] --> I[展示按东八区时间排序的 Git 风格红绿 Diff]
    J[用户点击: 一键回退某次修改] --> K[自动为当前状态生成后悔药备份快照]
    K --> L[精准覆盖还原为该历史节点的数据]
```

### 3.1 变更记录规范
*   **细粒度捕获**：不仅记录“该行被修改”，更精确记录具体改动细节，例如：
    `[2026-09-28 14:20:15] 张三 修改了 [KW_STOP_RIDE] 的 [德语(DE)] 译文：从 "Anhalten" 更改为 "Fahrt beenden"`。
*   **Git 风格双列 Diff 视图**：
    前端展示直观的前后变动比对：删除的原字符以红色高亮背景标出，新增的字符以绿色高亮背景标出。
*   **带“后悔药”机制的一键时光机回滚**：
    词条的历史快照完全可回滚。在执行回退时，系统自动先将“回退前的当前状态”备份为一份崭新快照，确保回退操作本身 100% 可逆。

---

## 4. 核心聚焦二：专业固件版本差分对比与合并引擎 (Diff Engine)

### 4.1 假差异智能清洗 (False Diff Normalization)
对比引擎内置字符归一化管道，彻底过滤无意义的干扰项：
*   忽略首尾多余空格、连续连续空格合并为一个空格；
*   全角与半角标点映射等价（如中文弯引号 `“` `”` 与英文直引号 `"`、Unicode 省略号 `…` 与连续三点 `...`、全角冒号 `：` 与半角 `:`）；
*   忽略不可见的零宽空格与换行符 `\r\n` vs `\n`。

### 4.2 三维差分与多维度透视
1.  **新增 (ADD)**：对比版本独有而在基准版本不存在的词条（绿色标识）；
2.  **删除 (DEL)**：基准版本存在而在对比版本已废除的词条（红色删除线）；
3.  **修改 (MOD)**：
    *   **原文变动**：中文 `zh_cn` 变动，提示固件文案发生产品级调整；
    *   **翻译变动**：中文没变，但某些语言被优化润色。系统支持**按语种快速筛选**（例如：“只看德语发生变动的词条”）。

### 4.3 智能一键同步合并 (Selective Apply Diff)
在版本比对界面，用户可以勾选“选中的 15 条修改与 5 条新增”，一键点击“应用变更到目标表”，系统在独立事务中完成增量合入，自动产生审计快照，大幅削减固件版本升级成本。

---

## 5. 轻量化后端系统架构 (Fastify + TypeScript)

在取消了复杂的 RBAC 拦截与审核状态机后，后端架构极度精炼高效：

```
server/
├── src/
│   ├── app.ts                  # Fastify 极速启动 (<80ms)
│   ├── modules/
│   │   ├── term/               # 词条 CRUD 与并发乐观锁 (updated_at)
│   │   ├── diff/               # 核心版本比对引擎 (ADD/DEL/MOD + 假差异清洗)
│   │   ├── audit/              # 核心变更审计日志与时光机回退服务
│   │   ├── ai-gateway/         # 多模型直连翻译网关 (DeepSeek/Claude/GPT)
│   │   ├── export/             # 带高亮样式的 ExcelJS / CSV 导出管道
│   │   └── project/            # 产品线与固件版本管理
│   ├── common/
│   │   ├── database/           # Drizzle ORM + PostgreSQL 连接池
│   │   └── errors/             # 领域异常体系
│   └── compat/                 # 历史 API 兼容垫片 (保证旧测试/前端零报错)
```

---

## 6. 精炼数据库模型演进 (Drizzle ORM + PostgreSQL)

彻底移除冗余的审核字段（`status`、`reject_reason`、`reviewer_id`）与多层 RBAC 权限表，保留纯粹、高性能的核心数据模型：

```typescript
// server/src/common/database/schema/schema.ts
import { pgTable, uuid, varchar, text, boolean, integer, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';

// 1. 项目空间表 (Projects)
export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 64 }).notNull().unique(), // 例如: 'c706-firmware'
  name: varchar('name', { length: 128 }).notNull(),
  targetLanguages: jsonb('target_languages').notNull().default(['en', 'de', 'fr', 'es', 'it', 'ja', 'ko']),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

// 2. 固件版本表 (Versions)
export const versions = pgTable('versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  versionName: varchar('version_name', { length: 128 }).notNull(),
  isSealed: boolean('is_sealed').default(false).notNull(), // 封板只读锁定
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  idxProjectVersion: uniqueIndex('idx_project_version').on(table.projectId, table.versionName)
}));

// 3. 词条核心主表 (Terms)
export const terms = pgTable('terms', {
  id: uuid('id').defaultRandom().primaryKey(),
  versionId: uuid('version_id').references(() => versions.id, { onDelete: 'cascade' }).notNull(),
  kw: varchar('kw', { length: 256 }).notNull(), // 键名: KW_STOP_RIDE
  zhCn: text('zh_cn').notNull(), // 中文基准原文
  context: text('context').default(''), // 所在页面/模块
  ownerComponent: varchar('owner_component', { length: 128 }).default(''), // 字号/类别
  maxChars: integer('max_chars').default(0), // 硬件屏幕最大字符数约束 (超长预警)
  isLocked: boolean('is_locked').default(false).notNull(), // 行级防改锁
  sortOrder: integer('sort_order').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: varchar('updated_by', { length: 64 }) // 记录操作人姓名/工号
}, (table) => ({
  idxVersionKw: uniqueIndex('idx_version_kw').on(table.versionId, table.kw)
}));

// 4. 单语种翻译明细表 (Term Translations)
export const termTranslations = pgTable('term_translations', {
  id: uuid('id').defaultRandom().primaryKey(),
  termId: uuid('term_id').references(() => terms.id, { onDelete: 'cascade' }).notNull(),
  languageCode: varchar('language_code', { length: 32 }).notNull(), // 'en', 'de', 'fr'
  translationText: text('translation_text').default('').notNull(),
  sourceType: varchar('source_type', { length: 16 }).default('human').notNull(), // 'human' | 'ai' | 'tm'
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: varchar('updated_by', { length: 64 })
}, (table) => ({
  idxTermLang: uniqueIndex('idx_term_lang').on(table.termId, table.languageCode)
}));

// 5. 核心不可变快照表 (Term Snapshots) - 支撑时光机与回退
export const termSnapshots = pgTable('term_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  termId: uuid('term_id').notNull(),
  versionId: uuid('version_id').notNull(),
  snapshotState: jsonb('snapshot_state').notNull(), // 完整的全字段镜像
  reason: varchar('reason', { length: 64 }).notNull(), // 'EDIT' | 'AI_BATCH' | 'ROLLBACK_BACKUP'
  operator: varchar('operator', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  idxTermSnapshots: index('idx_term_snapshots').on(table.termId, table.createdAt)
}));

// 6. 核心细粒度变更审计表 (Audit Change Logs)
export const auditChangeLogs = pgTable('audit_change_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  versionId: uuid('version_id').notNull(),
  kw: varchar('kw', { length: 256 }).notNull(),
  targetLang: varchar('target_lang', { length: 32 }), // 若为空则为KW或中文修改
  action: varchar('action', { length: 64 }).notNull(), // 'CREATE' | 'MODIFY' | 'AI_TRANSLATE' | 'ROLLBACK'
  oldValue: text('old_value'),
  newValue: text('new_value'),
  details: text('details'),
  operator: varchar('operator', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  idxAuditVersion: index('idx_audit_version').on(table.versionId, table.createdAt)
}));

// 7. 向量化翻译记忆库 (Translation Memories / TM)
export const translationMemories = pgTable('translation_memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceText: text('source_text').notNull(),
  targetLang: varchar('target_lang', { length: 32 }).notNull(),
  targetText: text('target_text').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});
```

---

## 7. 前端应用与交互体验方案 (双工作台 + 虚拟滚动)

*   **保持并升华设计美学**：
    精致暗黑/明亮双主题、8px 磨砂高斯模糊模态框、JetBrains Mono 键名等宽字体排版。
*   **砍掉审核杂质，界面极度清爽**：
    移除了每行多余的审核状态徽标与驳回操作弹窗，表格列头纯净高效。
*   **性能提升**：
    基于 **TanStack Virtual 虚拟滚动 + Zustand 原子状态**，即使载入上万行词条，DOM 节点始终稳定在 25 行，单单元格打字整表零重绘、60FPS 极速跟手。
*   **版本对比专属视图 (Diff Studio)**：
    提供全屏沉浸式的版本比对界面，双列高亮展示变更，支持一键勾选合并到目标版本，并支持一键导出带高亮色块（新增绿、修改黄）的原生 Excel。

---

## 8. 智能翻译引擎专项 (脱离 Dify 直连模型 + 向量 TM)

*   **脱离 Dify**：采用自建轻量多模型网关，直连 **DeepSeek-V3**（主力性价比之王）+ **Claude 3.5 Sonnet**（高精度备用）+ **本地私有 Qwen2.5**。
*   **极速响应**：
    *   第一层：PostgreSQL `pgvector` 向量记忆库，100% 精确匹配本地 **<20ms** 秒回，0 外部 API 成本；
    *   第二层：微批聚合（Micro-Batching），批量 50 条聚合为 1 次请求，请求往返减少 95%。
*   **准确性与硬件尺寸**：
    Prompt 注入硬件字符上限（`max_chars`），输出前强制进行代码级**变量占位符（`%s`, `%d`, `{0}`）完整性校验**，异常自动触发自反思自纠错。

---

## 9. 研发工程闭环与实施路线图

1.  **研发 GitOps 闭环**：提供 `glossa-cli` 命令行工具，固件代码提交时自动扫描提取新词，版本封板时一键自动编译生成嵌入式 C 语言多语言头文件（`strings_lang.h` / `.c`）。
2.  **四阶段实施里程碑（共 6 周）**：
    *   **Phase 1（Week 1）**：Postgres 环境标准化 + 75 项自动化回归测试锁定契约；
    *   **Phase 2（Week 2-3）**：Fastify + TypeScript 搭建，拆解 1822 行巨石代码，上线 API 兼容垫片；
    *   **Phase 3（Week 4）**：数据库迁移（拆解 JSON 字段至细粒度表），上线核心审计变更流水与不可变时光机；
    *   **Phase 4（Week 5-6）**：上线全新版本对比 Diff 引擎、直连多模型翻译网关与前端虚拟大表，灰度全量平移切流。
