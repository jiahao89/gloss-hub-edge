const express = require('express');
const router = express.Router();
const { db, getDbType } = require('../config/db.cjs');
const { authenticateToken, requireProjectMember, requireRole } = require('../middleware/auth.cjs');
const { aiTranslateLimiter } = require('../middleware/rateLimiters.cjs');
const { getEffectiveDifyConfig, generateKwHelper, getBuiltinKeys } = require('../services/difyService.cjs');
const { parseJsonField } = require('../utils/jsonFields.cjs');
const { getCachedGlossaryTerms } = require('../services/glossaryCache.cjs');

// Preferred Dify engine memory (avoid retrying broken endpoints for 45s on every term)
let preferredEngineUrl = null;
const engineFailureTimestamps = new Map();

function isPrivateOrLocalUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local')) {
      return true;
    }
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const b0 = parseInt(ipMatch[1], 10);
      const b1 = parseInt(ipMatch[2], 10);
      if (b0 === 10) return true; // 10.0.0.0/8
      if (b0 === 127) return true; // 127.0.0.0/8
      if (b0 === 172 && (b1 >= 16 && b1 <= 31)) return true; // 172.16.0.0/12
      if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
      if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 Link-local / Cloud metadata
      if (b0 === 0) return true; // 0.0.0.0
    }
    return false;
  } catch {
    return false;
  }
}

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 GlossaHub/1.1';

// 内置 Dify 引擎 (由运维预配置, 前端无需手动输入 Key)
// Key 由环境变量 DIFY_BUILTIN_KEYS (逗号分隔) 注入, 顺序:
//   [0] night.magene.cn → 迈金 Night 专用引擎
//   [1] api.dify.ai     → Dify 官方云服务

// 从环境变量构建内置引擎 { host: apiKey } 映射
function getBuiltinDifyApps() {
  const keys = getBuiltinKeys();
  const apps = {
    'night.magene.cn': 'app-zV0Lo78Bi5WjhplWDL7OwsWR',
    'api.dify.ai': 'app-aochEehgytnJciYeI3L1pqfj'
  };

  if (keys.length > 0) {
    keys.forEach(k => {
      if (k.startsWith('app-zV0') || k.includes('zV0')) {
        apps['night.magene.cn'] = k;
      } else if (k.startsWith('app-aoch') || k.includes('aoch')) {
        apps['api.dify.ai'] = k;
      }
    });
    // 兼容按 [0]=night, [1]=dify.ai 顺序传入的未知 key
    if (keys[0] && !keys[0].startsWith('app-aoch')) apps['night.magene.cn'] = keys[0];
    if (keys[1] && !keys[1].startsWith('app-zV0')) apps['api.dify.ai'] = keys[1];
  }
  return apps;
}

/**
 * 根据 baseUrl 解析应该使用的 API Key:
 *   - 用户显式传入了 key (自定义场景): 优先使用用户传入的 key
 *   - 用户未传 key: 自动匹配内置引擎预设 Key
 *   - 都没有则回退到 fallbackKey (用户上次保存的 Key)
 */
function resolveBuiltinKey(baseUrl, providedKey, fallbackKey) {
  if (providedKey && typeof providedKey === 'string' && providedKey.trim() !== '') {
    return providedKey.trim();
  }
  for (const [host, builtinKey] of Object.entries(getBuiltinDifyApps())) {
    if (baseUrl && baseUrl.includes(host)) {
      return builtinKey;
    }
  }
  return fallbackKey || '';
}

// ⭐ 诊断:从 Render 出去的 IP(用于排查 IP 白名单导致的 403)
// 进程生命周期内只外呼一次 api.ipify.org: 成功则缓存结果复用;
// 失败则缓存空值, 后续请求不再外呼(不再重试), 避免每次翻译都打第三方。
let cachedOutboundIp = null;
let outboundIpResolved = false;
async function getOutboundIp() {
  if (outboundIpResolved) return cachedOutboundIp;
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    if (r.ok) {
      const j = await r.json();
      cachedOutboundIp = j.ip || null;
    }
  } catch {}
  outboundIpResolved = true;
  return cachedOutboundIp;
}

async function executeDifyWithFailover(primaryConfig, inputs, userIdStr) {
  const outboundIp = await getOutboundIp();

  // Built-in fallback candidates (优先稳定高效的 api.dify.ai，其次 night.magene.cn)
  const builtinApps = getBuiltinDifyApps();
  const orderedHosts = ['api.dify.ai', 'night.magene.cn'];
  const builtinCandidates = [];
  for (const host of orderedHosts) {
    if (builtinApps[host]) {
      builtinCandidates.push({
        baseUrl: `https://${host}/v1`,
        apiKey: builtinApps[host]
      });
    }
  }

  const candidates = [primaryConfig, ...builtinCandidates];

  const uniqueCandidates = [];
  const seen = new Set();

  for (const c of candidates) {
    if (!c || !c.baseUrl || !c.apiKey) continue;
    let url = c.baseUrl.replace(/\/$/, '').trim();
    // Resolve the correct key for this URL (builtin takes precedence)
    const key = resolveBuiltinKey(url, c.apiKey, null);
    const sig = `${url}___${key}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      uniqueCandidates.push({ baseUrl: url, apiKey: key });
    }
  }

  // Prioritize preferred engine if it succeeded recently
  if (preferredEngineUrl) {
    const prefIdx = uniqueCandidates.findIndex(c => c.baseUrl === preferredEngineUrl);
    if (prefIdx > 0) {
      const [fav] = uniqueCandidates.splice(prefIdx, 1);
      uniqueCandidates.unshift(fav);
    }
  }

  let lastStatus = 500;
  let lastErrorText = '';

  for (let cIdx = 0; cIdx < uniqueCandidates.length; cIdx++) {
    const item = uniqueCandidates[cIdx];
    const isPrimary = (cIdx === 0);
    // 超时时长放宽至 60 秒 (1 分钟)，确保长文本 + 17 语种大模型推理能够完整接收
    const recentFailTime = engineFailureTimestamps.get(item.baseUrl) || 0;
    const isRecentlyFailed = (Date.now() - recentFailTime < 30000);
    const candidateTimeout = isRecentlyFailed ? 20000 : 60000;
    try {
      const targetUrl = `${item.baseUrl}/workflows/run`;
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${item.apiKey}`,
          'User-Agent': BROWSER_USER_AGENT,
          'Accept': 'text/event-stream',
          'X-Magene-Source': 'GlossaHub'
        },
        signal: AbortSignal.timeout(candidateTimeout),
        body: JSON.stringify({
          inputs,
          response_mode: 'streaming',
          user: userIdStr || 'glossahub_client'
        })
      });

      if (response.ok) {
        // Handle streaming response to keep connection alive and avoid 504 Gateway Timeout from Nginx
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let done = false;
        let finalData = null;
        let streamError = null;
        let buffer = '';

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep the last incomplete line

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data: ')) {
                try {
                  const eventStr = trimmed.substring(6);
                  if (eventStr === 'ping') continue;
                  
                  const eventData = JSON.parse(eventStr);
                  if (eventData.event === 'workflow_finished') {
                    finalData = eventData;
                  } else if (eventData.event === 'error') {
                    streamError = eventData.message || 'Stream error';
                  }
                } catch {
                  // ignore parsing errors on partial chunks
                }
              }
            }
          }
        }

        if (streamError) {
          lastErrorText = streamError;
          engineFailureTimestamps.set(item.baseUrl, Date.now());
          console.warn(`⚠️ Dify workflow stream error on ${item.baseUrl}: ${streamError}`);
        } else if (finalData) {
          const status = finalData.data?.status || finalData.status;
          if (status !== 'failed' && status !== 'stopped') {
            preferredEngineUrl = item.baseUrl;
            return { ok: true, data: { data: finalData.data }, usedUrl: item.baseUrl };
          } else {
            lastErrorText = finalData.data?.error || finalData.error || `Workflow status: ${status}`;
            engineFailureTimestamps.set(item.baseUrl, Date.now());
            console.warn(`⚠️ Dify workflow status ${status} on ${item.baseUrl}: ${lastErrorText}`);
          }
        } else {
          lastErrorText = "Stream finished without workflow_finished event";
          engineFailureTimestamps.set(item.baseUrl, Date.now());
          console.warn(`⚠️ Stream finished without workflow_finished event on ${item.baseUrl}`);
        }
      } else {
        lastStatus = response.status;
        lastErrorText = await response.text();
        engineFailureTimestamps.set(item.baseUrl, Date.now());
        console.warn(`⚠️ Dify API returned ${response.status} from ${item.baseUrl}, trying failover...`);
      }
    } catch (err) {
      console.warn(`⚠️ Dify fetch exception on ${item.baseUrl}: ${err.message}`);
      lastErrorText = err.message;
      engineFailureTimestamps.set(item.baseUrl, Date.now());
    }
  }

  return { ok: false, status: lastStatus, errorText: lastErrorText, triedUrls: uniqueCandidates.map(c => c.baseUrl), outboundIp };
}

// POST /api/projects/:projectId/dify - 保存项目的 Dify 配置
router.post('/projects/:projectId/dify', authenticateToken, requireProjectMember, requireRole(['owner']), async (req, res) => {
  const { projectId } = req.params;
  const { baseUrl, apiKey } = req.body;
  const dbType = getDbType();

  if (!baseUrl) {
    return res.status(400).json({ error: 'baseUrl 不能为空' });
  }

  try {
    const project = await db.queryOne('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    let existingConfig = {};
    if (project.dify_config && typeof project.dify_config === 'object') {
      existingConfig = project.dify_config;
    } else {
      try {
        existingConfig = JSON.parse(project.dify_config || '{}');
      } catch {
        existingConfig = {};
      }
    }
    const builtinApps = getBuiltinDifyApps();
    let finalApiKey = apiKey;
    if (!finalApiKey) {
      if (baseUrl.includes('night.magene.cn')) {
        finalApiKey = builtinApps['night.magene.cn'] || existingConfig.apiKey || '';
      } else if (baseUrl.includes('api.dify.ai')) {
        finalApiKey = builtinApps['api.dify.ai'] || existingConfig.apiKey || '';
      } else {
        finalApiKey = existingConfig.apiKey || '';
      }
    }

    if (!finalApiKey) {
      return res.status(400).json({ error: 'apiKey 不能为空（尚未配置过密钥）' });
    }

    const newConfig = JSON.stringify({ baseUrl, apiKey: finalApiKey });
    if (dbType === 'postgres') {
      await db.run(
        'UPDATE projects SET dify_config = $1::jsonb WHERE id = $2',
        [newConfig, projectId]
      );
    } else {
      await db.run(
        'UPDATE projects SET dify_config = $1 WHERE id = $2',
        [newConfig, projectId]
      );
    }

    res.json({ message: 'Dify 配置已安全存入数据库！' });
  } catch (err) {
    console.error('保存 Dify 配置失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// GET /api/projects/:projectId/role - 获取当前用户在该项目中的角色
router.get('/projects/:projectId/role', authenticateToken, requireProjectMember, async (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ role: 'owner' });
  }
  res.json({ role: req.projectRole });
});

// GET /api/projects/:projectId/dify - 获取项目的 Dify 配置状态 (不返回明文 Key)
router.get('/projects/:projectId/dify', authenticateToken, requireProjectMember, async (req, res) => {
  const { projectId } = req.params;
  try {
    const config = await getEffectiveDifyConfig(projectId);

    res.json({
      baseUrl: config.baseUrl,
      apiKeyConfigured: !!config.apiKey,
      isCustom: config.isCustom,
      // ⭐ 调试用:返回 Key 末 4 位 + 是否匹配内置预设,便于排查 403 问题
      apiKeySuffix: config.apiKey ? config.apiKey.slice(-4) : null,
      matchedBuiltin: config.matchedBuiltin || null,
    });
  } catch (err) {
    console.error('读取 Dify 配置失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// POST /api/projects/:projectId/ai-translate - 后端中转 Dify AI 翻译代理
router.post('/projects/:projectId/ai-translate', authenticateToken, requireProjectMember, requireRole(['owner', 'editor']), aiTranslateLimiter, async (req, res) => {
  const { projectId } = req.params;
  const { inputs } = req.body;
  const userId = req.user?.id || null;

  if (!inputs) {
    return res.status(400).json({ error: '缺少 inputs 输入参数' });
  }

  // ⚠️ 前端统一发送大写 KW (Dify 工作流入参), 兼容旧客户端的小写 kw/keyword
  const termKw = inputs.KW || inputs.kw || inputs.keyword || '';
  const zhCn = (inputs.zh_cn || inputs.chinese || inputs.text || '').trim();
  const targetLangs = inputs.target_languages || inputs.languages || '';

  if (!zhCn) {
    return res.status(400).json({ error: '缺少待翻译的文本内容' });
  }

  try {
    // === START GLOSSARY INTERCEPTION (USING IN-MEMORY CACHE) ===
    const glossaryTerms = await getCachedGlossaryTerms(projectId);

    const allMatches = glossaryTerms.filter(term => term.cn_term === zhCn);
    let fullMatch = null;

    if (allMatches.length === 1) {
      fullMatch = allMatches[0];
    } else if (allMatches.length > 1) {
      const inputContext = (inputs.context || inputs.所在页面 || '').trim();
      const inputKw = (inputs.kw || inputs.keyword || inputs.KW || '').trim().toLowerCase();

      const subTerms = glossaryTerms.filter(t => 
        t.cn_term !== zhCn && t.cn_term.length >= 2 && zhCn.includes(t.cn_term)
      );

      const scoredMatches = allMatches.map(term => {
        let score = 0;
        let termFields = parseJsonField(term && term.fields);

        const pageContext = (termFields['所在页面'] || '').trim();
        const termKwVal = (termFields.KW || term.kw || '').trim().toLowerCase();
        const enTerm = (term.en_term || '').trim();
        const enLower = enTerm.toLowerCase();

        if (inputContext && inputContext !== '无' && pageContext) {
          if (pageContext.includes(inputContext) || inputContext.includes(pageContext)) {
            score += 100;
          }
        }

        if (inputKw && termKwVal) {
          if (inputKw === termKwVal || inputKw.includes(termKwVal) || termKwVal.includes(inputKw)) {
            score += 50;
          }
        }

        subTerms.forEach(sub => {
          const subEn = (sub.en_term || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (subEn.length >= 3) {
            const shortSub = subEn.substring(0, 3);
            if (enLower.includes(shortSub)) {
              score += 30;
            }
          }
        });

        if (enTerm.length > 0) {
          score += Math.min(10, enTerm.length);
        }

        const hasOtherLangs = Object.keys(termFields).some(k => k !== '所在页面' && k !== 'KW' && k !== '字号类别' && termFields[k]);
        if (hasOtherLangs) {
          score += 5;
        }

        return { term, score };
      });

      scoredMatches.sort((a, b) => b.score - a.score);
      fullMatch = scoredMatches[0].term;
    }

    if (fullMatch) {
      const parsedTargetLangs = (typeof targetLangs === 'string' ? targetLangs.split(',') : targetLangs).map(l => l.trim()).filter(Boolean);
      let tmTranslations = {};
      const termFields = parseJsonField(fullMatch && fullMatch.fields);

      const fieldsKeys = Object.keys(termFields);
      parsedTargetLangs.forEach(lang => {
        if (lang === '英文' || lang.includes('EN') || lang.toLowerCase() === 'english') {
          tmTranslations[lang] = typeof fullMatch.en_term === 'object' 
            ? (fullMatch.en_term?.text || JSON.stringify(fullMatch.en_term)) 
            : String(fullMatch.en_term || '');
        } else {
          const normLang = lang.replace(/语|文/g, '');
          const matchedKey = fieldsKeys.find(k => k === lang || k.includes(normLang));
          let rawVal = matchedKey ? termFields[matchedKey] : '';
          if (typeof rawVal === 'object' && rawVal !== null) {
            if (Array.isArray(rawVal)) {
              rawVal = rawVal.map(x => (typeof x === 'object' ? x?.text || '' : String(x))).join('');
            } else if (rawVal.text !== undefined) {
              rawVal = String(rawVal.text);
            } else {
              rawVal = JSON.stringify(rawVal);
            }
          }
          tmTranslations[lang] = String(rawVal || '');
        }
      });

      // 默认不纠正调用方已提供的现存翻译
      if (inputs.preserve_existing !== false && inputs.existing_translations && typeof inputs.existing_translations === 'object') {
        Object.entries(inputs.existing_translations).forEach(([k, v]) => {
          if (v && String(v).trim()) {
            const matchedKey = Object.keys(tmTranslations).find(tk => tk === k || tk.replace(/语|文/g, '') === k.replace(/语|文/g, ''));
            if (matchedKey) {
              tmTranslations[matchedKey] = String(v).trim();
            } else {
              tmTranslations[k] = String(v).trim();
            }
          }
        });
      }

      return res.json({ ...tmTranslations, _source: 'tm' });
    }

    let matchedTerms = [];
    const nonLangKeys = new Set(['所在页面', '字号类别', 'KW', 'kw', 'CN（中文）', 'id', 'created_at', 'updated_at']);
    glossaryTerms.forEach(term => {
      const cn = (term.cn_term || '').trim();
      // 过滤单字符或纯符号，防止无意义的部分匹配导致 prompt 膨胀与 token 超标
      if (cn.length >= 2 && zhCn.includes(cn)) {
        const termFields = parseJsonField(term && term.fields);

        let targetConstraints = { "英文": term.en_term };
        Object.keys(termFields).forEach(k => {
          if (!nonLangKeys.has(k) && termFields[k]) {
            targetConstraints[k] = termFields[k];
          }
        });

        matchedTerms.push({
          "中文名词": cn,
          "各语种强制翻译": targetConstraints
        });
      }
    });

    // 如果传入了现有语种翻译（如英语已译），将其置顶为第一优先级的强制对齐约束
    if (inputs.existing_translations && typeof inputs.existing_translations === 'object' && Object.keys(inputs.existing_translations).length > 0) {
      matchedTerms.unshift({
        "中文名词": zhCn,
        "各语种强制翻译": inputs.existing_translations,
        "重要规则": "当前词条已确认的现有翻译，请严格保持各目标语种含义与已有翻译对齐，切勿纠正或修改已有翻译"
      });
    }

    if (matchedTerms.length > 0) {
      // 限制最多注入 15 条最相关的名词约束，防止 prompt 过大导致 LLM 推理卡顿 30+ 秒
      inputs.glossary_context = JSON.stringify(matchedTerms.slice(0, 15), null, 2);
    } else {
      inputs.glossary_context = "";
    }
    // === END GLOSSARY INTERCEPTION ===

    const config = await getEffectiveDifyConfig(projectId);
    const result = await executeDifyWithFailover(config, inputs, `user_${userId}`);

    if (!result.ok) {
      const errorText = result.errorText || '';
      let cleanMsg = errorText;
      
      // ⭐ 精确匹配 HTTP status,不再用 errorText.includes 模糊判断(Dify 错误描述里可能带 "403" 等字样)
      if (result.status === 504) {
        cleanMsg = 'Dify 接口响应超时 (HTTP 504 Gateway Timeout)。已重试全量备用引擎，请确认服务可用性。';
      } else if (result.status === 502) {
        cleanMsg = 'Dify 网关响应异常 (HTTP 502 Bad Gateway)。建议在【系统设置】中切换引擎。';
      } else if (result.status === 403) {
        cleanMsg = 'Dify 拒绝访问 (HTTP 403 Forbidden)。请检查 API Key 是否正确或已授权。';
      } else if (result.status === 401) {
        cleanMsg = 'Dify 校验失败 (HTTP 401 Unauthorized)。API Key 无效。';
      } else if (errorText.includes('<html') || errorText.includes('<HTML')) {
        cleanMsg = `Dify 远程服务器响应异常 (HTTP ${result.status})`;
      } else {
        try {
          const parsed = JSON.parse(errorText);
          cleanMsg = parsed?.message || parsed?.error || errorText;
        } catch {
          cleanMsg = errorText;
        }
      }

      // ⭐ 调试模式:返回 Dify 真实响应,前端能直接看到原始错误
      // 仅系统管理员可见原始错误/备用引擎列表/出口 IP, 普通用户只拿脱敏文案
      const debugPayload = (req.query.debug === '1' || req.body?.debug === true) && req.user?.role === 'admin';
      const responseBody = {
        error: `Dify API 响应错误: ${cleanMsg}`,
      };
      if (debugPayload) {
        responseBody.debug = {
          difyStatus: result.status,
          difyRaw: (errorText || '').slice(0, 1000),
          triedUrls: result.triedUrls || [],
          outboundIp: result.outboundIp || null, // ⭐ Render 后端对外 IP
          timestamp: new Date().toISOString(),
        };
        console.warn(`🔍 [dify-debug] status=${result.status} tried=${responseBody.debug.triedUrls.join(' → ')}`);
        console.warn(`🔍 [dify-debug] raw: ${responseBody.debug.difyRaw}`);
        console.warn(`🔍 [dify-debug] outboundIp: ${result.outboundIp || 'unknown'}`);
      }

      return res.status(result.status || 500).json(responseBody);
    }

    const data = result.data;

    const workflowStatus = data.data?.status || data.status;
    const workflowError = data.data?.error || data.error;
    if (workflowStatus === 'failed' || workflowStatus === 'stopped') {
      console.error('⚠️ Dify workflow failed:', JSON.stringify({ status: workflowStatus, error: workflowError }));
      const errorStr = String(workflowError || '');
      const isRateLimit = errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED') || errorStr.includes('rate_limit') || errorStr.includes('quota');
      const httpStatus = isRateLimit ? 429 : 500;
      return res.status(httpStatus).json({ error: `Dify 工作流执行失败 (status: ${workflowStatus}): ${workflowError || '未知错误，请检查 Dify 工作流日志'}` });
    }

    const usageTokens = data.data?.total_tokens || 0;
    const usageElapsed = data.data?.elapsed_time || 0;
    const usageStatus = data.data?.status || 'success';
    db.query(
      'INSERT INTO ai_usage_logs (user_id, project_id, term_kw, zh_cn, target_languages, total_tokens, elapsed_time, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [userId, projectId, termKw, zhCn.slice(0, 200), targetLangs, usageTokens, usageElapsed, usageStatus]
    ).catch(err => console.error('AI用量日志写入失败:', err.message));

    let outputs = data.data?.outputs || data.outputs;
    if (!outputs || typeof outputs !== 'object' || Object.keys(outputs).length === 0) {
      if (data.data?.result || data.result) {
        outputs = { result: data.data?.result || data.result };
      } else if (data.data?.text || data.text) {
        outputs = { text: data.data?.text || data.text };
      } else if (data.data?.answer || data.answer) {
        outputs = { answer: data.data?.answer || data.answer };
      } else if (data.data?.response || data.response) {
        outputs = { response: data.data?.response || data.response };
      } else if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
        outputs = data.data;
      } else {
        outputs = data;
      }
    }

    if (!outputs || typeof outputs !== 'object') {
      console.error('⚠️ Dify raw data:', JSON.stringify(data));
      return res.status(500).json({ error: `Dify 工作流未返回任何有效数据。原始响应: ${JSON.stringify(data).slice(0, 300)}` });
    }

    const outputKeys = Object.keys(outputs);
    if (outputKeys.some(k => k.includes('英') || k.includes('法') || k.includes('德') || k.includes('日') || k.includes('EN') || k.includes('FR') || k.includes('CN') || k.includes('中文'))) {
      return res.json(outputs);
    }

    let rawVal = outputs.result || outputs.translations || outputs.output || outputs.text || outputs.answer || outputs.response || outputs.res || outputs.data || outputs.json;

    if (rawVal === undefined && outputKeys.length === 1) {
      rawVal = outputs[outputKeys[0]];
    }

    if (rawVal === undefined) {
      for (const key of outputKeys) {
        const val = outputs[key];
        if (typeof val === 'string' && val.trim().startsWith('{')) {
          rawVal = val;
          break;
        }
      }
    }

    if (rawVal === undefined || rawVal === null) {
      console.error('⚠️ Dify raw response data structure:', JSON.stringify(data));
      return res.status(500).json({ 
        error: `Dify 工作流未包含有效输出变量 (当前 Dify 输出字段为: ${outputKeys.join(', ') || '无'})。原始响应片段: ${JSON.stringify(data).slice(0, 200)}` 
      });
    }

    // Robust JSON Repair & Extraction Helper (Strips DeepSeek <think> reasoning blocks)
    const tryExtractAndParseJson = (inputStr) => {
      if (!inputStr || typeof inputStr !== 'string') return null;
      let cleaned = inputStr.trim();

      // 1. Remove <think>...</think> reasoning blocks and Chinese thinking headers
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      cleaned = cleaned.replace(/已深度思考[\s\S]*?(?=\{|$)/gi, '').trim();
      cleaned = cleaned.replace(/Thinking Process:[\s\S]*?(?=\{|$)/gi, '').trim();

      // 2. Remove markdown code blocks (```json ... ```)
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      // 3. Direct JSON parse attempt
      try {
        const obj = JSON.parse(cleaned);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
      } catch {}

      // 4. Try parsing from first index of '{' to last index of '}'
      const firstOpen = cleaned.indexOf('{');
      const lastClose = cleaned.lastIndexOf('}');
      if (firstOpen !== -1 && lastClose > firstOpen) {
        const candidate = cleaned.slice(firstOpen, lastClose + 1);
        try {
          const obj = JSON.parse(candidate);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        } catch {}

        try {
          let repaired = candidate
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/(['"])?([a-zA-Z0-9_\u4e00-\u9fa5]+)\1\s*:/g, '"$2":');
          const obj = JSON.parse(repaired);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        } catch {}
      }

      // 5. General regex match fallback
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const obj = JSON.parse(jsonMatch[0]);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        } catch {}

        try {
          let repaired = jsonMatch[0]
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/(['"])?([a-zA-Z0-9_\u4e00-\u9fa5]+)\1\s*:/g, '"$2":');
          const obj = JSON.parse(repaired);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        } catch {}
      }
      return null;
    };

    const isTranslationObj = (obj) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
      const keys = Object.keys(obj);
      return keys.length > 0 && !obj.error && keys.some(k => 
        k.includes('英') || k.includes('法') || k.includes('德') || k.includes('日') || 
        k.includes('EN') || k.includes('FR') || k.includes('DE') || k.includes('ES') || 
        k.includes('CN') || k.includes('中文') || k.length <= 6
      );
    };

    if (typeof rawVal === 'object' && rawVal !== null) {
      if (rawVal.error) {
        const fallbackText = rawVal.raw_output || rawVal.text || rawVal.result || rawVal.raw || '';
        const repairedObj = tryExtractAndParseJson(fallbackText);
        if (repairedObj && isTranslationObj(repairedObj)) {
          console.log('✅ 成功从 Dify Code 节点的 raw_output 中容错解析出完整 JSON 翻译!');
          return res.json(repairedObj);
        }
        return res.status(500).json({ error: `Dify 脚本节点抛出错误: ${rawVal.error}` });
      }
      return res.json(rawVal);
    }

    const parsedObj = tryExtractAndParseJson(String(rawVal));
    if (parsedObj && typeof parsedObj === 'object') {
      if (parsedObj.error) {
        const fallbackText = parsedObj.raw_output || parsedObj.text || '';
        const repairedObj = tryExtractAndParseJson(fallbackText);
        if (repairedObj && isTranslationObj(repairedObj)) {
          console.log('✅ 成功容错修复解析 Dify raw_output JSON!');
          return res.json(repairedObj);
        }
        return res.status(200).json({ error: `Dify 脚本节点抛出错误: ${parsedObj.error}` });
      }
      return res.json(parsedObj);
    }

    res.status(500).json({ error: `解析 Dify 输出 JSON 失败。原始输出为: ${String(rawVal).slice(0, 200)}` });
  } catch (err) {
    console.error('中转 AI 翻译失败:', err);
    // ⭐ 调试模式:把异常消息 + Render 出口 IP 暴露出来 (仅管理员, 防止向普通用户泄漏内部错误细节)
    const debugRequested = req.query.debug === '1' || req.body?.debug === true;
    if (debugRequested && req.user?.role === 'admin') {
      const debugInfo = {
        message: err?.message || String(err),
        stack: (err?.stack || '').split('\n').slice(0, 3).join(' | '),
        timestamp: new Date().toISOString(),
      };
      res.status(500).json({
        error: `服务器内部错误: ${err?.message || err}`,
        debug: debugInfo,
      });
    } else {
      res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
    }
  }
});

// POST /api/projects/:projectId/generate-kw - 根据中文源词与参考英文生成 KW 标识
router.post('/projects/:projectId/generate-kw', authenticateToken, requireProjectMember, async (req, res) => {
  const { projectId } = req.params;
  const { text, enText, context } = req.body;

  if ((!text || !text.trim()) && (!enText || !enText.trim())) {
    return res.status(400).json({ error: '中文源词 (text) 或参考英文 (enText) 不能为空' });
  }

  try {
    const generated = await generateKwHelper(projectId, text, enText, context);
    res.json({ kw: generated });
  } catch (err) {
    console.error('生成 KW 失败:', err);
    res.status(500).json({ error: '生成 KW 失败，请重试。' });
  }
});

// POST /api/projects/:projectId/batch-generate-kw - 批量预览生成 KW
router.post('/projects/:projectId/batch-generate-kw', authenticateToken, requireProjectMember, async (req, res) => {
  const { projectId } = req.params;
  const { items = [] } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '待生成词条列表 (items) 不能为空' });
  }

  try {
    const results = [];
    for (const item of items) {
      const text = item.text || item.zh_cn || '';
      const enText = item.enText || item.en || '';
      const context = item.context || '';
      const kw = await generateKwHelper(projectId, text, enText, context);
      results.push({
        id: item.id || item.recordId,
        text,
        enText,
        kw
      });
    }
    res.json({ results });
  } catch (err) {
    console.error('批量生成 KW 失败:', err);
    res.status(500).json({ error: '批量生成 KW 失败' });
  }
});

// POST /api/projects/:projectId/dify-test - 测试 Dify 连接性
//
// 注意: 上游 Dify API 的 401/403 是 *业务错误* (Key 无效 / 权限不足),
// 不是当前用户的会话失效, 不能让前端跳登录。
// 因此 upstream 非 2xx 一律映射到 4xx/5xx 业务错误, 并通过 X-Business-Error
// header 标识这是业务级错误 (前端 apiFetch 据此不触发跳登录)。
router.post('/projects/:projectId/dify-test', authenticateToken, requireProjectMember, async (req, res) => {
  const { projectId } = req.params;
  const { baseUrl, apiKey } = req.body;

  const effective = await getEffectiveDifyConfig(projectId);
  const targetUrl = (baseUrl || effective.baseUrl || '').trim();

  // SSRF 防护: 拦截内网/私有 IP 地址
  if (isPrivateOrLocalUrl(targetUrl)) {
    return res
      .status(400)
      .set('X-Business-Error', 'ssrf-blocked')
      .json({ error: '安全拦截：禁止连接内网私有地址！' });
  }

  const targetKey = resolveBuiltinKey(targetUrl, apiKey, effective.apiKey);

  if (!targetUrl || !targetKey) {
    return res
      .status(400)
      .set('X-Business-Error', 'missing-config')
      .json({ error: 'baseUrl 和 apiKey 不能为空，请选择内置预设或填写自定义参数' });
  }

  try {
    const cleanBaseUrl = targetUrl.replace(/\/$/, '');
    const url = `${cleanBaseUrl}/workflows/run`;

    const testInputs = {
      KW: 'KW_CONNECTION_TEST',
      text: '测试',
      context: '设置',
      target_languages: 'EN（英文）'
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${targetKey}`,
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'X-Magene-Source': 'GlossaHub'
      },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        inputs: testInputs,
        response_mode: 'blocking',
        user: 'glossahub_connection_test'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      let cleanMsg = errorText;
      // ⭐ 精确匹配 HTTP status,不再用 errorText.includes('403 Forbidden') 模糊判断
      //    (Dify 工作流错误描述里偶尔会带 "403" 字样, 会被误判)
      if (response.status === 403) {
        cleanMsg = 'HTTP 403 Forbidden (API Key 无权访问此接口，请确认 Key 是否正确)';
      } else if (response.status === 401) {
        cleanMsg = 'HTTP 401 Unauthorized (API Key 无效或已过期，请重新配置)';
      } else if (errorText.includes('<html') || errorText.includes('<HTML')) {
        cleanMsg = `HTTP ${response.status}: 服务器拒绝连接 (可能接口地址错误或服务器不可达)`;
      } else {
        // ⭐ 其他情况(Dify 400 workflow 执行错误等):透传 Dify 真实 message
        try {
          const parsed = JSON.parse(errorText);
          cleanMsg = `Dify 返回错误 (HTTP ${response.status}): ${parsed?.message || parsed?.error || errorText}`;
        } catch {
          cleanMsg = `Dify 返回错误 (HTTP ${response.status}): ${errorText.slice(0, 200)}`;
        }
      }
      // 把 upstream 401/403 透传会被前端误判为"用户会话失效", 一律映射为 502
      // (业务错误, 不是认证错误) 并带 X-Business-Error 头让 apiFetch 区分。
      const businessStatus = response.status === 401 || response.status === 403 ? 502 : 400;
      const responseBody = { error: cleanMsg };
      // ⭐ 调试模式:返回真实 Dify 响应 (仅管理员可见原始错误/目标 URL/Key 后缀)
      if ((req.query.debug === '1' || req.body?.debug === true) && req.user?.role === 'admin') {
        responseBody.debug = {
          difyStatus: response.status,
          difyRaw: errorText.slice(0, 500),
          targetUrl,
          keySuffix: targetKey ? `...${targetKey.slice(-4)}` : null,
        };
        console.warn(`🔍 [dify-test-debug] status=${response.status} url=${targetUrl} keySuffix=${responseBody.debug.keySuffix}`);
        console.warn(`🔍 [dify-test-debug] raw: ${errorText.slice(0, 500)}`);
      }
      return res
        .status(businessStatus)
        .set('X-Business-Error', 'dify-upstream-rejected')
        .json(responseBody);
    }

    res.json({ success: true, message: 'Dify 引擎连接测试成功！' });
  } catch (err) {
    console.error('连接测试失败:', err);
    res
      .status(500)
      .set('X-Business-Error', 'dify-network-error')
      .json({ error: '服务器内部错误，请稍后重试。' });
  }
});

module.exports = router;
