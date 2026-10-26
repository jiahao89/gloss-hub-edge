const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db, verifyPassword, hashPassword } = require('../config/db.cjs');
const { signUserToken } = require('../middleware/auth.cjs');
const { loginLimiter } = require('../middleware/rateLimiters.cjs');

// 模块加载时预生成一个固定 dummy bcrypt hash: 用户不存在时也执行一次
// bcrypt 校验, 使两条路径耗时接近, 消除"用户名是否存在"的时序侧信道。
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('__glossahub_dummy_password__', 10);

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码！' });
  }

  try {
    const user = await db.queryOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user) {
      // 与"用户存在但密码错误"路径保持等耗时
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: '用户名或密码不正确！' });
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: '用户名或密码不正确！' });
    }

    // 自动升级旧 SHA256 哈希为 bcrypt
    if (user.password_hash.length === 64) {
      const newHash = await hashPassword(password);
      await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
    }

    const effectiveRole = user.system_role || user.role || 'user';
    const token = signUserToken({ id: user.id, username: user.username, role: effectiveRole, system_role: effectiveRole, name: user.name });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: effectiveRole,
        system_role: effectiveRole
      }
    });
  } catch (err) {
    console.error('登录出错:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  }
});

module.exports = router;
