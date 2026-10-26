const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db, getDbType } = require('../config/db.cjs');
const { authenticateToken, requireTermOwnership, requireVersionOwnership } = require('../middleware/auth.cjs');
const { writeLimiter } = require('../middleware/rateLimiters.cjs');
const { bulkInsertToRecycleBin } = require('../services/recycleBin.cjs');
const { parseJsonField } = require('../utils/jsonFields.cjs');
const { TARGET_LANGUAGES, LEGACY_TO_NEW_LANG_MAP } = require('../config/constants.cjs');
const { createAuditLog } = require('../services/auditLogger.cjs');
const { generateKwHelper } = require('../services/difyService.cjs');
const ExcelJS = require('exceljs');

// 批量 termIds 全集归属校验 (弥补只抽查 termIds[0] 的越权漏洞)。
// 任一 id 不存在或不属于该用户所在项目 → 返回 false (路由层转 403)。
// 系统管理员 (role==='admin') 直接放行, 与 requireTermOwnership 语义一致。
async function requireAllTermsOwnership(userId, termIds, userRole) {
  if (userRole === 'admin') return true;
  if (!Array.isArray(termIds) || termIds.length === 0) return false;
  const placeholders = termIds.map((_, i) => `$${i + 1}`).join(',');
  const row = await db.queryOne(
    `SELECT COUNT(DISTINCT t.id) as cnt FROM terms t
     JOIN versions v ON t.version_id = v.id
     JOIN project_members pm ON pm.project_id = v.project_id
     WHERE t.id IN (${placeholders}) AND pm.user_id = $${termIds.length + 1}
       AND pm.role IN ('owner', 'editor')`,
    [...termIds, userId]
  );
  return parseInt(row?.cnt || 0, 10) === termIds.length;
}

// GET /api/tables/:tableId/records - 读取特定版本下的所有词条数据 (分页)
router.get('/tables/:tableId/records', authenticateToken, async (req, res) => {
  const { tableId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 50;
  const statusFilter = req.query.status || '';
  const untranslated = req.query.untranslated === 'true' || req.query.untranslated === '1';

  try {
    const dbType = getDbType();
    let whereClause = 'WHERE version_id = $1';
    const queryParams = [tableId];
    let paramIndex = 2;

    const rawSearch = (req.query.search || '').trim();
    if (rawSearch) {
      const tokens = rawSearch.split(/\s+/).filter(Boolean);
      const escapeLike = (str) => str.replace(/([%_\\])/g, '\\$1');

      if (dbType === 'sqlite') {
        const tokenClauses = [];
        for (const token of tokens) {
          const p1 = paramIndex, p2 = paramIndex + 1, p3 = paramIndex + 2, p4 = paramIndex + 3, p5 = paramIndex + 4;
          tokenClauses.push(`(kw LIKE $${p1} ESCAPE '\\' OR zh_cn LIKE $${p2} ESCAPE '\\' OR context LIKE $${p3} ESCAPE '\\' OR owner LIKE $${p4} ESCAPE '\\' OR translations LIKE $${p5} ESCAPE '\\')`);
          const searchPattern = `%${escapeLike(token)}%`;
          queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
          paramIndex += 5;
        }
        if (tokenClauses.length > 0) {
          whereClause += ` AND (${tokenClauses.join(' AND ')})`;
        }
      } else {
        const tokenClauses = [];
        for (const token of tokens) {
          tokenClauses.push(`(kw ILIKE $${paramIndex} ESCAPE '\\' OR zh_cn ILIKE $${paramIndex} ESCAPE '\\' OR context ILIKE $${paramIndex} ESCAPE '\\' OR owner ILIKE $${paramIndex} ESCAPE '\\' OR translations::text ILIKE $${paramIndex} ESCAPE '\\')`);
          queryParams.push(`%${escapeLike(token)}%`);
          paramIndex++;
        }
        if (tokenClauses.length > 0) {
          whereClause += ` AND (${tokenClauses.join(' AND ')})`;
        }
      }
    }

    if (statusFilter) {
      if (statusFilter === 'DRAFT') {
        whereClause += ` AND (status = 'DRAFT' OR status = 'PENDING_REVIEW' OR status = 'TRANSLATING')`;
      } else {
        whereClause += ` AND status = $${paramIndex}`;
        queryParams.push(statusFilter);
        paramIndex++;
      }
    }

    if (untranslated) {
      // 动态获取当前数据表对应项目配置的有效语种列表 (避免硬编码导致语种字段名不匹配)
      const verRow = await db.queryOne('SELECT project_id FROM versions WHERE id = $1', [tableId]);
      const projectId = verRow?.project_id || 'proj-default';
      const langRows = await db.query(
        'SELECT lang_name FROM languages WHERE project_id = $1 ORDER BY display_order ASC',
        [projectId]
      );
      const activeLangs = (langRows && langRows.length > 0)
        ? langRows.map(l => l.lang_name)
        : TARGET_LANGUAGES;

      if (activeLangs.length > 0) {
        if (dbType === 'sqlite') {
          const conditions = activeLangs.map(lang => `(json_extract(translations, '$.${lang}') IS NULL OR json_extract(translations, '$.${lang}') = '')`);
          whereClause += ` AND (${conditions.join(' OR ')})`;
        } else {
          const conditions = activeLangs.map((lang, idx) => {
            const p = paramIndex + idx;
            return `(translations->>$${p} IS NULL OR translations->>$${p} = '')`;
          });
          queryParams.push(...activeLangs);
          paramIndex += activeLangs.length;
          whereClause += ` AND (${conditions.join(' OR ')})`;
        }
      }
    }

    const sortBy = req.query.sortBy || 'default';
    const sortOrder = (req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let orderByClause = 'ORDER BY sort_order ASC, created_at ASC, id ASC';
    if (sortBy === 'updated_at' || sortBy === 'updatedAt') {
      orderByClause = `ORDER BY COALESCE(updated_at, created_at, '') ${sortOrder}, id ${sortOrder}`;
    } else if (sortBy === 'created_at' || sortBy === 'createdAt') {
      orderByClause = `ORDER BY COALESCE(created_at, updated_at, '') ${sortOrder}, id ${sortOrder}`;
    } else if (sortBy === 'kw' || sortBy === 'KW') {
      orderByClause = `ORDER BY kw ${sortOrder}, id ${sortOrder}`;
    } else if (sortBy === 'zh_cn' || sortBy === 'zhCn') {
      orderByClause = `ORDER BY zh_cn ${sortOrder}, id ${sortOrder}`;
    } else if (sortBy === 'status') {
      orderByClause = `ORDER BY status ${sortOrder}, id ${sortOrder}`;
    }

    const countQuery = `SELECT COUNT(*) as total FROM terms ${whereClause}`;
    const dataQuery = `SELECT * FROM terms ${whereClause} ${orderByClause} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

    // COUNT 与分页数据查询相互独立, 并行执行（各省一次串行往返）
    const dataParams = [...queryParams, pageSize, (page - 1) * pageSize];
    const [countResult, terms] = await Promise.all([
      db.queryOne(countQuery, queryParams),
      db.query(dataQuery, dataParams)
    ]);
    const total = parseInt(countResult?.total || 0, 10);

    const formatted = terms.map(term => {
      const trans = parseJsonField(term.translations);
      const transMeta = parseJsonField(term.translations_meta);

      return {
        id: term.id,
        recordId: term.id,
        sortOrder: term.sort_order,
        sort_order: term.sort_order,
        createdAt: term.created_at,
        updatedAt: term.updated_at,
        isLocked: term.is_locked || 0,
        lockedBy: term.locked_by || '',
        lockedAt: term.locked_at || '',
        status: term.status || 'DRAFT',
        rejectReason: term.reject_reason || '',
        translationsMeta: transMeta,
        fields: {
          KW: term.kw && term.kw.startsWith('__EMPTY_KW_') ? '' : term.kw,
          'CN（中文）': term.zh_cn,
          所在页面: term.context || '',
          字号类别: term.owner || '',
          ...trans
        }
      };
    });

    res.json({
      total,
      page,
      pageSize,
      records: formatted
    });
  } catch (err) {
    console.error('获取词条数据失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});


// GET /api/terms/by-kw-version - 按 KW 和版本名查找词条及其快照
router.get('/terms/by-kw-version', authenticateToken, async (req, res) => {
  const { kw, versionName, projectId } = req.query;
  if (!kw || !versionName) {
    return res.status(400).json({ error: '缺少 kw 或 versionName 参数' });
  }
  try {
    const effectiveProjectId = projectId || 'proj-default';
    // 项目成员校验: 非成员不能读取该项目词条 (管理员放行)
    if (req.user.role !== 'admin') {
      const member = await db.queryOne(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [effectiveProjectId, req.user.id]
      );
      if (!member) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '您无权访问此项目。' });
      }
    }
    const term = await db.queryOne(
      `SELECT t.id, t.kw, t.zh_cn, t.is_locked FROM terms t
       JOIN versions v ON t.version_id = v.id
       WHERE t.kw = $1 AND v.version_name = $2 AND v.project_id = $3`,
      [kw, versionName, effectiveProjectId]
    );
    if (!term) {
      return res.status(404).json({ error: '找不到对应词条，可能已被删除' });
    }
    const snapshots = await db.query(
      `SELECT s.id, s.kw, s.zh_cn, s.translations, s.created_at, s.created_by, u.username as creator_name
       FROM term_snapshots s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.term_id = $1
       ORDER BY s.created_at DESC`,
      [term.id]
    );
    const formatted = snapshots.map(s => {
      const trans = parseJsonField(s.translations);
      return {
        id: s.id, kw: s.kw, zh_cn: s.zh_cn,
        translations: trans, createdAt: s.created_at,
        creatorName: s.creator_name || '系统用户'
      };
    });
    res.json({ termId: term.id, isLocked: !!(term.is_locked === 1 || term.is_locked === true), snapshots: formatted });
  } catch (err) {
    console.error('按 KW 查找词条失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// PUT /api/terms/:termId - 带乐观锁并发校验的词条更新接口
router.put('/terms/:termId', authenticateToken, async (req, res) => {
  const { termId } = req.params;
  const { kw, context, owner, zh_cn, translations, translationsMeta, oldUpdatedAt } = req.body;
  const dbType = getDbType();

  if (!oldUpdatedAt) {
    return res.status(400).json({ error: '必须包含旧修改时间戳 (oldUpdatedAt) 以进行并发校验' });
  }

  try {
    const termMembership = await db.queryOne(
      'SELECT pm.role FROM terms t JOIN versions v ON t.version_id = v.id JOIN project_members pm ON v.project_id = pm.project_id WHERE t.id = $1 AND pm.user_id = $2',
      [termId, req.user.id]
    );
    if (termMembership && termMembership.role === 'viewer' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: '只读审核人员无权修改词条。' });
    }
    if (!(await requireTermOwnership(req.user.id, termId))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权修改此词条。' });
    }
    const term = await db.queryOne('SELECT * FROM terms WHERE id = $1', [termId]);
    if (!term) {
      return res.status(404).json({ error: '词条不存在' });
    }

    let finalKw = (kw !== undefined ? kw : term.kw).trim();
    if (!finalKw) {
      finalKw = `__EMPTY_KW_${crypto.randomUUID()}__`;
    }

    if (finalKw && !finalKw.startsWith('__EMPTY_KW_') && finalKw !== term.kw) {
      const duplicate = await db.queryOne(
        'SELECT id, zh_cn FROM terms WHERE version_id = $1 AND LOWER(kw) = LOWER($2) AND id <> $3',
        [term.version_id, finalKw, termId]
      );
      if (duplicate) {
        return res.status(409).json({
          error: 'DUPLICATE_KW',
          message: `无法保存！该 KW [${finalKw}] 已被当前表内其他词条占用 (中文: “${duplicate.zh_cn}”)。`
        });
      }
    }

    const finalContext = context !== undefined ? context : (term.context || '');
    const finalOwner = owner !== undefined ? owner : (term.owner || '');
    const finalZhCn = zh_cn !== undefined ? zh_cn : term.zh_cn;

    let updatedTrans = '';
    const inputTrans = translations !== undefined ? translations : term.translations;
    if (typeof inputTrans === 'string') {
      try {
        const parsed = JSON.parse(inputTrans);
        if (typeof parsed === 'string') {
          updatedTrans = parsed;
        } else {
          updatedTrans = inputTrans;
        }
      } catch {
        updatedTrans = '{}';
      }
    } else {
      updatedTrans = JSON.stringify(inputTrans || {});
    }

    const dbTransStr = typeof term.translations === 'string' ? term.translations : JSON.stringify(term.translations || {});
    const isTransChanged = dbTransStr !== updatedTrans;
    const isZhChanged = finalZhCn && term.zh_cn !== finalZhCn;
    const isKwChanged = finalKw !== term.kw;

    let nextStatus = 'PENDING_REVIEW';
    if (req.user.role === 'admin') {
      nextStatus = 'APPROVED';
    }

    const updateResult = await db.transaction(async (tx) => {
      if (isTransChanged || isZhChanged || isKwChanged) {
        const snapshotId = crypto.randomUUID();
        if (dbType === 'postgres') {
          await tx.run(
            `INSERT INTO term_snapshots (id, term_id, version_id, kw, zh_cn, translations, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), $7)`,
            [snapshotId, termId, term.version_id, term.kw, term.zh_cn, dbTransStr, req.user.id]
          );
        } else {
          const snapNow = new Date().toISOString();
          await tx.run(
            `INSERT INTO term_snapshots (id, term_id, version_id, kw, zh_cn, translations, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [snapshotId, termId, term.version_id, term.kw, term.zh_cn, dbTransStr, snapNow, req.user.id]
          );
        }
      }

      if (dbType === 'postgres') {
        return await tx.run(
          `UPDATE terms
           SET kw = $1, context = $2, owner = $3, zh_cn = $4, translations = $5::jsonb, translations_meta = $6::jsonb, status = $7, reject_reason = NULL, updated_at = NOW(), updated_by = $8
           WHERE id = $9 AND date_trunc('ms', updated_at) = date_trunc('ms', $10::timestamptz) AND is_locked IS NOT TRUE`,
          [finalKw, finalContext, finalOwner, finalZhCn, updatedTrans, JSON.stringify(translationsMeta || {}), nextStatus, req.user.id, termId, oldUpdatedAt]
        );
      } else {
        const nowIso = new Date().toISOString();
        return await tx.run(
          `UPDATE terms
           SET kw = $1, context = $2, owner = $3, zh_cn = $4, translations = $5, translations_meta = $6, status = $7, reject_reason = NULL, updated_at = $8, updated_by = $9
           WHERE id = $10 AND datetime(updated_at) = datetime($11) AND is_locked != 1`,
          [finalKw, finalContext, finalOwner, finalZhCn, updatedTrans, JSON.stringify(translationsMeta || {}), nextStatus, nowIso, req.user.id, termId, oldUpdatedAt]
        );
      }
    });

    const affectedRows = updateResult.changes || 0;
    if (affectedRows === 0) {
      // The UPDATE may have missed for two reasons:
      //   (a) optimistic-lock mismatch (someone else edited since this client fetched),
      //   (b) the term was locked concurrently by an admin/owner.
      // We re-read to tell them apart and return the appropriate status code so
      // the UI can show the right recovery hint.
      const fresh = await db.queryOne('SELECT is_locked FROM terms WHERE id = $1', [termId]);
      if (fresh && (fresh.is_locked === 1 || fresh.is_locked === true)) {
        return res.status(403).json({ error: 'LOCKED', message: '该词条目前已被锁定，无法修改。如需变更请联系管理员解锁！' });
      }
      return res.status(409).json({ error: 'CONCURRENCY_CONFLICT', message: '该词条已被其他人修改，请刷新后重试。' });
    }

    const newTerm = await db.queryOne('SELECT * FROM terms WHERE id = $1', [termId]);

    // 记录审计修改日志
    try {
      const ver = await db.queryOne('SELECT version_name FROM versions WHERE id = $1', [term.version_id]);
      const oldTrans = parseJsonField(term.translations);
      const newTrans = parseJsonField(newTerm.translations);
      const changedLangs = Object.keys({ ...oldTrans, ...newTrans }).filter(k => (oldTrans[k] || '') !== (newTrans[k] || ''));

      let detailsStr = '';
      if (changedLangs.length === 1) {
        const lang = changedLangs[0];
        detailsStr = JSON.stringify({
          field: lang,
          oldVal: oldTrans[lang] || '',
          newVal: newTrans[lang] || ''
        });
      } else if (changedLangs.length > 1) {
        detailsStr = `修改了 ${changedLangs.length} 个语种译文 (${changedLangs.join(', ')})`;
      } else if (isZhChanged) {
        detailsStr = `修改中文源文: [${term.zh_cn}] -> [${finalZhCn}]`;
      } else if (isKwChanged) {
        detailsStr = `修改 KW: [${term.kw}] -> [${finalKw}]`;
      } else {
        detailsStr = `修改词条属性 (页面: ${finalContext}, 负责人: ${finalOwner})`;
      }

      await createAuditLog({
        kw: finalKw,
        chinese: finalZhCn,
        action: '修改词条',
        details: detailsStr,
        versionName: ver?.version_name || '',
        userId: req.user.id
      });
    } catch (logErr) {
      console.error('[terms.put] 记录修改日志异常:', logErr);
    }

    res.json(newTerm);
  } catch (err) {
    console.error('修改词条失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// PUT /api/terms/:termId/lock - 锁定/解锁词条接口
router.put('/terms/:termId/lock', authenticateToken, async (req, res) => {
  const { termId } = req.params;
  const { isLocked } = req.body;
  const dbType = getDbType();

  try {
    const memberRoleRes = await db.queryOne(
      'SELECT pm.role FROM terms t JOIN versions v ON t.version_id = v.id JOIN project_members pm ON v.project_id = pm.project_id WHERE t.id = $1 AND pm.user_id = $2',
      [termId, req.user.id]
    );
    const projectRole = memberRoleRes ? memberRoleRes.role : null;
    if (req.user.role !== 'admin' && projectRole !== 'owner') {
      return res.status(403).json({ error: 'FORBIDDEN', message: '只有项目所有者或系统管理员可以锁定/解锁词条。' });
    }
    const term = await db.queryOne('SELECT * FROM terms WHERE id = $1', [termId]);
    if (!term) {
      return res.status(404).json({ error: '词条不存在' });
    }

    const lockValue = isLocked ? 1 : 0;

    if (dbType === 'postgres') {
      await db.run(
        `UPDATE terms SET is_locked = $1, locked_by = $2, locked_at = NOW() WHERE id = $3`,
        [lockValue, isLocked ? req.user.id : null, termId]
      );
    } else {
      await db.run(
        `UPDATE terms SET is_locked = $1, locked_by = $2, locked_at = datetime('now') WHERE id = $3`,
        [lockValue, isLocked ? req.user.id : null, termId]
      );
    }

    const actionName = isLocked ? '锁定词条' : '解锁词条';
    const ver = await db.queryOne('SELECT version_name FROM versions WHERE id = $1', [term.version_id]);
    const verName = ver ? ver.version_name : '未知版本';

    const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
    if (dbType === 'postgres') {
      await db.run(
        `INSERT INTO ${logsTable} (timestamp, kw, chinese, action, details, version_name, user_id)
         VALUES (NOW(), $1, $2, $3, $4, $5, $6)`,
        [term.kw, term.zh_cn, actionName, `${req.user.name} 对词条进行了${actionName}`, verName, req.user.id]
      );
    } else {
      await db.run(
        `INSERT INTO ${logsTable} (timestamp, kw, chinese, action, details, version_name, user_id)
         VALUES (datetime('now'), $1, $2, $3, $4, $5, $6)`,
        [term.kw, term.zh_cn, actionName, `${req.user.name} 对词条进行了${actionName}`, verName, req.user.id]
      );
    }

    res.json({ id: termId, is_locked: lockValue, message: `${actionName}成功！` });
  } catch (err) {
    console.error('切换锁定状态失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// GET /api/versions/:versionId/terms/:kw/references - 跨版本翻译参考
router.get('/versions/:versionId/terms/:kw/references', authenticateToken, async (req, res) => {
  const { versionId, kw } = req.params;

  try {
    const currentVer = await db.queryOne('SELECT project_id FROM versions WHERE id = $1', [versionId]);
    if (!currentVer) {
      return res.status(404).json({ error: '版本不存在' });
    }
    const projectId = currentVer.project_id;

    // 项目成员校验: 通过 version_id 反查 project_id 后验证成员身份 (管理员放行)
    if (req.user.role !== 'admin') {
      const member = await db.queryOne(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, req.user.id]
      );
      if (!member) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '您无权访问此项目。' });
      }
    }

    const rows = await db.query(
      `SELECT v.version_name, t.zh_cn, t.translations, t.owner, t.updated_at
       FROM terms t
       JOIN versions v ON t.version_id = v.id
       WHERE v.project_id = $1 AND t.kw = $2 AND v.id <> $3
       ORDER BY t.updated_at DESC`,
      [projectId, kw, versionId]
    );

    const results = rows.map(r => ({
      versionName: r.version_name,
      zh_cn: r.zh_cn,
      translations: typeof r.translations === 'string' ? JSON.parse(r.translations) : (r.translations || {}),
      owner: r.owner,
      updatedAt: r.updated_at
    }));

    res.json(results);
  } catch (err) {
    console.error('获取跨版本翻译参考失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// GET /api/terms/:termId/snapshots - 获取单个词条的翻译历史快照列表
router.get('/terms/:termId/snapshots', authenticateToken, async (req, res) => {
  const { termId } = req.params;
  try {
    const snapshots = await db.query(
      `SELECT s.*, u.username as creator_name 
       FROM term_snapshots s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.term_id = $1 
       ORDER BY s.created_at DESC`,
      [termId]
    );

    const formatted = snapshots.map(s => {
      let trans = {};
      try {
        trans = typeof s.translations === 'string' ? JSON.parse(s.translations) : s.translations;
      } catch { }
      return {
        id: s.id,
        termId: s.term_id,
        versionId: s.version_id,
        kw: s.kw,
        zh_cn: s.zh_cn,
        translations: trans,
        createdAt: s.created_at,
        creatorName: s.creator_name || '系统用户'
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error('获取词条快照失败:', err);
    res.status(500).json({ error: '服务器内部错误，获取历史记录失败。' });
  }
});

// POST /api/terms/:termId/rollback - 一键回退到指定快照的翻译
router.post('/terms/:termId/rollback', authenticateToken, writeLimiter, async (req, res) => {
  const { termId } = req.params;
  const { snapshotId } = req.body;
  const dbType = getDbType();

  if (!snapshotId) {
    return res.status(400).json({ error: '缺少快照ID (snapshotId)' });
  }

  try {
    if (!(await requireTermOwnership(req.user.id, termId))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权回退此词条。' });
    }
    const term = await db.queryOne('SELECT * FROM terms WHERE id = $1', [termId]);
    if (!term) {
      return res.status(404).json({ error: '词条不存在' });
    }

    if (term.is_locked === 1 || term.is_locked === true) {
      return res.status(403).json({ error: 'LOCKED', message: '此词条已被锁定，如需回退请联系管理员解锁！' });
    }

    const snapshot = await db.queryOne('SELECT * FROM term_snapshots WHERE id = $1 AND term_id = $2', [snapshotId, termId]);
    if (!snapshot) {
      return res.status(404).json({ error: '找不到指定的词条历史快照' });
    }

    const newSnapshotId = crypto.randomUUID();
    const currentTransStr = typeof term.translations === 'string' ? term.translations : JSON.stringify(term.translations || {});

    await db.transaction(async (tx) => {
      if (dbType === 'postgres') {
        await tx.run(
          `INSERT INTO term_snapshots (id, term_id, version_id, kw, zh_cn, translations, created_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), $7)`,
          [newSnapshotId, termId, term.version_id, term.kw, term.zh_cn, currentTransStr, req.user.id]
        );
      } else {
        await tx.run(
          `INSERT INTO term_snapshots (id, term_id, version_id, kw, zh_cn, translations, created_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, datetime('now'), $7)`,
          [newSnapshotId, termId, term.version_id, term.kw, term.zh_cn, currentTransStr, req.user.id]
        );
      }

      let nextStatus = 'PENDING_REVIEW';
      if (req.user.role === 'admin') {
        nextStatus = 'APPROVED';
      }

      const snapTransStr = typeof snapshot.translations === 'string' ? snapshot.translations : JSON.stringify(snapshot.translations || {});

      if (dbType === 'postgres') {
        await tx.run(
          `UPDATE terms 
           SET kw = $1, zh_cn = $2, translations = $3::jsonb, status = $4, reject_reason = NULL, updated_at = NOW(), updated_by = $5
           WHERE id = $6`,
          [snapshot.kw, snapshot.zh_cn, snapTransStr, nextStatus, req.user.id, termId]
        );
      } else {
        await tx.run(
          `UPDATE terms 
           SET kw = $1, zh_cn = $2, translations = $3, status = $4, reject_reason = NULL, updated_at = datetime('now'), updated_by = $5
           WHERE id = $6`,
          [snapshot.kw, snapshot.zh_cn, snapTransStr, nextStatus, req.user.id, termId]
        );
      }

      const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
      const versionObj = await tx.queryOne('SELECT version_name FROM versions WHERE id = $1', [term.version_id]);
      const details = `将词条 [${term.kw}] 的内容回退到了 [${snapshot.created_at}] 的历史版本。`;

      if (dbType === 'postgres') {
        await tx.run(
          `INSERT INTO ${logsTable} (timestamp, kw, chinese, action, details, version_name, user_id)
           VALUES (NOW(), $1, $2, '历史回退', $3, $4, $5)`,
          [snapshot.kw, snapshot.zh_cn, details, versionObj ? versionObj.version_name : '', req.user.id]
        );
      } else {
        await tx.run(
          `INSERT INTO ${logsTable} (timestamp, kw, chinese, action, details, version_name, user_id)
           VALUES (datetime('now'), $1, $2, '历史回退', $3, $4, $5)`,
          [snapshot.kw, snapshot.zh_cn, details, versionObj ? versionObj.version_name : '', req.user.id]
        );
      }
    });

    res.json({ message: '成功回退到指定历史快照！', kw: snapshot.kw });
  } catch (err) {
    console.error('词条快照回退失败:', err);
    res.status(500).json({ error: '服务器内部错误，回退操作失败。' });
  }
});

// POST /api/terms/batch-update - 批量设置词条分类字段
router.post('/terms/batch-update', authenticateToken, async (req, res) => {
  const { termIds, updates } = req.body;
  const dbType = getDbType();

  if (!Array.isArray(termIds) || termIds.length === 0 || !updates) {
    return res.status(400).json({ error: '必须包含 termIds 数组和 updates 更新对象' });
  }

  try {
    if (!(await requireAllTermsOwnership(req.user.id, termIds, req.user.role))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权修改此项目的词条。' });
    }
    let successCount = 0;
    let lockedCount = 0;

    await db.transaction(async (tx) => {
      const placeholders = termIds.map((_, i) => `$${i + 1}`).join(',');
      const terms = await tx.query(`SELECT id, is_locked, kw, zh_cn, version_id FROM terms WHERE id IN (${placeholders})`, termIds);

      const validTerms = terms.filter(t => {
        if (t.is_locked === 1 || t.is_locked === true) {
          lockedCount++;
          return false;
        }
        return true;
      });

      if (validTerms.length === 0) {
        return;
      }

      const updatesNormalized = {};
      if (updates.context !== undefined) {
        updatesNormalized.context = updates.context;
      } else if (updates['所在页面'] !== undefined) {
        updatesNormalized.context = updates['所在页面'];
      }

      if (updates.owner !== undefined) {
        updatesNormalized.owner = updates.owner;
      } else if (updates['字号类别'] !== undefined) {
        updatesNormalized.owner = updates['字号类别'];
      }

      const updateFields = [];
      const updateParams = [];
      let idx = 1;

      if (updatesNormalized.context !== undefined) {
        updateFields.push(`context = $${idx++}`);
        updateParams.push(updatesNormalized.context);
      }
      if (updatesNormalized.owner !== undefined) {
        updateFields.push(`owner = $${idx++}`);
        updateParams.push(updatesNormalized.owner);
      }

      if (updateFields.length === 0) return;

      const baseQuery = dbType === 'postgres'
        ? `UPDATE terms SET ${updateFields.join(', ')}, updated_at = NOW(), updated_by = $${idx}`
        : `UPDATE terms SET ${updateFields.join(', ')}, updated_at = datetime('now'), updated_by = $${idx}`;

      updateParams.push(req.user.id);

      // 各行更新的字段集合完全一致, 合并为单条 UPDATE ... WHERE id IN (...)。
      // 原逐条循环的 UPDATE 不带 updated_at 乐观锁条件, 合并不改变并发语义。
      const validIds = validTerms.map(t => t.id);
      const idPlaceholders = validIds.map((_, i) => `$${idx + 1 + i}`).join(',');
      await tx.run(`${baseQuery} WHERE id IN (${idPlaceholders})`, [...updateParams, ...validIds]);
      successCount = validIds.length;

      if (successCount > 0) {
        const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
        const ver = await tx.queryOne('SELECT version_name FROM versions WHERE id = $1', [validTerms[0].version_id]);
        const verName = ver ? ver.version_name : '未知版本';
        const detailMsg = `批量更新了 ${successCount} 条词条的分类字段 (${Object.keys(updates).join(', ')})。跳过锁定条数: ${lockedCount}。`;

        if (dbType === 'postgres') {
          await tx.run(
            `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
             VALUES (NOW(), '批量修改', $1, $2, $3)`,
            [detailMsg, verName, req.user.id]
          );
        } else {
          await tx.run(
            `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
             VALUES (datetime('now'), '批量修改', $1, $2, $3)`,
            [detailMsg, verName, req.user.id]
          );
        }
      }
    });

    res.json({
      message: `成功批量更新分类字段！已更新: ${successCount} 条，跳过锁定: ${lockedCount} 条。`,
      successCount,
      lockedCount
    });
  } catch (err) {
    console.error('批量修改分类字段失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// POST /api/terms/batch-clear-translations - 批量清空词条翻译 (保留中文, 删除其他所有语种翻译)
router.post('/terms/batch-clear-translations', authenticateToken, writeLimiter, async (req, res) => {
  const { termIds } = req.body;
  const dbType = getDbType();

  if (!Array.isArray(termIds) || termIds.length === 0) {
    return res.status(400).json({ error: '必须包含 termIds 数组' });
  }

  try {
    if (!(await requireAllTermsOwnership(req.user.id, termIds, req.user.role))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权修改此项目的词条。' });
    }

    let successCount = 0;
    let lockedCount = 0;

    await db.transaction(async (tx) => {
      const placeholders = termIds.map((_, i) => `$${i + 1}`).join(',');
      const terms = await tx.query(`SELECT id, is_locked, kw, zh_cn, version_id FROM terms WHERE id IN (${placeholders})`, termIds);

      const validTerms = terms.filter(t => {
        if (t.is_locked === 1 || t.is_locked === true) {
          lockedCount++;
          return false;
        }
        return true;
      });

      if (validTerms.length === 0) {
        return;
      }

      const validIds = validTerms.map(t => t.id);
      const idPlaceholders = validIds.map((_, i) => `$${i + 2}`).join(',');

      if (dbType === 'postgres') {
        await tx.run(
          `UPDATE terms 
           SET translations = '{}'::jsonb, translations_meta = '{}'::jsonb, updated_at = NOW(), updated_by = $1 
           WHERE id IN (${idPlaceholders})`,
          [req.user.id, ...validIds]
        );
      } else {
        await tx.run(
          `UPDATE terms 
           SET translations = '{}', translations_meta = '{}', updated_at = datetime('now'), updated_by = $1 
           WHERE id IN (${idPlaceholders})`,
          [req.user.id, ...validIds]
        );
      }

      successCount = validIds.length;

      if (successCount > 0) {
        const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
        const ver = await tx.queryOne('SELECT version_name FROM versions WHERE id = $1', [validTerms[0].version_id]);
        const verName = ver ? ver.version_name : '未知版本';
        const detailMsg = `批量清空了 ${successCount} 条词条的全部目标语言翻译（保留中文）。跳过锁定条数: ${lockedCount}。`;

        if (dbType === 'postgres') {
          await tx.run(
            `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
             VALUES (NOW(), '清空翻译', $1, $2, $3)`,
            [detailMsg, verName, req.user.id]
          );
        } else {
          await tx.run(
            `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
             VALUES (datetime('now'), '清空翻译', $1, $2, $3)`,
            [detailMsg, verName, req.user.id]
          );
        }
      }
    });

    res.json({
      message: `成功清空 ${successCount} 条词条的翻译（保留中文）！${lockedCount > 0 ? `已自动跳过 ${lockedCount} 条锁定词条。` : ''}`,
      successCount,
      lockedCount
    });
  } catch (err) {
    console.error('批量清空翻译失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// POST /api/terms/batch-delete - 批量软删除词条 (走回收站, 30 天可恢复)
//
// 行为:
//   1. 验证 termIds 全部存在且属于同一项目
//   2. 跳过已锁定的词条 (lockedSkipped 计数)
//   3. 每个成功删除的词条写入 recycle_bin (含完整 term + snapshots)
//   4. 在事务中硬删 terms 行
//   5. 写一条 '批量删除' 审计日志
// Owner / Editor 角色可调; Viewer 拒绝 (权限继承自 batch-update 的 requireTermOwnership)
router.post('/terms/batch-delete', authenticateToken, writeLimiter, async (req, res) => {
  const { termIds } = req.body;
  const dbType = getDbType();

  if (!Array.isArray(termIds) || termIds.length === 0) {
    return res.status(400).json({ error: '必须包含 termIds 数组' });
  }

  // 防止误操作: 限制单次最多 200 条
  if (termIds.length > 200) {
    return res.status(400).json({ error: '单次最多删除 200 条, 请分批操作' });
  }

  try {
    // RBAC: 对全部 termIds 做归属校验 (任一不属于即拒绝), 管理员放行
    if (!(await requireAllTermsOwnership(req.user.id, termIds, req.user.role))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权删除此项目的词条。' });
    }

    const placeholders = termIds.map((_, i) => `$${i + 1}`).join(',');
    const terms = await db.query(
      `SELECT id, kw, zh_cn, is_locked FROM terms WHERE id IN (${placeholders})`,
      termIds
    );

    const skippedLockedIds = [];
    const toDelete = [];
    for (const t of terms) {
      if (t.is_locked === 1 || t.is_locked === true) {
        skippedLockedIds.push(t.id);
        continue;
      }
      toDelete.push(t);
    }

    let deletedCount = 0;
    let deletedKwList = [];

    if (toDelete.length > 0) {
      // 原子批量删除: 读取完整数据 → 单条多行 INSERT 备份 → 批量硬删，全部在
      // 同一事务内。旧实现逐条「备份+删除」且在事务外（~4 次往返/条，最多
      // 1600 次查询），部分失败会留下"已备份未删除"的混合状态。
      deletedCount = await db.transaction(async (tx) => {
        const delIds = toDelete.map(t => t.id);
        const delPlaceholders = delIds.map((_, i) => `$${i + 1}`).join(',');
        const fullTerms = await tx.query(
          `SELECT * FROM terms WHERE id IN (${delPlaceholders})`,
          delIds
        );
        const snapshots = await tx.query(
          `SELECT * FROM term_snapshots WHERE term_id IN (${delPlaceholders})`,
          delIds
        );

        const snapshotMap = new Map();
        for (const s of snapshots) {
          if (!snapshotMap.has(s.term_id)) snapshotMap.set(s.term_id, []);
          snapshotMap.get(s.term_id).push(s);
        }

        const backupRows = fullTerms.map(term => ({
          id: crypto.randomUUID(),
          entityType: 'term',
          entityName: term.zh_cn || term.kw || term.id,
          payloadJson: JSON.stringify({
            term,
            snapshots: snapshotMap.get(term.id) || []
          })
        }));
        await bulkInsertToRecycleBin(tx, backupRows, req.user.id);

        // 硬删词条（term_snapshots 由外键 ON DELETE CASCADE 级联删除）
        await tx.run(`DELETE FROM terms WHERE id IN (${delPlaceholders})`, delIds);

        deletedKwList = fullTerms.map(t => t.kw);
        const details = `批量软删除 ${fullTerms.length} 条词条 (已送入回收站, 30 天后清理): ${deletedKwList.slice(0, 10).join(', ')}${deletedKwList.length > 10 ? ` ... 等 ${deletedKwList.length} 条` : ''}`;
        const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
        const tsFunc = dbType === 'postgres' ? 'NOW()' : "datetime('now')";
        await tx.run(
          `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
           VALUES (${tsFunc}, '批量删除', $1, $2, $3)`,
          [details, '', req.user.id]
        );
        return fullTerms.length;
      });
    }

    res.json({
      message: `成功删除 ${deletedCount} 条词条 (送入回收站, 30 天内可恢复)`,
      deletedCount,
      lockedSkipped: skippedLockedIds.length,
      skippedLockedIds,
    });
  } catch (err) {
    console.error('批量删除词条失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// POST /api/terms/batch-copy - 批量复制词条到其他版本
router.post('/terms/batch-copy', authenticateToken, async (req, res) => {
  const { termIds, targetVersionId, duplicateStrategy } = req.body;
  const dbType = getDbType();

  if (!Array.isArray(termIds) || termIds.length === 0 || !targetVersionId || !duplicateStrategy) {
    return res.status(400).json({ error: '必须包含 termIds 数组、targetVersionId 和 duplicateStrategy 策略' });
  }

  const validStrategies = ['overwrite', 'skip'];
  if (!validStrategies.includes(duplicateStrategy)) {
    return res.status(400).json({ error: 'INVALID_STRATEGY', message: '无效的复制策略。' });
  }

  try {
    // RBAC: 源词条必须全部属于用户所在项目 (任一不属于即拒绝), 管理员放行
    if (!(await requireAllTermsOwnership(req.user.id, termIds, req.user.role))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权复制这些词条。' });
    }

    const targetVer = await db.queryOne('SELECT version_name, project_id FROM versions WHERE id = $1', [targetVersionId]);
    if (!targetVer) {
      return res.status(404).json({ error: '目标版本不存在' });
    }

    // RBAC: 目标版本归属项目必须是用户所在项目且非只读角色, 管理员放行
    if (req.user.role !== 'admin') {
      const targetMember = await db.queryOne(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [targetVer.project_id, req.user.id]
      );
      if (!targetMember || targetMember.role === 'viewer') {
        return res.status(403).json({ error: 'FORBIDDEN', message: '只读审核人员无权向该目标版本写入词条。' });
      }
    }

    let copyCount = 0;
    let skipCount = 0;
    let overwriteCount = 0;

    await db.transaction(async (tx) => {
      const placeholders = termIds.map((_, i) => `$${i + 1}`).join(',');
      const sourceTerms = await tx.query(
        `SELECT kw, context, owner, zh_cn, translations, translations_meta FROM terms WHERE id IN (${placeholders})`,
        termIds
      );

      const existingTerms = await tx.query(
        'SELECT id, kw, is_locked, translations, sort_order FROM terms WHERE version_id = $1',
        [targetVersionId]
      );

      const maxSortRow = await tx.queryOne(
        'SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM terms WHERE version_id = $1',
        [targetVersionId]
      );
      let currentSortOrder = parseInt(maxSortRow?.max_sort || 0, 10);

      const existingMap = {};
      existingTerms.forEach(t => {
        existingMap[t.kw] = t;
      });

      // 先在内存中完成全部判定, 再用批量语句写入:
      // 旧实现逐条 DELETE+INSERT（每条 1-2 次往返）, 大批量复制时事务内往返次数线性膨胀。
      const toInsert = [];
      const toDeleteIds = [];

      for (const term of sourceTerms) {
        const exist = existingMap[term.kw];
        const newId = crypto.randomUUID();

        let transStr = JSON.stringify(parseJsonField(term.translations));
        let metaStr = JSON.stringify(parseJsonField(term.translations_meta));

        if (exist) {
          if (duplicateStrategy === 'skip') {
            skipCount++;
            continue;
          } else if (duplicateStrategy === 'overwrite') {
            if (exist.is_locked === 1 || exist.is_locked === true) {
              skipCount++;
              continue;
            }

            const targetSortOrder = exist.sort_order && exist.sort_order > 0 ? exist.sort_order : ++currentSortOrder;

            toDeleteIds.push(exist.id);
            toInsert.push({ id: newId, term, transStr, metaStr, sortOrder: targetSortOrder });
            overwriteCount++;
          }
        } else {
          currentSortOrder++;
          toInsert.push({ id: newId, term, transStr, metaStr, sortOrder: currentSortOrder });
          copyCount++;
        }
      }

      // 分块批量 DELETE（500 id/块）
      for (let i = 0; i < toDeleteIds.length; i += 500) {
        const chunk = toDeleteIds.slice(i, i + 500);
        const delPh = chunk.map((_, j) => `$${j + 1}`).join(',');
        await tx.run(`DELETE FROM terms WHERE id IN (${delPh})`, chunk);
      }

      // 分块多行 VALUES 批量 INSERT（500 行/块 ≈ 4500 参数, 远低于 SQLite 32766 上限）
      for (let i = 0; i < toInsert.length; i += 500) {
        const chunk = toInsert.slice(i, i + 500);
        const valuesClauses = [];
        const params = [];
        chunk.forEach((row, j) => {
          const b = j * 9;
          const transPh = dbType === 'postgres' ? `$${b + 7}::jsonb` : `$${b + 7}`;
          const metaPh = dbType === 'postgres' ? `$${b + 8}::jsonb` : `$${b + 8}`;
          const tsCols = dbType === 'postgres' ? 'NOW(), NOW(), FALSE' : "datetime('now'), datetime('now'), 0";
          valuesClauses.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, ${transPh}, ${metaPh}, ${tsCols}, $${b + 9}, 'DRAFT')`);
          params.push(row.id, targetVersionId, row.term.kw, row.term.context, row.term.owner, row.term.zh_cn, row.transStr, row.metaStr, row.sortOrder);
        });
        await tx.run(
          `INSERT INTO terms (id, version_id, kw, context, owner, zh_cn, translations, translations_meta, created_at, updated_at, is_locked, sort_order, status)
           VALUES ${valuesClauses.join(', ')}`,
          params
        );
      }

      const totalMoved = copyCount + overwriteCount;
      if (totalMoved > 0 || skipCount > 0) {
        const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
        const details = `批量从其他版本复制词条到 [${targetVer.version_name}]。成功复制新增: ${copyCount} 条，覆盖已有: ${overwriteCount} 条，跳过（重复/锁定）: ${skipCount} 条。`;

        if (dbType === 'postgres') {
          await tx.run(
            `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
             VALUES (NOW(), '批量复制', $1, $2, $3)`,
            [details, targetVer.version_name, req.user.id]
          );
        } else {
          await tx.run(
            `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
             VALUES (datetime('now'), '批量复制', $1, $2, $3)`,
            [details, targetVer.version_name, req.user.id]
          );
        }
      }
    });

    res.json({
      message: `成功复制词条到版本 [${targetVer.version_name}]！`,
      addedCount: copyCount,
      overwrittenCount: overwriteCount,
      skippedCount: skipCount
    });
  } catch (err) {
    console.error('批量复制到其他版本失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// POST /api/tables/:tableId/batch-generate-kw - 批量生成并更新词条 KW
router.post('/tables/:tableId/batch-generate-kw', authenticateToken, async (req, res) => {
  const { tableId } = req.params;
  const { termIds, overwrite = false, updates = [] } = req.body;
  const dbType = getDbType();

  try {
    const version = await db.queryOne('SELECT id, version_name, project_id FROM versions WHERE id = $1', [tableId]);
    if (!version) {
      return res.status(404).json({ error: '数据表版本不存在' });
    }

    const projectId = version.project_id || 'proj-default';
    // RBAC: 检查用户在版本归属项目中的写权限 (管理员放行)
    if (req.user.role !== 'admin') {
      const member = await db.queryOne(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, req.user.id]
      );
      if (!member || member.role === 'viewer') {
        return res.status(403).json({ error: 'FORBIDDEN', message: '只读审核人员无权修改或生成 KW。' });
      }
    }
    let updatedCount = 0;
    let skippedCount = 0;
    let conflictCount = 0;
    const modifiedTerms = [];

    // ---- 阶段一（事务外）: 收集/生成 KW 计划 ----
    // generateKwHelper 走外部 Dify HTTP（单条最坏 ~30s），绝不能放进数据库事务，
    // 否则长事务占住连接池（max 10），几个并发批次即可拖垮全部请求。
    // 本阶段只产出 plannedUpdates: [{ id, kw, oldKw, zh_cn }]，写入放到阶段二短事务。
    const plannedUpdates = [];

    if (Array.isArray(updates) && updates.length > 0) {
      // 前端已提供批量生成后的 updates 映射列表: [{ id, kw }]
      for (const item of updates) {
        if (!item.id || !item.kw) continue;
        plannedUpdates.push({ id: item.id, kw: String(item.kw).trim(), oldKw: null, zh_cn: null });
      }
    } else {
      // 后端直接查询候选词条并执行生成
      let candidates = [];
      if (Array.isArray(termIds) && termIds.length > 0) {
        const placeholders = termIds.map((_, i) => `$${i + 2}`).join(',');
        candidates = await db.query(
          `SELECT id, kw, zh_cn, translations, context, is_locked FROM terms WHERE version_id = $1 AND id IN (${placeholders})`,
          [tableId, ...termIds]
        );
      } else {
        // 全表扫描
        candidates = await db.query(
          'SELECT id, kw, zh_cn, translations, context, is_locked FROM terms WHERE version_id = $1',
          [tableId]
        );
      }

      const generationTargets = [];
      for (const term of candidates) {
        if (term.is_locked === 1 || term.is_locked === true) {
          skippedCount++;
          continue;
        }
        const isKwEmpty = !term.kw || !term.kw.trim() || term.kw.startsWith('__EMPTY_KW_');
        if (!isKwEmpty && !overwrite) {
          skippedCount++;
          continue;
        }
        generationTargets.push(term);
      }

      // 受控并发（3 个 worker）调用外部 Dify，避免全表串行拖长总耗时
      const GENERATE_CONCURRENCY = 3;
      let cursor = 0;
      const worker = async () => {
        while (cursor < generationTargets.length) {
          const term = generationTargets[cursor++];
          let enText = '';
          if (term.translations) {
            const parsed = parseJsonField(term.translations);
            enText = parsed['EN（英文）'] || parsed['EN'] || parsed['en'] || '';
          }
          try {
            const generatedKw = await generateKwHelper(projectId, term.zh_cn, enText, term.context);
            if (generatedKw) {
              plannedUpdates.push({ id: term.id, kw: generatedKw, oldKw: (term.kw || '').trim() || null, zh_cn: term.zh_cn });
            } else {
              skippedCount++;
            }
          } catch (genErr) {
            console.error(`[batch-generate-kw] 单条生成失败 termId=${term.id}:`, genErr.message);
            skippedCount++;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(GENERATE_CONCURRENCY, generationTargets.length)) }, worker)
      );
    }

    // ---- 阶段二（短事务）: 基于数据库最新状态判定冲突并写入 ----
    // 唯一约束仍是最终裁决: 条件 UPDATE 自带 NOT EXISTS 防护，万一竞态击穿会抛 23505，
    // 事务整体回滚（无部分写入），由路由层转为 409 提示重试。
    if (plannedUpdates.length > 0) {
      await db.transaction(async (tx) => {
        // 事务内重新读取本版本已占用 KW（最新状态），避免阶段一期间的并发变化
        const occupiedRows = await tx.query('SELECT id, kw FROM terms WHERE version_id = $1', [tableId]);
        const kwHolder = new Map();
        for (const r of occupiedRows) {
          const k = (r.kw || '').trim();
          if (k && !k.startsWith('__EMPTY_KW_')) kwHolder.set(k, r.id);
        }
        const batchUsed = new Map();

        // 尝试为本行占用一个 KW；批次内重复或已被其他词条占用时返回 false
        const tryReserveKw = (kw, termId) => {
          if (!kw) return false;
          if (batchUsed.has(kw) && batchUsed.get(kw) !== termId) return false;
          const holder = kwHolder.get(kw);
          if (holder && holder !== termId) return false;
          batchUsed.set(kw, termId);
          return true;
        };

        // 条件更新: 目标 KW 仍被其他词条占用时不写入（rowCount=0 → 冲突）
        const condUpdate = dbType === 'postgres'
          ? `UPDATE terms SET kw = $1, updated_at = NOW()
             WHERE id = $2 AND version_id = $3
               AND NOT EXISTS (SELECT 1 FROM terms t2 WHERE t2.version_id = $3 AND t2.kw = $1 AND t2.id <> $2)`
          : `UPDATE terms SET kw = $1, updated_at = datetime('now')
             WHERE id = $2 AND version_id = $3
               AND NOT EXISTS (SELECT 1 FROM terms t2 WHERE t2.version_id = $3 AND t2.kw = $1 AND t2.id <> $2)`;

        for (const item of plannedUpdates) {
          if (!item.kw) {
            skippedCount++;
            continue;
          }
          if (!tryReserveKw(item.kw, item.id)) {
            conflictCount++;
            skippedCount++;
            continue;
          }
          const result = await tx.run(condUpdate, [item.kw, item.id, tableId]);
          if (result.changes === 0) {
            // 数据库层判定冲突（阶段一之后该 KW 又被占用）
            batchUsed.delete(item.kw);
            conflictCount++;
            skippedCount++;
            continue;
          }
          // 覆盖写时释放本行旧 KW 占用，避免其干扰同批次后续条目的冲突判定
          if (item.oldKw && item.oldKw !== item.kw && kwHolder.get(item.oldKw) === item.id) {
            kwHolder.delete(item.oldKw);
          }
          updatedCount++;
          modifiedTerms.push(item.zh_cn ? { id: item.id, kw: item.kw, zh_cn: item.zh_cn } : { id: item.id, kw: item.kw });
        }

        if (updatedCount > 0) {
          const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
          const details = `批量自动生成 KW 键名：成功更新 ${updatedCount} 条词条${skippedCount > 0 ? `，跳过 ${skippedCount} 条` : ''}。`;

          if (dbType === 'postgres') {
            await tx.run(
              `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
               VALUES (NOW(), '批量生成KW', $1, $2, $3)`,
              [details, version.version_name, req.user.id]
            );
          } else {
            await tx.run(
              `INSERT INTO ${logsTable} (timestamp, action, details, version_name, user_id)
               VALUES (datetime('now'), '批量生成KW', $1, $2, $3)`,
              [details, version.version_name, req.user.id]
            );
          }
        }
      });
    }

    res.json({
      message: `成功为 ${updatedCount} 条词条生成并更新 KW 键名！${conflictCount > 0 ? `（${conflictCount} 条因 KW 重复已跳过）` : ''}`,
      updatedCount,
      skippedCount,
      conflictCount,
      modifiedTerms
    });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'KW_CONFLICT', message: '存在并发 KW 冲突（其他用户同时写入了相同 KW），请重试。' });
    }
    console.error('批量生成 KW 失败:', err);
    res.status(500).json({ error: '批量生成 KW 失败: ' + err.message });
  }
});

// POST /api/terms/batch-approve - 批量审核词条工作流 API
router.post('/terms/batch-approve', authenticateToken, async (req, res) => {
  const { termIds, status, rejectReason } = req.body;
  const dbType = getDbType();

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN', message: '只有管理员有权审核词条！' });
  }

  if (Array.isArray(termIds) && termIds.length > 0 && !(await requireAllTermsOwnership(req.user.id, termIds, req.user.role))) {
    return res.status(403).json({ error: 'FORBIDDEN', message: '您无权审核此项目的词条。' });
  }

  if (!Array.isArray(termIds) || termIds.length === 0 || !status) {
    return res.status(400).json({ error: '必须包含有效的 termIds 数组和目标审核 status 字段！' });
  }

  const validStatuses = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '非法审核状态！' });
  }

  try {
    await db.transaction(async (tx) => {
      const selectPlaceholders = termIds.map((_, i) => `$${i + 1}`).join(',');
      const candidates = await tx.query(
        `SELECT id, is_locked, kw, zh_cn, version_id FROM terms WHERE id IN (${selectPlaceholders})`,
        termIds
      );

      const validTerms = candidates.filter(t => !(t.is_locked === 1 || t.is_locked === true));

      if (validTerms.length === 0) {
        return;
      }

      const validIds = validTerms.map(t => t.id);
      const reason = status === 'REJECTED' ? (rejectReason || '未填写具体原因') : null;

      const updatePlaceholders = validIds.map((_, i) => `$${i + 4}`).join(',');
      const updateSql = dbType === 'postgres'
        ? `UPDATE terms SET status = $1, reject_reason = $2, updated_at = NOW(), updated_by = $3 WHERE id IN (${updatePlaceholders})`
        : `UPDATE terms SET status = $1, reject_reason = $2, updated_at = datetime('now'), updated_by = $3 WHERE id IN (${updatePlaceholders})`;
      await tx.run(updateSql, [status, reason, req.user.id, ...validIds]);

      const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
      const logPlaceholders = validIds.map((_, i) => `$${i + 4}`).join(',');
      const timestampExpr = dbType === 'postgres' ? 'NOW()' : "datetime('now')";
      const detailsPrefix = '审核词条 [';
      const detailsSuffix = `]，结果: [${status}]${status === 'REJECTED' ? `，原因: ${reason}` : ''}`;

      const logSql = `INSERT INTO ${logsTable} (timestamp, kw, chinese, action, details, version_name, user_id)
           SELECT ${timestampExpr}, t.kw, t.zh_cn, '内容审核', $1 || t.kw || $2, COALESCE(v.version_name, ''), $3
           FROM terms t LEFT JOIN versions v ON t.version_id = v.id
           WHERE t.id IN (${logPlaceholders})`;
      await tx.run(logSql, [detailsPrefix, detailsSuffix, req.user.id, ...validIds]);
    });

    res.json({ message: `批量操作成功！已将选中词条设置为 [${status}] 状态。` });
  } catch (err) {
    console.error('批量审核词条失败:', err);
    res.status(500).json({ error: '服务器内部错误，批量审核失败。' });
  }
});


// POST /api/tables/:tableId/sync - Bulk Insert/Update/Delete records for a version
router.post('/tables/:tableId/sync', authenticateToken, writeLimiter, async (req, res) => {
  const { tableId } = req.params;
  const { added = [], updated = [], deletedIds = [], reorder = [] } = req.body;

  try {
    const dbType = getDbType();

    if (!(await requireVersionOwnership(req.user.id, tableId))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权修改此数据表。' });
    }

    if (req.user.role !== 'admin') {
      const verMembership = await db.queryOne(
        'SELECT pm.role FROM versions v JOIN project_members pm ON v.project_id = pm.project_id WHERE v.id = $1 AND pm.user_id = $2',
        [tableId, req.user.id]
      );
      if (!verMembership || verMembership.role === 'viewer') {
        return res.status(403).json({ error: 'FORBIDDEN', message: '只读审核人员无权修改此数据表。' });
      }
    }

    let successCount = 0;

    await db.transaction(async (tx) => {
      // 1. Delete
      if (deletedIds.length > 0) {
        const placeholders = deletedIds.map((_, i) => `$${i + 1}`).join(',');
        await tx.query(`DELETE FROM terms WHERE id IN (${placeholders}) AND version_id = $${deletedIds.length + 1} AND (is_locked IS NOT TRUE)`, [...deletedIds, tableId]);
      }

      // 2. Insert (Added) — JS 侧先完成字段归一/排序号分配, 再分块多行 upsert
      // (旧实现逐条 INSERT, 每条一次数据库往返; CSV 大导入时事务内往返线性膨胀)
      const maxSortRow = await tx.queryOne(
        'SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM terms WHERE version_id = $1',
        [tableId]
      );
      let nextSortOrder = parseInt(maxSortRow?.max_sort || 0, 10);

      const addedRows = [];
      for (const rec of added) {
        let kwVal = (rec.fields['KW'] || rec.kw || '').trim();
        if (!kwVal) {
          kwVal = `__EMPTY_KW_${crypto.randomUUID()}__`;
        }
        const zhCnVal = (rec.fields['CN（中文）'] || rec.zh_cn || '').trim();
        const contextVal = (rec.fields['所在页面'] || rec.context || '').trim();

        const systemKeys = ['KW', 'CN（中文）', '所在页面', '字号类别'];
        let translationsObj = rec.translations;
        if (!translationsObj || typeof translationsObj !== 'object') {
          translationsObj = {};
          Object.keys(rec.fields || {}).forEach(k => {
            if (!systemKeys.includes(k) && rec.fields[k] !== undefined) {
              translationsObj[k] = rec.fields[k];
            }
          });
        }

        const fieldsStr = JSON.stringify(translationsObj);
        const translationsMetaStr = JSON.stringify(rec.translationsMeta || {});
        const nowStr = new Date().toISOString();

        const lockedFalseVal = dbType === 'postgres' ? false : 0;

        // Auto-assign sort_order: use provided value, or take the next in-memory value
        let sortOrder = rec.sortOrder;
        if (sortOrder === undefined || sortOrder === null) {
          sortOrder = nextSortOrder + 1;
        }
        // 显式传入的 sortOrder 可能高于当前基数, 同步抬升基数避免后续自增与其冲突
        nextSortOrder = Math.max(nextSortOrder, sortOrder);

        addedRows.push([
          rec.recordId,
          tableId,
          kwVal,
          contextVal,
          zhCnVal,
          fieldsStr,
          translationsMetaStr,
          lockedFalseVal,
          'DRAFT',
          sortOrder,
          nowStr,
          nowStr
        ]);
        successCount++;
      }

      // 同批内 (version_id, kw) 冲突预去重: PG 的多行 upsert 不允许一条语句内
      // 两次命中同一冲突行, 保留后出现的记录与逐条 upsert 的覆盖语义一致
      const seenKw = new Map();
      for (const row of addedRows) {
        seenKw.set(row[2], row);
      }
      const dedupedAdded = [...seenKw.values()];

      const UPSERT_CHUNK = 250; // 每行 12 参数, 250 行 = 3000 参数, 远低于 SQLite 上限
      for (let i = 0; i < dedupedAdded.length; i += UPSERT_CHUNK) {
        const chunk = dedupedAdded.slice(i, i + UPSERT_CHUNK);
        const valuesClauses = [];
        const params = [];
        chunk.forEach((row, j) => {
          const b = j * 12;
          valuesClauses.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12})`);
          params.push(...row);
        });
        await tx.query(`
          INSERT INTO terms (id, version_id, kw, context, zh_cn, translations, translations_meta, is_locked, status, sort_order, created_at, updated_at)
          VALUES ${valuesClauses.join(', ')}
          ON CONFLICT (version_id, kw) DO UPDATE SET
            context = EXCLUDED.context,
            zh_cn = EXCLUDED.zh_cn,
            translations = EXCLUDED.translations,
            translations_meta = EXCLUDED.translations_meta,
            sort_order = EXCLUDED.sort_order,
            updated_at = EXCLUDED.updated_at
        `, params);
      }

      // 3. Update (Modified) — 批量预读现有值后合并, 仍逐条 UPDATE 以保留
      // 每行可选的 sort_order 更新与 is_locked 过滤语义
      const updateIds = updated.map(r => r.recordId).filter(Boolean);
      const existingMap = new Map();
      if (updateIds.length > 0) {
        const updatePh = updateIds.map((_, i) => `$${i + 1}`).join(',');
        const existingRows = await tx.query(
          `SELECT id, kw, zh_cn, context, translations, translations_meta FROM terms WHERE id IN (${updatePh})`,
          updateIds
        );
        existingRows.forEach(r => existingMap.set(r.id, r));
      }

      for (const rec of updated) {
        const existing = existingMap.get(rec.recordId) || null;
        
        let kwVal = rec.fields && rec.fields['KW'] !== undefined 
          ? rec.fields['KW'].trim() 
          : (rec.kw !== undefined ? rec.kw.trim() : (existing ? existing.kw : ''));

        if (!kwVal) {
          if (existing && existing.kw && existing.kw.startsWith('__EMPTY_KW_')) {
            kwVal = existing.kw;
          } else {
            kwVal = `__EMPTY_KW_${crypto.randomUUID()}__`;
          }
        }

        const zhCnVal = rec.fields && rec.fields['CN（中文）'] !== undefined 
          ? rec.fields['CN（中文）'].trim() 
          : (existing ? existing.zh_cn : '');

        const contextVal = rec.fields && rec.fields['所在页面'] !== undefined 
          ? rec.fields['所在页面'].trim() 
          : (existing ? existing.context || '' : '');

        const systemKeys = ['KW', 'CN（中文）', '所在页面', '字号类别'];
        let translationsObj = rec.translations;
        if (!translationsObj || typeof translationsObj !== 'object') {
          translationsObj = {};
          Object.keys(rec.fields || {}).forEach(k => {
            if (!systemKeys.includes(k) && rec.fields[k] !== undefined) {
              translationsObj[k] = rec.fields[k];
            }
          });
        }

        // Merge with existing translations in database so previous language translations are preserved
        // Use parseJsonField so a corrupted JSON column is reported (logged) instead of silently swallowed.
        let existingTrans = parseJsonField(existing && existing.translations);
        const finalTranslationsObj = { ...existingTrans, ...translationsObj };
        const fieldsStr = JSON.stringify(finalTranslationsObj);

        let mergedMeta = rec.translationsMeta;
        if (!mergedMeta && existing && existing.translations_meta) {
          try {
            mergedMeta = typeof existing.translations_meta === 'string' ? JSON.parse(existing.translations_meta) : existing.translations_meta;
          } catch {
            mergedMeta = {};
          }
        }
        const translationsMetaStr = JSON.stringify(mergedMeta || {});
        const nowStr = new Date().toISOString();

        const hasSortOrder = rec.sortOrder !== undefined;
        await tx.query(`
          UPDATE terms
          SET kw = $1, context = $2, zh_cn = $3, translations = $4, translations_meta = $5, updated_at = $6${hasSortOrder ? ', sort_order = $7' : ''}
          WHERE id = $${hasSortOrder ? 8 : 7} AND version_id = $${hasSortOrder ? 9 : 8} AND (is_locked IS NOT TRUE)
        `, hasSortOrder ? [
          kwVal,
          contextVal,
          zhCnVal,
          fieldsStr,
          translationsMetaStr,
          nowStr,
          rec.sortOrder,
          rec.recordId,
          tableId
        ] : [
          kwVal,
          contextVal,
          zhCnVal,
          fieldsStr,
          translationsMetaStr,
          nowStr,
          rec.recordId,
          tableId
        ]);
        successCount++;
      }
      // 4. Reorder (sort_order only updates for unchanged records) — CASE 批量更新
      const validReorders = reorder.filter(r => r.recordId && r.sortOrder !== undefined);
      for (let i = 0; i < validReorders.length; i += 500) {
        const chunk = validReorders.slice(i, i + 500);
        const whenClauses = [];
        const inPhs = [];
        const params = [];
        chunk.forEach((r, j) => {
          whenClauses.push(`WHEN $${2 * j + 1} THEN $${2 * j + 2}`);
          params.push(r.recordId, r.sortOrder);
        });
        const base = 2 * chunk.length;
        chunk.forEach((_r, j) => inPhs.push(`$${base + j + 1}`));
        // SQLite 的 $N 转换后是位置参数, 不能复用, IN 列表的 id 需要再次传参
        chunk.forEach(r => params.push(r.recordId));
        params.push(tableId);
        await tx.query(
          `UPDATE terms SET sort_order = CASE id ${whenClauses.join(' ')} END
           WHERE id IN (${inPhs.join(',')}) AND version_id = $${base + chunk.length + 1}`,
          params
        );
      }

      // 5. 记录同步审计日志
      try {
        const ver = await tx.queryOne('SELECT version_name FROM versions WHERE id = $1', [tableId]);
        const verName = ver ? ver.version_name : '';

        if (added.length === 1) {
          const a = added[0];
          const aKw = a.fields?.['KW'] || a.kw || '';
          const aZh = a.fields?.['CN（中文）'] || a.zh_cn || '';
          await createAuditLog({
            kw: aKw,
            chinese: aZh,
            action: '新增词条',
            details: `新增词条 [${aKw}] (${aZh})`,
            versionName: verName,
            userId: req.user.id,
            tx
          });
        } else if (added.length > 1) {
          const firstFew = added.slice(0, 5).map(i => (i.fields?.['KW'] || i.kw)).filter(Boolean).join(', ');
          await createAuditLog({
            action: '批量新增',
            details: `批量新增了 ${added.length} 条词条${firstFew ? ` (${firstFew} 等)` : ''}`,
            versionName: verName,
            userId: req.user.id,
            tx
          });
        }

        if (updated.length === 1) {
          const u = updated[0];
          const uKw = u.fields?.['KW'] || u.kw || '';
          const uZh = u.fields?.['CN（中文）'] || u.zh_cn || '';
          await createAuditLog({
            kw: uKw,
            chinese: uZh,
            action: '修改词条',
            details: `同步更新词条 [${uKw}] 译文`,
            versionName: verName,
            userId: req.user.id,
            tx
          });
        } else if (updated.length > 1) {
          const isAi = updated.some(u => {
            const m = u.translationsMeta || {};
            return Object.values(m).some(v => v === 'ai');
          });
          const isTm = updated.some(u => {
            const m = u.translationsMeta || {};
            return Object.values(m).some(v => v === 'tm');
          });
          const actionName = isAi ? 'AI批量翻译' : (isTm ? '翻译继承' : '批量更新');
          await createAuditLog({
            action: actionName,
            details: `${actionName}更新了 ${updated.length} 条词条数据`,
            versionName: verName,
            userId: req.user.id,
            tx
          });
        }

        if (deletedIds.length > 0) {
          await createAuditLog({
            action: '批量删除',
            details: `同步删除了 ${deletedIds.length} 条词条`,
            versionName: verName,
            userId: req.user.id,
            tx
          });
        }
      } catch (logErr) {
        console.error('[sync] 记录审计日志异常:', logErr);
      }
    });

    res.json({ message: '同步成功', updatedRecords: successCount });
  } catch (error) {
    console.error('Batch sync error:', error);
    res.status(500).json({ error: `批量同步数据失败: ${error.message || '未知错误'}` });
  }
});

// DELETE /api/tables/:tableId/clean-empty - 删除空词条 (无KW或无中文)
router.delete('/tables/:tableId/clean-empty', authenticateToken, writeLimiter, async (req, res) => {
  const { tableId } = req.params;

  try {
    if (!(await requireVersionOwnership(req.user.id, tableId))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权修改此数据表。' });
    }

    if (req.user.role !== 'admin') {
      const verMembership = await db.queryOne(
        'SELECT pm.role FROM versions v JOIN project_members pm ON v.project_id = pm.project_id WHERE v.id = $1 AND pm.user_id = $2',
        [tableId, req.user.id]
      );
      if (!verMembership || verMembership.role === 'viewer') {
        return res.status(403).json({ error: 'FORBIDDEN', message: '只读审核人员无权清理词条。' });
      }
    }

    const result = await db.run(`
      DELETE FROM terms
      WHERE version_id = $1
        AND (TRIM(COALESCE(kw, '')) = '' OR TRIM(COALESCE(zh_cn, '')) = '')
        AND (is_locked IS NOT TRUE)
    `, [tableId]);

    const deletedCount = result.changes || 0;

    if (deletedCount > 0) {
      try {
        const ver = await db.queryOne('SELECT version_name FROM versions WHERE id = $1', [tableId]);
        await createAuditLog({
          action: '数据清理',
          details: `清理了数据表中的 ${deletedCount} 条空词条 (无 KW 或无中文)`,
          versionName: ver ? ver.version_name : '',
          userId: req.user.id
        });
      } catch (logErr) {
        console.error('[clean-empty] 记录日志异常:', logErr);
      }
    }

    res.json({ message: `清理完毕，共删除 ${deletedCount} 条空词条`, deletedCount });
  } catch (error) {
    console.error('清理空词条失败:', error);
    res.status(500).json({ error: '服务器内部错误，清理失败。' });
  }
});

// ALL (GET/POST) /api/tables/:tableId/export-xls - 导出 Excel (.xlsx) 表格数据 (支持高亮标记)
router.all('/tables/:tableId/export-xls', authenticateToken, async (req, res) => {
  const { tableId } = req.params;
  const highlightIdsList = req.body?.highlightIds || (req.query?.highlightIds ? req.query.highlightIds.split(',') : []);
  const highlightIds = new Set(highlightIdsList);
  const modifiedCells = req.body?.modifiedCells || {};

  try {
    if (!(await requireVersionOwnership(req.user.id, tableId))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权导出此数据表。' });
    }

    const version = await db.queryOne('SELECT version_name FROM versions WHERE id = $1', [tableId]);
    const terms = await db.query('SELECT * FROM terms WHERE version_id = $1 ORDER BY sort_order ASC, created_at ASC', [tableId]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'GlossaHub';
    workbook.created = new Date();

    const sheetName = (version?.version_name || tableId || 'Sheet1').slice(0, 31).replace(/[:\\/?*[\]]/g, '_');
    const worksheet = workbook.addWorksheet(sheetName);

    const headers = ['KW', 'CN（中文）', '所在页面', '字号类别', ...TARGET_LANGUAGES];
    const headerRow = worksheet.addRow(headers);

    // Header styling
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 24;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F2937' } // Dark gray/slate
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
      };
    });

    const ALIASES_BY_CANONICAL = Object.entries(LEGACY_TO_NEW_LANG_MAP).reduce((acc, [legacy, canonical]) => {
      (acc.get(canonical) || acc.set(canonical, []).get(canonical)).push(legacy);
      return acc;
    }, new Map());

    for (const term of terms) {
      const trans = parseJsonField(term.translations);

      const rowValues = [
        term.kw && term.kw.startsWith('__EMPTY_KW_') ? '' : (term.kw || ''),
        term.zh_cn || '',
        term.context || '',
        term.owner || ''
      ];

      TARGET_LANGUAGES.forEach(lang => {
        let val = trans[lang];
        if (val === undefined || val === null || String(val).trim() === '') {
          const aliases = ALIASES_BY_CANONICAL.get(lang);
          if (aliases) {
            for (const alias of aliases) {
              const candidate = trans[alias];
              if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
                val = candidate;
                break;
              }
            }
          }
        }
        if (val === undefined || val === null) val = '';
        rowValues.push(val);
      });

      const row = worksheet.addRow(rowValues);
      row.height = 20;

      // Determine highlight status
      const termMod = modifiedCells[term.id] || modifiedCells[term.kw];
      const isHighlighted = highlightIds.has(term.id) || highlightIds.has(term.kw) || !!termMod;

      const isAdded = termMod?.isAdded;

      row.eachCell((cell, colNumber) => {
        cell.alignment = { vertical: 'middle', wrapText: false };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
        };

        if (isHighlighted) {
          if (isAdded) {
            // Light green highlight for newly added terms
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFDCFCE7' } // Tailwind green-100
            };
          } else if (termMod && typeof termMod === 'object') {
            // Check specific language or general modification
            if (colNumber >= 5) {
              const lang = TARGET_LANGUAGES[colNumber - 5];
              if (termMod[lang] || termMod.isModified) {
                cell.fill = {
                  type: 'pattern',
                  pattern: 'solid',
                  fgColor: { argb: 'FFFEF3C7' } // Tailwind amber/yellow-100
                };
              }
            } else if (termMod.isModified) {
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFEF3C7' }
              };
            }
          } else {
            // General highlight
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFFEF3C7' }
            };
          }
        }
      });
    }

    // Adjust column widths
    worksheet.columns.forEach((column, index) => {
      let maxLen = headers[index] ? headers[index].length * 2 : 10;
      column.eachCell({ includeEmpty: false }, (cell) => {
        const str = cell.value ? String(cell.value) : '';
        const len = str.length;
        if (len > maxLen) maxLen = len;
      });
      column.width = Math.min(Math.max(maxLen + 3, 12), 45);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = encodeURIComponent(`GlossaHub_${version?.version_name || tableId}_Export.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.send(buffer);
  } catch (error) {
    console.error('导出 Excel 表格失败:', error);
    res.status(500).json({ error: '服务器内部错误，导出失败。' });
  }
});

// ALL (GET/POST) /api/tables/:tableId/export-csv - 导出 CSV 表格数据 (删除“所在页面”和“字号类别”列)
router.all('/tables/:tableId/export-csv', authenticateToken, async (req, res) => {
  const { tableId } = req.params;

  try {
    if (!(await requireVersionOwnership(req.user.id, tableId))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权导出此数据表。' });
    }

    const version = await db.queryOne('SELECT version_name FROM versions WHERE id = $1', [tableId]);
    const terms = await db.query('SELECT * FROM terms WHERE version_id = $1 ORDER BY sort_order ASC, created_at ASC', [tableId]);

    // CSV 表头：删除“所在页面”和“字号类别”列，其他字段和顺序不变
    const headers = ['KW', 'CN（中文）', ...TARGET_LANGUAGES];

    const ALIASES_BY_CANONICAL = Object.entries(LEGACY_TO_NEW_LANG_MAP).reduce((acc, [legacy, canonical]) => {
      (acc.get(canonical) || acc.set(canonical, []).get(canonical)).push(legacy);
      return acc;
    }, new Map());

    const escapeCsvCell = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('\n') || str.includes('\r') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [];
    lines.push(headers.map(escapeCsvCell).join(','));

    for (const term of terms) {
      const trans = parseJsonField(term.translations);
      const rowValues = [
        term.kw && term.kw.startsWith('__EMPTY_KW_') ? '' : (term.kw || ''),
        term.zh_cn || ''
      ];

      TARGET_LANGUAGES.forEach(lang => {
        let val = trans[lang];
        if (val === undefined || val === null || String(val).trim() === '') {
          const aliases = ALIASES_BY_CANONICAL.get(lang);
          if (aliases) {
            for (const alias of aliases) {
              const candidate = trans[alias];
              if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
                val = candidate;
                break;
              }
            }
          }
        }
        if (val === undefined || val === null) val = '';
        rowValues.push(val);
      });

      lines.push(rowValues.map(escapeCsvCell).join(','));
    }

    // UTF-8 BOM (\uFEFF) for Excel compatibility
    const csvContent = '\uFEFF' + lines.join('\r\n');
    const rawFileName = `GlossaHub_${version?.version_name || tableId}_Export.csv`;
    const fileName = encodeURIComponent(rawFileName);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.send(csvContent);
  } catch (error) {
    console.error('导出 CSV 表格失败:', error);
    res.status(500).json({ error: '服务器内部错误，导出 CSV 失败。' });
  }
});

module.exports = router;

