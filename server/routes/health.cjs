const express = require('express');
const router = express.Router();
const { db, ensureDbInit, getDbType, getPgError, getPgDebug } = require('../config/db.cjs');
const { authenticateToken } = require('../middleware/auth.cjs');

router.get('/health', async (_req, res) => {
  let dbStatus = 'ok';
  let dbLatency = 0;

  try {
    const start = Date.now();
    await ensureDbInit();
    // 实际执行一条轻量查询，既能探测真实连接状态，也能持续刷新 Supabase 的 7 天不活跃休眠倒计时
    await db.queryOne('SELECT 1 as ping');
    dbLatency = Date.now() - start;
  } catch (err) {
    dbStatus = 'error';
    console.error('🩺 /health 数据库主动探测失败:', err.message);
  }

  const isHealthy = dbStatus === 'ok';
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    dbStatus,
    dbLatencyMs: dbLatency,
    dbType: getDbType(),
    timestamp: new Date().toISOString()
  });
});

router.get('/debug-status', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  res.json({
    dbType: getDbType(),
    port: process.env.PORT || 3001,
    hasPgUrl: !!process.env.DATABASE_URL,
    pgError: getPgError(),
    pgDebug: getPgDebug()
  });
});

module.exports = router;
