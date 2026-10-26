# GlossaHub 下一代数据库模型演进与平滑迁移方案 (Database Spec v2.0 精炼版)

> **文档标识**：`GLOSSA-HANDOFF-03-DB`  
> **归档路径**：`/Users/jacko/Projects/glossa-hub/handoff/03_DATABASE_SCHEMA_AND_MIGRATION.md`  
> **版本**：v2.0 (Engineering Architecture Release - Focused Edition)  
> **编写日期**：2026-09-28  
> **战略调整原则**：**移除繁复未使用的审核字段与多层 RBAC 权限表，全力构建高性能细粒度变更审计表（`audit_change_logs`）与不可变时光机快照表（`term_snapshots`），并以兼容视图实现旧业务无损平移。**  

---

## 1. 数据库减负与选型基准

### 1.1 摒弃伪需求与技术泥潭
*   **彻底淘汰 SQLite/Postgres 手写 SQL 双轨维护**：统一基准为 **PostgreSQL 16（预置 pgvector 扩展）+ Drizzle ORM**，本地通过标准 Docker Compose 运行，生产直连 Supabase，消灭方言分裂与代码中充斥的 `if (dbType === 'postgres')`。
*   **精简冗余字段**：移除 `term_translations` 中从未使用的 `status`、`reject_reason`、`reviewer_id` 审核字段，移除多层角色关系表，将数据库结构精炼至极。
*   **重塑核心竞争力**：
    *   构建细粒度变更审计日志表 `audit_change_logs`（精确追踪到单个词条单门语言前后 Diff）；
    *   构建不可变时光机快照表 `term_snapshots`（为每一次修改与回退提供后悔药备份）；
    *   构建高效版本对比查询索引。

---

## 2. 精炼数据模型设计 (Drizzle Schema)

```typescript
// server/src/common/database/schema/schema.ts
import { pgTable, uuid, varchar, text, boolean, integer, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core'; // pgvector 向量检索扩展

// 1. 项目空间表 (Projects) - 支持硬件产品线隔离
export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 64 }).notNull().unique(), // 例如: 'c706-firmware'
  name: varchar('name', { length: 128 }).notNull(),
  description: text('description'),
  targetLanguages: jsonb('target_languages').notNull().default(['en', 'de', 'fr', 'es', 'it', 'ja', 'ko']),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

// 2. 固件版本表 (Versions)
export const versions = pgTable('versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  versionName: varchar('version_name', { length: 128 }).notNull(),
  isSealed: boolean('is_sealed').default(false).notNull(), // 封板只读保护
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
  updatedBy: varchar('updated_by', { length: 64 }).notNull() // 操作人 (姓名/工号)
}, (table) => ({
  idxVersionKw: uniqueIndex('idx_version_kw').on(table.versionId, table.kw),
  idxVersionSort: index('idx_version_sort').on(table.versionId, table.sortOrder)
}));

// 4. 单语种细粒度翻译表 (Term Translations)
export const termTranslations = pgTable('term_translations', {
  id: uuid('id').defaultRandom().primaryKey(),
  termId: uuid('term_id').references(() => terms.id, { onDelete: 'cascade' }).notNull(),
  languageCode: varchar('language_code', { length: 32 }).notNull(), // 'en', 'de', 'fr'
  translationText: text('translation_text').default('').notNull(),
  sourceType: varchar('source_type', { length: 16 }).default('human').notNull(), // 'human' | 'ai' | 'tm'
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: varchar('updated_by', { length: 64 }).notNull()
}, (table) => ({
  idxTermLang: uniqueIndex('idx_term_lang').on(table.termId, table.languageCode)
}));

// 5. 核心不可变快照表 (Term Snapshots) - 支撑时光机撤销与后悔药备份
export const termSnapshots = pgTable('term_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  termId: uuid('term_id').notNull(),
  versionId: uuid('version_id').notNull(),
  snapshotState: jsonb('snapshot_state').notNull(), // 保存该时刻词条及其全部语言翻译的完整状态镜像
  reason: varchar('reason', { length: 64 }).notNull(), // 'USER_EDIT' | 'AI_BATCH' | 'ROLLBACK_BACKUP'
  operator: varchar('operator', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  idxTermSnapshots: index('idx_term_snapshots').on(table.termId, table.createdAt)
}));

// 6. 核心细粒度变更审计表 (Audit Change Logs) - 支撑明确的变更追踪与红绿Diff
export const auditChangeLogs = pgTable('audit_change_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  versionId: uuid('version_id').notNull(),
  termId: uuid('term_id').notNull(),
  kw: varchar('kw', { length: 256 }).notNull(),
  targetLang: varchar('target_lang', { length: 32 }), // 若为空表示修改中文或KW，否则为具体语言
  action: varchar('action', { length: 64 }).notNull(), // 'CREATE' | 'MODIFY' | 'AI_TRANSLATE' | 'ROLLBACK'
  oldValue: text('old_value'), // 变更前旧值
  newValue: text('new_value'), // 变更后新值
  details: text('details'), // 变更上下文摘要
  operator: varchar('operator', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  idxAuditVersion: index('idx_audit_version').on(table.versionId, table.createdAt),
  idxAuditKw: index('idx_audit_kw').on(table.kw)
}));

// 7. 向量化翻译记忆库 (Translation Memories / TM)
export const translationMemories = pgTable('translation_memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceText: text('source_text').notNull(),
  targetLang: varchar('target_lang', { length: 32 }).notNull(),
  targetText: text('target_text').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }), // 向量嵌入用于语义模糊匹配
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});
```

---

## 3. 双视图无缝平移机制 (Zero-Breaking Parity)

为了保障老前端界面、导出程序及存量 Python 自动化测试（`test_full_api.py`）无需任何修改即可正常读取，在 PostgreSQL 中创建无损兼容视图：

```sql
CREATE OR REPLACE VIEW view_terms_legacy AS
SELECT 
    t.id,
    t.version_id,
    t.kw,
    t.zh_cn,
    t.context,
    t.owner_component AS owner,
    t.is_locked,
    t.sort_order,
    t.updated_at,
    t.updated_by,
    -- 自动将 term_translations 汇聚成旧版 {"EN": "...", "DE": "..."} JSON 结构
    COALESCE(
        jsonb_object_agg(tt.language_code, tt.translation_text) FILTER (WHERE tt.language_code IS NOT NULL),
        '{}'::jsonb
    ) AS translations,
    -- 自动将来源标记汇聚成旧版 {"EN": "ai", "DE": "tm"} JSON 结构
    COALESCE(
        jsonb_object_agg(tt.language_code, tt.source_type) FILTER (WHERE tt.language_code IS NOT NULL),
        '{}'::jsonb
    ) AS translations_meta
FROM terms t
LEFT JOIN term_translations tt ON t.id = tt.term_id
GROUP BY t.id;
```

---

## 4. 存量历史数据无损迁移演进脚本

```sql
-- migration_v1_to_v2_clean.sql
BEGIN;

-- 1. 创建全新的细粒度 term_translations 表
CREATE TABLE IF NOT EXISTS term_translations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    term_id UUID NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    language_code VARCHAR(32) NOT NULL,
    translation_text TEXT NOT NULL DEFAULT '',
    source_type VARCHAR(16) NOT NULL DEFAULT 'human',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
    CONSTRAINT uq_term_lang UNIQUE (term_id, language_code)
);

-- 2. 创建精炼细粒度审计日志表
CREATE TABLE IF NOT EXISTS audit_change_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL,
    term_id UUID NOT NULL,
    kw VARCHAR(256) NOT NULL,
    target_lang VARCHAR(32),
    action VARCHAR(64) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    details TEXT,
    operator VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. 数据平移：从旧 terms 表的 translations JSON 拆解为行数据
INSERT INTO term_translations (term_id, language_code, translation_text, source_type, updated_at, updated_by)
SELECT 
    t.id AS term_id,
    kv.key AS language_code,
    COALESCE(kv.value::text, '') AS translation_text,
    COALESCE((t.translations_meta::jsonb ->> kv.key), 'human') AS source_type,
    t.updated_at,
    COALESCE(t.updated_by, 'MIGRATION')
FROM terms t,
LATERAL jsonb_each_text(
    CASE 
        WHEN t.translations IS NULL OR t.translations = '' THEN '{}'::jsonb
        WHEN jsonb_typeof(t.translations::jsonb) = 'object' THEN t.translations::jsonb
        ELSE '{}'::jsonb
    END
) kv
ON CONFLICT (term_id, language_code) DO NOTHING;

-- 4. 迁移对账验证
DO $$
DECLARE
    v1_count INT;
    v2_count INT;
BEGIN
    SELECT count(*) INTO v1_count FROM terms;
    SELECT count(DISTINCT term_id) INTO v2_count FROM term_translations;
    RAISE NOTICE '数据迁移对账完成: V1 原始词条数 = %, V2 成功映射的词条数 = %', v1_count, v2_count;
END $$;

COMMIT;
```
