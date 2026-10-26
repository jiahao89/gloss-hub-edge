const express = require('express');
const router = express.Router();
const { db, getDbType } = require('../config/db.cjs');
const { authenticateToken } = require('../middleware/auth.cjs');

// GET /api/dashboard/stats - 获取看版数据统计
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    // 前端当前未传 projectId，保持 'proj-default' 兜底；后续多项目看板可通过 ?projectId=xxx 指定
    const projectId = req.query.projectId || 'proj-default';
    const dbType = getDbType();
    const isPg = dbType === 'postgres';

    const languages = await db.query(
      'SELECT lang_name FROM languages WHERE project_id = $1 ORDER BY display_order ASC',
      [projectId]
    );
    const langNames = languages.map(l => l.lang_name);
    const langCount = langNames.length || 1;

    // 聚合下推：旧实现把最多 5 万行 terms（含 translations JSON）拉进 Node 内存做
    // JS 统计，且前端每 10s 轮询本接口，单次请求 CPU/内存开销随库容线性增长。
    // 现在统计全部下推到数据库（jsonb_each_text / json_each）并行执行。
    // $N 占位符按本代码库约定统一书写，SQLite 驱动自动转 ?（重复的 $N 需按出现顺序重复传参）。
    const jsonEachFn = isPg ? 'jsonb_each_text' : 'json_each';
    const translationsExpr = isPg ? 'p.translations' : "CASE WHEN json_valid(p.translations) THEN p.translations ELSE '{}' END";

    let langCond;
    let langFilterParams = [];
    if (langNames.length > 0) {
      if (isPg) {
        langCond = 'je.key = ANY($2)';
        langFilterParams = [langNames];
      } else {
        langCond = `je.key IN (${langNames.map((_, i) => `$${i + 2}`).join(',')})`;
        langFilterParams = [...langNames];
      }
    } else {
      langCond = '1 = 0';
    }

    const projTermsCte = `
      WITH proj_terms AS (
        SELECT t.id, t.version_id, t.translations, t.status
        FROM terms t
        JOIN versions v ON t.version_id = v.id
        WHERE v.project_id = $1
      )`;

    // 查询 1: 每版本词条数 / 全翻译词条数 / 填充单元格数 / 已审核词条数
    // 用相关标量子查询计算每条词条的填充数（不依赖 id JOIN：SQLite 的 TEXT
    // PRIMARY KEY 允许 NULL，遗留 NULL id 行会让 LEFT JOIN 漏计）
    const perVersionSql = `${projTermsCte},
      per_term AS (
        SELECT p.version_id, p.status,
          (SELECT COUNT(*) FROM ${isPg ? 'LATERAL ' : ''}${jsonEachFn}(${translationsExpr}) je
           WHERE TRIM(je.value) <> '' AND ${langCond}) AS filled_cnt
        FROM proj_terms p
      )
      SELECT
        version_id,
        COUNT(*) AS total_terms,
        COALESCE(SUM(CASE WHEN filled_cnt >= $3 THEN 1 ELSE 0 END), 0) AS fully_translated,
        COALESCE(SUM(filled_cnt), 0) AS filled_cells,
        COALESCE(SUM(CASE WHEN status IN ('APPROVED', 'PUBLISHED') THEN 1 ELSE 0 END), 0) AS reviewed_terms
      FROM per_term
      GROUP BY version_id`;

    // 查询 2: 每语种填充单元格数（langFilledMap）
    const langFilledSql = `${projTermsCte}
      SELECT je.key AS lang, COUNT(*) AS filled
      FROM proj_terms p, ${isPg ? 'LATERAL ' : ''}${jsonEachFn}(${translationsExpr}) je
      WHERE TRIM(je.value) <> '' AND ${langCond}
      GROUP BY je.key`;

    const recentLogsRaw = await db.query(
      `SELECT l.*, u.name AS operator_name FROM ${dbType === 'postgres' ? 'logs' : 'logs_v2'} l
       LEFT JOIN users u ON l.user_id = u.id
       ORDER BY l.id DESC LIMIT 5`
    );

    const [versions, perVersionRows, langFilledRows] = await Promise.all([
      db.query('SELECT id, version_name FROM versions WHERE project_id = $1', [projectId]),
      db.query(perVersionSql, isPg ? [projectId, langNames, langCount] : [projectId, ...langNames, langCount]),
      db.query(langFilledSql, [projectId, ...langFilterParams])
    ]);

    const langFilledMap = {};
    langNames.forEach(l => { langFilledMap[l] = 0; });
    for (const r of langFilledRows) {
      if (Object.prototype.hasOwnProperty.call(langFilledMap, r.lang)) {
        langFilledMap[r.lang] = parseInt(r.filled, 10) || 0;
      }
    }
    const filledCells = Object.values(langFilledMap).reduce((a, b) => a + b, 0);

    const versionCount = versions.length;

    let termCount = 0;
    let fullyTranslatedCount = 0;
    let reviewedTerms = 0;

    const versionStatsMap = {};
    versions.forEach(v => {
      versionStatsMap[v.id] = { id: v.id, name: v.version_name, totalTerms: 0, filledCells: 0, fullyTranslatedTerms: 0 };
    });

    for (const row of perVersionRows) {
      const total = parseInt(row.total_terms, 10) || 0;
      const fully = parseInt(row.fully_translated, 10) || 0;
      const filled = parseInt(row.filled_cells, 10) || 0;
      const reviewed = parseInt(row.reviewed_terms, 10) || 0;
      termCount += total;
      fullyTranslatedCount += fully;
      reviewedTerms += reviewed;

      const vStat = versionStatsMap[row.version_id];
      if (vStat) {
        vStat.totalTerms = total;
        vStat.filledCells = filled;
        vStat.fullyTranslatedTerms = fully;
      }
    }

    const tableProgress = Object.values(versionStatsMap).map(vStat => {
      const vTotalCells = vStat.totalTerms * langCount;
      const progress = vTotalCells > 0 ? Math.round((vStat.filledCells / vTotalCells) * 100) : 0;
      return { id: vStat.id, name: vStat.name, totalTerms: vStat.totalTerms, fullyTranslatedTerms: vStat.fullyTranslatedTerms, progress };
    });

    // 与旧 JS 实现口径一致: 每个已审核词条为全部语种各 +1（与该语种是否填翻译无关）
    const langReviewedMap = {};
    langNames.forEach(l => { langReviewedMap[l] = reviewedTerms; });

    const totalCells = termCount * langCount;
    const globalCoverage = totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0;

    const langProgress = langNames.map(l => ({
      lang: l,
      filled: langFilledMap[l],
      total: termCount,
      coverage: termCount > 0 ? Math.round((langFilledMap[l] / termCount) * 100) : 0
    }));

    const langReviewProgress = langNames.map(l => ({
      lang: l,
      filled: langReviewedMap[l],
      total: termCount,
      coverage: termCount > 0 ? Math.round((langReviewedMap[l] / termCount) * 100) : 0
    }));
    const reviewCoverage = termCount > 0 ? Math.round((reviewedTerms / termCount) * 100) : 0;

    const recentLogs = recentLogsRaw.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      kw: r.kw,
      chinese: r.chinese,
      action: r.action,
      details: r.details,
      version: r.version_name,
      // Do NOT fall back to a real person's name when the actor's user row has
      // been deleted (ON DELETE SET NULL would leave operator_name NULL). The
      // previous fallback used "王赵云" here, which silently mis-attributed
      // orphan log entries to an existing super-admin — an audit-trail bug.
      operator: r.operator_name || '已删除用户'
    }));

    res.json({
      versionCount,
      termCount,
      filledCells,
      totalCells,
      coverage: globalCoverage,
      fullyTranslatedCount,
      tableProgress,
      langProgress,
      langReviewProgress,
      reviewedTermCount: reviewedTerms,
      reviewCoverage,
      recentLogs,
      // 统计已下推数据库，不再有 5 万行截断保护
      truncated: false
    });
  } catch (err) {
    console.error('获取看板统计数据失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// GET /api/dashboard/ai-usage - AI 用量统计
router.get('/ai-usage', authenticateToken, async (_req, res) => {
  const dbType = getDbType();
  try {
    let todayStats, weekStats, dailyTrend;

    if (dbType === 'postgres') {
      todayStats = await db.query(`
        SELECT
          COUNT(*) AS call_count,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(elapsed_time), 0) AS total_elapsed
        FROM ai_usage_logs
        WHERE created_at >= CURRENT_DATE
      `);

      weekStats = await db.query(`
        SELECT
          COUNT(*) AS call_count,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM ai_usage_logs
        WHERE created_at >= NOW() - INTERVAL '7 days'
      `);

      dailyTrend = await db.query(`
        SELECT
          TO_CHAR(created_at, 'YYYY-MM-DD') AS date,
          COUNT(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS tokens
        FROM ai_usage_logs
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
        ORDER BY date ASC
      `);
    } else {
      todayStats = await db.query(`
        SELECT
          COUNT(*) AS call_count,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(elapsed_time), 0) AS total_elapsed
        FROM ai_usage_logs
        WHERE created_at >= datetime('now', 'start of day')
      `);

      weekStats = await db.query(`
        SELECT
          COUNT(*) AS call_count,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM ai_usage_logs
        WHERE created_at >= datetime('now', '-7 days')
      `);

      dailyTrend = await db.query(`
        SELECT
          DATE(created_at) AS date,
          COUNT(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS tokens
        FROM ai_usage_logs
        WHERE created_at >= datetime('now', '-7 days')
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at) ASC
      `);
    }

    res.json({
      today: {
        calls: todayStats[0]?.call_count || 0,
        tokens: todayStats[0]?.total_tokens || 0,
        elapsed: todayStats[0]?.total_elapsed || 0
      },
      week: {
        calls: weekStats[0]?.call_count || 0,
        tokens: weekStats[0]?.total_tokens || 0
      },
      dailyTrend: dailyTrend.map(d => ({ date: d.date, calls: d.calls, tokens: d.tokens }))
    });
  } catch (err) {
    console.error('获取 AI 用量统计失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
