const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db, hashPassword, getDbType } = require('../config/db.cjs');
const { authenticateToken, requireSystemAdmin } = require('../middleware/auth.cjs');
const { createAuditLog } = require('../services/auditLogger.cjs');

router.get('/users', authenticateToken, requireSystemAdmin, async (_req, res) => {
  try {
    const users = await db.query('SELECT id, username, name, role, created_at FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (err) {
    console.error('Failed to get users:', err);
    res.status(500).json({ error: '无法获取用户列表' });
  }
});

router.post('/users', authenticateToken, requireSystemAdmin, async (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ error: '请填写完整的用户信息' });
  }
  try {
    const existing = await db.queryOne('SELECT id FROM users WHERE username = $1', [username]);
    if (existing) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const hashedPwd = await hashPassword(password);
    const userId = crypto.randomUUID();
    const targetRole = role === 'admin' ? 'admin' : 'user';
    // PG 列定义里有 DEFAULT NOW()，让它自动填充，避免传 JS Date 对象导致时区信息丢失。
    // SQLite 列没有默认值，所以传 ISO 字符串兜底。
    const createdAt = getDbType() === 'postgres' ? undefined : new Date().toISOString();

    if (getDbType() === 'postgres') {
      await db.run(
        'INSERT INTO users (id, username, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)',
        [userId, username, hashedPwd, name, targetRole]
      );
    } else {
      await db.run(
        'INSERT INTO users (id, username, password_hash, name, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, username, hashedPwd, name, targetRole, createdAt]
      );
    }

    res.status(201).json({ success: true, user: { id: userId, username, name, role: targetRole, created_at: createdAt } });
  } catch (err) {
    console.error('Failed to create user:', err);
    res.status(500).json({ error: '添加用户失败' });
  }
});

router.put('/users/:id', authenticateToken, requireSystemAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, role, password } = req.body;

  if (!name || !role) {
    return res.status(400).json({ error: '姓名和角色不能为空' });
  }

  try {
    const targetRole = role === 'admin' ? 'admin' : 'user';

    if (password && password.trim() !== '') {
      const hashedPwd = await hashPassword(password);
      await db.run(
        'UPDATE users SET name = $1, role = $2, password_hash = $3 WHERE id = $4',
        [name, targetRole, hashedPwd, id]
      );
    } else {
      await db.run(
        'UPDATE users SET name = $1, role = $2 WHERE id = $3',
        [name, targetRole, id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update user:', err);
    res.status(500).json({ error: '更新用户信息失败' });
  }
});

router.delete('/users/:id', authenticateToken, requireSystemAdmin, async (req, res) => {
  const { id } = req.params;

  if (req.user.id === id) {
    return res.status(400).json({ error: '系统保护：无法删除自己。' });
  }

  try {
    const target = await db.queryOne('SELECT id, username, role FROM users WHERE id = $1', [id]);
    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 保护最后一个系统管理员, 防止系统失去管理员入口
    if (target.role === 'admin') {
      const adminCountRow = await db.queryOne("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'");
      const adminCount = parseInt(adminCountRow?.cnt || 0, 10);
      if (adminCount <= 1) {
        return res.status(400).json({ error: '不能删除最后一个系统管理员' });
      }
    }

    await db.run('DELETE FROM users WHERE id = $1', [id]);

    try {
      await createAuditLog({
        action: '删除用户',
        details: `删除用户 [${target.username}] (角色: ${target.role})`,
        userId: req.user.id
      });
    } catch (logErr) {
      console.error('[admin.deleteUser] 记录审计日志异常:', logErr);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete user:', err);
    res.status(500).json({ error: '删除用户失败，可能存在外键约束，请联系开发确认。' });
  }
});

module.exports = router;
