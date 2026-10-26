const express = require('express');
const router = express.Router();
const { db, getDbType } = require('../config/db.cjs');
const { authenticateToken, requireSystemAdmin } = require('../middleware/auth.cjs');

// POST /api/logs 允许写入的 action 白名单 (与后端各路由 createAuditLog 使用的枚举一致)。
// 前端任意用户都可触发写日志, 因此用白名单防止伪造任意动作文案污染审计记录。
const ALLOWED_LOG_ACTIONS = [
  '新增词条', '修改词条', '批量新增', '批量修改', '批量更新', '批量删除',
  '批量复制', '批量生成KW', 'AI批量翻译', '翻译继承', '历史回退', '内容审核',
  '数据清理', '回收站恢复', '锁定词条', '解锁词条', '同步合并',
  '创建版本', '删除版本', '重命名版本'
];

// 字符串字段统一截断, 防止超长内容撑爆审计表
const truncateField = (val, max = 200) => (typeof val === 'string' ? val.slice(0, max) : '');

// 筛选选项缓存: 日志页每次加载都要对 logs 表跑 3 个 DISTINCT 全表扫描
// (version/operator/action), 而选项集变化频率极低 → 60s 内存缓存。
const FILTER_OPTIONS_TTL_MS = 60000;
const filterOptionsCache = new Map(); // logsTable -> { expiresAt, versions, operators, actions }

async function getFilterOptions(logsTable) {
  const cached = filterOptionsCache.get(logsTable);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const [versionRows, operatorRows, actionRows] = await Promise.all([
    db.query(`SELECT DISTINCT l.version_name FROM ${logsTable} l WHERE l.version_name IS NOT NULL AND l.version_name != '' ORDER BY l.version_name`),
    db.query(`SELECT DISTINCT u.name FROM ${logsTable} l LEFT JOIN users u ON l.user_id = u.id WHERE u.name IS NOT NULL AND u.name != '' ORDER BY u.name`),
    db.query(`SELECT DISTINCT l.action FROM ${logsTable} l WHERE l.action IS NOT NULL AND l.action != '' ORDER BY l.action`)
  ]);

  const options = {
    expiresAt: Date.now() + FILTER_OPTIONS_TTL_MS,
    versions: versionRows.map(r => r.version_name).filter(Boolean),
    operators: operatorRows.map(r => r.name).filter(Boolean),
    actions: actionRows.map(r => r.action).filter(Boolean)
  };
  filterOptionsCache.set(logsTable, options);
  return options;
}

// GET /api/logs - 获取修改日志（分页 + 服务端筛选）
router.get('/', authenticateToken, async (req, res) => {
  const dbType = getDbType();
  const {
    page = '1',
    pageSize = '50',
    search = '',
    version = '',
    operator = '',
    action = '',
    startDate = '',
    endDate = ''
  } = req.query;

  const pageNum = Math.max(1, parseInt(page) || 1);
  const size = Math.min(200, Math.max(1, parseInt(pageSize) || 50));
  const offset = (pageNum - 1) * size;

  try {
    const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';

    // Build WHERE clause
    let whereClause = ' WHERE 1=1';
    const params = [];
    let pi = 1; // paramIndex

    const rawSearch = (search || '').trim();
    if (rawSearch) {
      const tokens = rawSearch.split(/\s+/).filter(Boolean);
      const escapeLike = (str) => str.replace(/([%_\\])/g, '\\$1');

      if (dbType === 'sqlite') {
        const tokenClauses = [];
        for (const token of tokens) {
          const p1 = pi, p2 = pi + 1, p3 = pi + 2, p4 = pi + 3;
          tokenClauses.push(`(l.kw LIKE $${p1} ESCAPE '\\' OR l.chinese LIKE $${p2} ESCAPE '\\' OR l.details LIKE $${p3} ESCAPE '\\' OR u.name LIKE $${p4} ESCAPE '\\')`);
          const pattern = `%${escapeLike(token)}%`;
          params.push(pattern, pattern, pattern, pattern);
          pi += 4;
        }
        if (tokenClauses.length > 0) {
          whereClause += ` AND (${tokenClauses.join(' AND ')})`;
        }
      } else {
        const tokenClauses = [];
        for (const token of tokens) {
          tokenClauses.push(`(l.kw ILIKE $${pi} ESCAPE '\\' OR l.chinese ILIKE $${pi} ESCAPE '\\' OR l.details ILIKE $${pi} ESCAPE '\\' OR u.name ILIKE $${pi} ESCAPE '\\')`);
          params.push(`%${escapeLike(token)}%`);
          pi++;
        }
        if (tokenClauses.length > 0) {
          whereClause += ` AND (${tokenClauses.join(' AND ')})`;
        }
      }
    }

    if (version) {
      whereClause += ` AND l.version_name = $${pi}`;
      params.push(version);
      pi++;
    }

    if (operator) {
      whereClause += ` AND u.name = $${pi}`;
      params.push(operator);
      pi++;
    }

    if (action) {
      whereClause += ` AND l.action = $${pi}`;
      params.push(action);
      pi++;
    }

    if (startDate) {
      // 前端日期选择器传 YYYY-MM-DD；也可能传完整时间串。统一补成当日起点。
      const startVal = startDate.includes('T') || startDate.includes(' ') ? startDate : `${startDate} 00:00:00`;
      // SQLite 里 timestamp 存在两种格式 (datetime('now') 的空格分隔 / toISOString 的 T 分隔),
      // 用 datetime() 归一化后再比较, 保证两种格式都能正确过滤。
      whereClause += dbType === 'sqlite'
        ? ` AND datetime(l.timestamp) >= datetime($${pi})`
        : ` AND l.timestamp >= $${pi}`;
      params.push(startVal);
      pi += 1;
    }

    if (endDate) {
      const endVal = endDate.includes('T') || endDate.includes(' ') ? endDate : `${endDate} 23:59:59.999`;
      whereClause += dbType === 'sqlite'
        ? ` AND datetime(l.timestamp) <= datetime($${pi})`
        : ` AND l.timestamp <= $${pi}`;
      params.push(endVal);
      pi += 1;
    }

    // 分页查询与 COUNT 相互独立, 并行执行
    const [rows, countRows, filterOptions] = await Promise.all([
      db.query(
        `SELECT l.*, u.name AS operator_name FROM ${logsTable} l
         LEFT JOIN users u ON l.user_id = u.id
         ${whereClause}
         ORDER BY l.id DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, size, offset]
      ),
      db.query(
        `SELECT COUNT(*) as total FROM ${logsTable} l
         LEFT JOIN users u ON l.user_id = u.id
         ${whereClause}`,
        params
      ),
      getFilterOptions(logsTable)
    ]);
    const total = countRows[0]?.total || 0;

    const formatted = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      kw: r.kw,
      chinese: r.chinese,
      action: r.action,
      details: r.details,
      version: r.version_name,
      operator: r.operator_name || '系统'
    }));

    res.json({
      logs: formatted,
      total,
      page: pageNum,
      pageSize: size,
      filters: {
        versions: filterOptions.versions,
        operators: filterOptions.operators,
        actions: filterOptions.actions
      }
    });
  } catch (err) {
    console.error('读取修改记录日志失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// POST /api/logs - 记录新的修改日志
// 前端普通用户操作也会触发 (App.jsx handleAddLog), 因此不加管理员门禁,
// 改为: action 白名单校验 + 各字符串字段长度截断, 防止伪造动作/注入超长内容。
router.post('/', authenticateToken, async (req, res) => {
  const dbType = getDbType();
  const action = truncateField(req.body.action, 50);
  const kw = truncateField(req.body.kw);
  const chinese = truncateField(req.body.chinese);
  const details = truncateField(req.body.details, 2000);
  const version = truncateField(req.body.version);

  if (!action) {
    return res.status(400).json({ error: '必须包含 action 动作说明！' });
  }
  if (!ALLOWED_LOG_ACTIONS.includes(action)) {
    return res.status(400).json({ error: '非法的 action 动作类型！' });
  }

  try {
    const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
    const nowStr = new Date().toISOString();

    await db.run(
      `INSERT INTO ${logsTable} (timestamp, kw, chinese, action, details, version_name, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [nowStr, kw, chinese, action, details, version, req.user.id]
    );

    // 新日志可能引入新的 operator/action 选项, 失效筛选选项缓存
    filterOptionsCache.delete(logsTable);

    res.status(201).json({
      timestamp: nowStr,
      kw,
      chinese,
      action,
      details,
      version,
      operator: req.user.name
    });
  } catch (err) {
    console.error('记录日志失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

// DELETE /api/logs - 清空日志 (仅系统管理员)
router.delete('/', authenticateToken, requireSystemAdmin, async (_req, res) => {
  const dbType = getDbType();
  try {
    const logsTable = dbType === 'postgres' ? 'logs' : 'logs_v2';
    await db.run(`DELETE FROM ${logsTable}`);
    filterOptionsCache.delete(logsTable);
    res.json({ message: '修改记录清空成功' });
  } catch (err) {
    console.error('清空日志失败:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

module.exports = router;
