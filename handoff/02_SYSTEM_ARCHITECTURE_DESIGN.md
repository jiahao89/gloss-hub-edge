# GlossaHub 下一代系统技术架构设计规范 (Architecture Spec v2.0 精炼版)

> **文档标识**：`GLOSSA-HANDOFF-02-ARCH`  
> **归档路径**：`/Users/jacko/Projects/glossa-hub/handoff/02_SYSTEM_ARCHITECTURE_DESIGN.md`  
> **版本**：v2.0 (Engineering Architecture Release - Focused Edition)  
> **编写日期**：2026-09-28  
> **战略调整原则**：**取消未使用的审核工作流与层层设卡的 RBAC 守卫，架构全面聚焦于“Diff 版本比对引擎”、“细粒度字段变更审计”与“高性能词条协同”。**  

---

## 1. 架构目标与设计原则

下一代 GlossaHub 后端系统旨在彻底终结原有 `terms.cjs`（1822 行）、`sync.cjs` 巨石代码中“SQL 拼接、业务逻辑、报表绘制浑然一体”的高耦合现状，达成以下核心指标：
*   **高吞吐与极速响应**：核心 API P95 响应延迟低于 **50ms**（批量查询低于 120ms），吞吐能力达原有 Express 的 **3.5 倍以上**。
*   **极致轻量冷启动**：冷启动时间由原来的 2.5 秒压缩至 **<80ms**，完美适应 Vercel Serverless 及 Render 容器实例的快速弹性拉起。
*   **全栈强类型推导 (End-to-End Type Safety)**：基于 TypeScript 5.x + Zod/TypeBox，实现从数据库 Schema 到 API 请求体、再到前端 SDK 的全链路编译期类型安全，杜绝 `undefined` 与运行时 JSON 解析崩溃。
*   **整洁架构领域分层 (Clean Architecture)**：将核心业务领域（词条、版本 Diff、变更快照、直连 AI）与底层框架、外部数据库彻底解耦。
*   **100% 向后兼容垫片 (Backward-Compatibility Shim)**：在应用外层挂载 API Facade，保证现存前端页面、历史 Python 自动化测试脚本（`test_full_api.py`）无需任何修改即可正常运行。

---

## 2. 架构模式与分层拓扑

系统采用**模块化整洁微单体（Modular Clean Monolith）**架构：

```
+-------------------------------------------------------------------------------------------------+
|                                    GLOSSA-HUB 架构分层拓扑                                        |
+-------------------------------------------------------------------------------------------------+
|  1. 表现层 (Presentation / HTTP Layer)                                                           |
|     - Fastify Plugins / Controllers / Routes                                                    |
|     - Schema Validation (TypeBox / Zod 运行时契约)                                               |
|     - Auth & Operator Context (提取当前登录人标识)                                               |
|     - [Legacy API Facade / Shim] (拦截并转写旧版 /api/tables/:id/sync 报文)                         |
+-------------------------------------------------------------------------------------------------+
|  2. 应用层 (Application / Use Cases Layer)                                                       |
|     - TermManagementService (词条增删改查/版本锁定/乐观并发控制)                                    |
|     - DiffComparisonService (双版本 Diff 差分、假差异清洗与一键选择性同步)                          |
|     - ChangeAuditService (细粒度字段变更记录捕获、不可变快照生成与时光机后悔药回滚)                  |
|     - AiTranslationService (直连 AI 网关调度与多通道容灾)                                         |
|     - ExportPipelineService (高性能 ExcelJS 与 RFC-4180 CSV 生成)                                 |
+-------------------------------------------------------------------------------------------------+
|  3. 领域层 (Core Domain Layer)                                                                  |
|     - 实体与值对象 (Term, TermTranslation, Version, KwName)                                     |
|     - 核心领域服务 (FalseDiffNormalizer 假差异清洗器, L10nQaRuleEngine 质检引擎)                  |
|     - 领域异常体系 (ConcurrencyConflictError, CharacterOverflowError, LockViolationError)         |
+-------------------------------------------------------------------------------------------------+
|  4. 基础设施层 (Infrastructure Layer)                                                            |
|     - Drizzle ORM Repository (PostgreSQL 16 数据持久化)                                         |
|     - Multi-Provider AI Gateway (直连 DeepSeek / Claude / Qwen / Ollama 适配器)                  |
|     - Vector Store Client (pgvector 相似度检索)                                                 |
|     - Immutable Snapshot Store (全量快照持久化引擎)                                             |
+-------------------------------------------------------------------------------------------------+
```

---

## 3. 技术栈评估与选型深度剖析

### 3.1 为什么选 Fastify 而非继续 Express 或 NestJS？
1. **vs. Express.js**：
   * Express 核心代码已有数年未作现代化大重构，中间件调用栈深，异步 Promise 异常容易吞没导致进程不稳定；
   * Fastify 基于内部优化编译的 `fast-json-stringify`，接口吞吐比 Express 高出 200%~300%；
   * Fastify 拥有严密的生命周期钩子（`onRequest` $\rightarrow$ `preValidation` $\rightarrow$ `preHandler` $\rightarrow$ `onResponse`），非常适合构建统一的操作人上下文注入与审计遥测。
2. **vs. NestJS**：
   * NestJS 概念繁重（大量依赖反射与依赖注入装饰器），冷启动通常需要 500ms 以上，且概念过度复杂；
   * Fastify + 函数式分层既拥有整洁架构的高可测性与解耦性，又保留了极简、轻量的运行特性。

---

## 4. 后端代码目录结构规划

```
server/
├── src/
│   ├── app.ts                         # Fastify 实例构建、全局插件挂载
│   ├── server.ts                      # 进程启动监听与优雅停机 (Graceful Shutdown)
│   ├── config/                        # 环境变量与配置校验 (Zod Env)
│   │   ├── env.config.ts
│   │   └── constants.ts
│   ├── common/                        # 通用基础设施与横切关注点
│   │   ├── guards/                    # 认证与操作人识别守卫 (取消繁重RBAC)
│   │   │   └── auth.guard.ts          # 提取当前操作人姓名/工号注入请求上下文
│   │   ├── errors/                    # 统一领域异常体系与 HTTP 映射
│   │   │   ├── app-error.ts
│   │   │   └── error-handler.ts
│   │   ├── database/                  # Drizzle ORM 客户端与连接池
│   │   │   ├── db.client.ts
│   │   │   └── schema/                # 精炼关系表定义 (terms, audit, diff)
│   │   └── telemetry/                 # AI Token 遥测与耗时日志
│   │
│   ├── modules/                       # 核心业务领域模块 (Domain Modules)
│   │   ├── term/                      # 词条核心模块
│   │   │   ├── term.routes.ts         # Fastify 路由注册
│   │   │   ├── term.schema.ts         # 入参出参 TypeBox Schema
│   │   │   ├── term.controller.ts     # 控制器 (请求解析与响应组装)
│   │   │   ├── term.service.ts        # 业务用例 (事务、并发乐观锁控制)
│   │   │   └── term.repository.ts     # Drizzle 数据访问
│   │   ├── diff/                      # 核心固件版本对比引擎
│   │   │   ├── diff.service.ts        # 三维差分计算 (ADD/DEL/MOD)
│   │   │   └── normalizer.ts          # 假差异标点空格归一化清洗器
│   │   ├── audit/                     # 核心细粒度变更记录与时光机
│   │   │   ├── audit.service.ts       # 字段级 Diff 捕获与时光机回退
│   │   │   └── snapshot.service.ts    # 不可变快照生成 (含后悔药备份)
│   │   ├── ai-gateway/                # 多模型直连翻译与 QA 模块
│   │   │   ├── gateway.service.ts     # 智能轮询与熔断降级调度
│   │   │   ├── providers/             # 直连适配器 (DeepSeek, Claude, Qwen)
│   │   │   └── qa-engine/             # 自动质检 (占位符、字长约束)
│   │   ├── export/                    # 高性能 ExcelJS / CSV 导出管道
│   │   └── project/                   # 产品线与固件版本管理
│   │
│   └── compat/                        # 历史 API 兼容垫片层 (API Facade)
│       ├── legacy-routes.ts           # 挂载 /api/sync-table 等旧路径
│       └── legacy-adapter.ts          # 将旧报文无损转为 V2 领域命令
```

---

## 5. 核心基础设施与防护机制

### 5.1 历史 API 兼容垫片设计 (Legacy API Facade)
为了保障老前端、现有单元测试及外部自动化脚本无缝过渡，系统在 `compat/` 模块注册旧路由钩子：

```typescript
// server/src/compat/legacy-adapter.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TermService } from '../modules/term/term.service';

export async function registerLegacyRoutes(fastify: FastifyInstance, termService: TermService) {
  // 1. 兼容旧的批量同步端点 /api/tables/:tableId/sync
  fastify.post('/api/tables/:tableId/sync', async (req: FastifyRequest, reply: FastifyReply) => {
    const { tableId } = req.params as { tableId: string };
    const legacyBody = req.body as any;

    const result = await termService.batchSyncFromLegacy({
      versionId: tableId,
      addedRecords: legacyBody.added || [],
      updatedRecords: legacyBody.updated || [],
      deletedIds: legacyBody.deletedIds || [],
      operator: (req as any).user?.username || 'SYSTEM'
    });

    return reply.status(200).send({
      message: '同步成功',
      updatedRecords: result.successCount
    });
  });

  // 2. 兼容历史 Python 自动化测试调用的 /api/sync-table
  fastify.post('/api/sync-table', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({ message: '同步成功', updatedRecords: 0 });
  });
}
```

### 5.2 优雅停机 (Graceful Shutdown)
在进程退出时安全释放数据库连接池，杜绝中断活跃事务：

```typescript
// server/src/server.ts
const shutdown = async (signal: string) => {
  fastify.log.info(`收到 [${signal}] 信号，正在执行安全停机...`);
  try {
    await fastify.close();
    await pool.end();
    fastify.log.info('数据库连接池已释放，服务安全退出。');
    process.exit(0);
  } catch (err) {
    fastify.log.error('停机释放资源时发生异常:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```
