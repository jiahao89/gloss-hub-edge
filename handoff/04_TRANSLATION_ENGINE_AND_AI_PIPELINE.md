# GlossaHub 智能翻译引擎与多模态 QA 架构方案 (Translation Engine Spec v2.0)

> **文档标识**：`GLOSSA-HANDOFF-04-TRANSLATE`  
> **归档路径**：`/Users/jacko/Projects/glossa-hub/handoff/04_TRANSLATION_ENGINE_AND_AI_PIPELINE.md`  
> **版本**：v2.0 (Engineering Architecture Release)  
> **编写日期**：2026-09-28  

---

## 1. 核心诉求与现有瓶颈剖析

在 GlossaHub 的实际运行中，翻译能力是整个系统的“心脏”。用户提出了两个极具针对性的诉求：
1. **翻译速度、准确性要大幅提高**（原模式单条耗时 5~10 秒，偶发漏掉占位符、字数超长截断）；
2. **如果不使用 Dify，如何彻底解决翻译时的 API 调用与稳定性问题？**

### 1.1 为什么必须脱离对 Dify 的重度依赖？
在 v1.0 ~ v1.2 中，系统将 Dify 工作流作为唯一的翻译通道。虽然起步快，但在工业级生产场景暴露了以下硬伤：
*   **协议栈开销大、延迟居高不下**：Dify 本质是多 Agent 编排调度平台，每次调用经过 Nginx $\rightarrow$ Python API $\rightarrow$ 工作流节点调度 $\rightarrow$ 内部流式转换 $\rightarrow$ 外部大模型。单次调用的纯中转延迟就高达 1~2 秒，叠加模型生成导致总耗时常达 6~10 秒；
*   **高并发易雪崩**：当批量翻译上百条词条（每条涉及 16 种语言）时，Dify 内部任务队列容易阻塞，频繁抛出 `HTTP 500 / 504 Gateway Timeout`；
*   **私有化运维沉重**：Dify 私有部署依赖 10+ 个 Docker 容器（Redis, Postgres, Weaviate, Celery 等），升级维护成本极高；
*   **错误码粗糙**：大模型超限或网络波动时，Dify 仅返回笼统的 500 错误，前端无法给译员提供精准的自愈引导。

---

## 2. 脱离 Dify：自建轻量级多供应商直连网关 (Multi-Provider Direct Gateway)

系统在后端实现完全自主可控的 **Multi-Provider AI Gateway**，直连各大主流顶尖模型 API，兼顾速度、成本与高可用容灾。

```mermaid
graph TD
    A[前端翻译请求] --> B[AiTranslationGateway 智能中枢]
    B --> C{第一层: 向量化 TM 记忆库}
    C -->|100% 精确匹配| D[本地命中 <20ms 返回<br/>标记: tm, 0成本]
    
    C -->|未命中 / 模糊命中| E[构建约束 Prompt 与 Few-Shot 上下文]
    E --> F[智能路由与熔断降级调度器]

    subgraph 直连供应商模型池 (Direct Provider Pool)
        G1[通道 1: DeepSeek-V3 / R1<br/>中文最强/极度便宜/国内超低延迟]
        G2[通道 2: Anthropic Claude 3.5 Sonnet<br/>多语言逻辑标杆/格式严格]
        G3[通道 3: OpenAI GPT-4o-mini<br/>极速响应 <400ms/高吞吐]
        G4[通道 4: 本地私有化 Qwen2.5-72B (Ollama/vLLM)<br/>离线保密/内网直连]
    end

    F -->|优先尝试| G1
    G1 -.->|超时 >3s 或 429| F
    F -->|毫秒级自动切换| G2
    G2 -.->|备用切换| G3

    G1 & G2 & G3 & G4 --> H[结构化输出解析器 (Structured JSON)]
    H --> I[自动化 L10n QA 质检拦截网]
    I -->|占位符校验/长度校验通过| J[落库并返回前端]
    I -->|严重违规| K[触发 Self-Correction 二次微调]
```

### 2.1 推荐直连模型矩阵与分工

| 供应商与模型 | 核心优势 | 适用场景 | 建议优先级 |
| :--- | :--- | :--- | :--- |
| **DeepSeek-V3 / R1 (直连 API)** | **极高性价比**（仅 GPT-4o 的 1/30）；中文理解深刻；国内直连网络延迟极低（<300ms）。 | 绝大多数固件日常批量预翻译、KW 键名生成。 | **⭐⭐⭐⭐⭐ 主通道 (Default)** |
| **Anthropic Claude 3.5 Sonnet** | 业界公认**翻译质量与格式遵循第一**；对极其冷门的欧洲小语种（荷兰语、波兰语、芬兰语）语法细节把握无瑕疵。 | 复杂句式、长篇帮助文案、高优先级旗舰款产品封板校对。 | **⭐⭐⭐⭐ 高精度通道 (High Precision)** |
| **OpenAI GPT-4o-mini** | 速度极致（首字延迟 <200ms）；并发限制极高（可轻松支持 500+ QPS）。 | 高频单条词条即时输入打字联想、海量短语批量补翻。 | **⭐⭐⭐⭐ 备用通道 (Fallback)** |
| **本地私有部署 Qwen2.5-72B / Llama-3.3 (Ollama/vLLM)** | 完全运行在企业内网，无需公网，数据绝对保密；零 API 费用。 | 军工级保密硬件、外网断网开发环境。 | **⭐⭐⭐ 私有化通道 (On-Premise)** |

### 2.2 核心代码实现：无依赖原生多通道适配器

```typescript
// server/src/modules/ai-gateway/providers/provider.interface.ts
export interface TranslationRequest {
  sourceText: string;
  sourceLang: string;
  targetLangs: string[];
  context?: string;
  maxChars?: number;
  glossaryRules?: Record<string, string>; // 术语映射
}

export interface TranslationResult {
  translations: Record<string, string>; // { "en": "...", "de": "..." }
  tokensUsed: number;
  elapsedMs: number;
  provider: string;
  model: string;
}

export interface ITranslationProvider {
  name: string;
  translate(req: TranslationRequest): Promise<TranslationResult>;
}
```

```typescript
// server/src/modules/ai-gateway/providers/deepseek.provider.ts
import { ITranslationProvider, TranslationRequest, TranslationResult } from './provider.interface';

export class DeepSeekProvider implements ITranslationProvider {
  name = 'deepseek';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.deepseek.com/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async translate(req: TranslationRequest): Promise<TranslationResult> {
    const startTime = Date.now();
    const systemPrompt = `You are a professional localization engine for smart cycling GPS computers and sports hardware.
Translate the input text into the target languages strictly adhering to:
1. Preserve all placeholders like %s, %d, {0}, etc. exactly.
2. Max character limit: ${req.maxChars ? `${req.maxChars} chars` : 'compact'}.
3. Glossary constraints: ${JSON.stringify(req.glossaryRules || {})}.
4. Return ONLY valid JSON format: {"lang_code": "translated_text"}.`;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' }, // 强制结构化 JSON
        temperature: 0.1, // 低温度确保严谨一致
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Source [${req.sourceLang}]: "${req.sourceText}"\nTarget Languages: ${req.targetLangs.join(', ')}` }
        ]
      }),
      signal: AbortSignal.timeout(5000) // 5 秒超时保护
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const parsedTranslations = JSON.parse(data.choices[0].message.content);

    return {
      translations: parsedTranslations,
      tokensUsed: data.usage?.total_tokens || 0,
      elapsedMs: Date.now() - startTime,
      provider: this.name,
      model: 'deepseek-chat'
    };
  }
}
```

---

## 3. 翻译速度如何质变提升？（从 10s 降低到 <500ms）

为实现极致的翻译性能，重构方案设计了**“三级加速推进引擎”**：

```
+----------------------------------------------------------------------------------------------------+
|                                    GLOSSA-HUB 三级加速流水线                                         |
+----------------------------------------------------------------------------------------------------+
|  [ 第一级: 向量化 TM 本地毫秒直通 (Local TM Cache) ]                                                 |
|  • 利用 PostgreSQL 16 预置的 pgvector 向量索引，毫秒级比对历史数万条标准词库。                         |
|  • 命中 100% 精确匹配: 直接提取库内标准译文，响应延迟 < 20ms，API 调用开销 = 0。                      |
|  ------------------------------------------------------------------------------------------------- |
|  [ 第二级: 微批聚合机制 (Micro-Batching Aggregation) ]                                              |
|  • 严禁单条单请求发送！当用户在界面勾选 50 条词条批量翻译时，网关自动聚合成 1 个 Batch 请求发送给模型。 |
|  • 将 50 次外部 HTTP 往返骤降为 1 次，整体耗时从 3 分钟降低至 4 秒完成全量吞吐。                    |
|  ------------------------------------------------------------------------------------------------- |
|  [ 第三级: 并发流式调度工作池 (Worker Pool & P-Limit) ]                                              |
|  • 基于轻量级 Node.js 异步通道，配置滑动窗口并发控制器 (p-limit = 8)。                                |
|  • 充分跑满上游 API 并发能力，同时绝对不触发 HTTP 429 速率限制告警。                                 |
+----------------------------------------------------------------------------------------------------+
```

---

## 4. 翻译准确性与硬件适配度如何提升？

### 4.1 硬件物理屏幕长度防御 (Length Constraint Enforcement)
在骑行码表单行宽度有限的场景下，英德法等语言经常过长。
1. **Prompt 硬约束注入**：若元数据中设定 `max_chars: 12`，系统在调用大模型时显式注入：
   > *"Target text MUST NOT exceed 12 characters. Use standard cycling abbreviations if necessary (e.g., 'Avg Speed' -> 'Avg Spd', 'Kalibrierung' -> 'Kalibr.')."*
2. **后置校验自纠错 (Self-Correction Loop)**：
   若模型返回结果依然超长，网关不将其直接交付，而是自动发起一次轻量二次微调（重试时加入惩罚项），确保入库字符 100% 合规。

### 4.2 自动化 L10n QA 质检拦截网 (Automated QA Rules Engine)
在译文进入数据库前，必须经过纯代码级静态规则扫描：

```typescript
// server/src/modules/ai-gateway/qa-engine/l10n-qa.service.ts
export interface QaIssue {
  type: 'PLACEHOLDER_MISMATCH' | 'LENGTH_OVERFLOW' | 'EMPTY_TRANSLATION';
  message: string;
  severity: 'ERROR' | 'WARNING';
}

export class L10nQaEngine {
  static validate(source: string, target: string, maxChars?: number): QaIssue[] {
    const issues: QaIssue[] = [];

    // 1. 占位符一致性检查 (例如 %s, %d, %1$s, {name})
    const placeholderRegex = /%[0-9]*\$?[a-zA-Z]|{[a-zA-Z0-9_-]+}/g;
    const sourcePlaceholders = (source.match(placeholderRegex) || []).sort();
    const targetPlaceholders = (target.match(placeholderRegex) || []).sort();

    if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(targetPlaceholders)) {
      issues.push({
        type: 'PLACEHOLDER_MISMATCH',
        message: `占位符不匹配！原文占位符为 [${sourcePlaceholders.join(', ')}]，译文占位符为 [${targetPlaceholders.join(', ')}]`,
        severity: 'ERROR'
      });
    }

    // 2. 硬件最大字符上限检查
    if (maxChars && maxChars > 0 && target.length > maxChars) {
      issues.push({
        type: 'LENGTH_OVERFLOW',
        message: `译文字符数 (${target.length}) 超出屏幕允许的最大上限 (${maxChars})！`,
        severity: 'WARNING'
      });
    }

    return issues;
  }
}
```

通过这一套**直连多模型网关 + 三级加速流水线 + 自动化 QA 拦截网**，彻底摆脱了外部平台约束，让 GlossaHub 跃升为具备毫秒级响应、高度专业性与硬件适配能力的现代化翻译中枢。
