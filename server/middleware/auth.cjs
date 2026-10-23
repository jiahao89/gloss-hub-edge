const jwt = require('jsonwebtoken');
const { db } = require('../config/db.cjs');

const JWT_SECRET = process.env.JWT_SECRET;
// Vercel Serverless 环境下 NODE_ENV=production 但 JWT_SECRET 仅在 Render 部署设置。
// 注意: api/index.js 现在是纯反向代理(只把 /api/* 转发到 Render 后端),
// 不再在 Vercel 上运行本 Express 应用, 因此这段降级逻辑实际只服务于本地开发
// (本地开发仍需要这个后备密钥才能启动)。生产环境的真实鉴权全部发生在
// Render 端, 安全性由 Render 端 JWT_SECRET 环境变量保证。
// 保留降级而不是 process.exit(1), 避免误设 NODE_ENV=production 时直接崩溃。
if (!JWT_SECRET) {
  const isVercel = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (process.env.NODE_ENV === 'production' && !isVercel) {
    console.error('🚨 致命错误：生产环境未设置 JWT_SECRET 环境变量！出于安全考虑，服务将拒绝启动。');
    process.exit(1);
  }
  console.warn('⚠️ 未设置 JWT_SECRET 环境变量！当前使用开发专用后备密钥。生产环境(Render)必须配置 JWT_SECRET,否则 Token 可被伪造！');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'glossahub-dev-secret-do-not-use-in-prod';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '未登录或登录已过期，请重新登录。' });
  }

  jwt.verify(token, EFFECTIVE_JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: '无访问权限或登录已过期，请重新登录。' });
    }

    try {
      // 容错自愈与多环境ID对齐：
      // 当发生跨库切换（如 SQLite 与 PostgreSQL）或 Token 内 ID 与活跃数据库不一致时，
      // 优先按 ID 查询；若未匹配则按 username 匹配活跃库中的真实 ID 与角色，
      // 保证 req.user.id 和 req.user.role 始终与数据库主键及最新权限保持一致。
      let dbUser = await db.queryOne('SELECT id, username, name, role FROM users WHERE id = $1', [decoded.id]);
      if (!dbUser && decoded.username) {
        dbUser = await db.queryOne('SELECT id, username, name, role FROM users WHERE username = $1', [decoded.username]);
      }

      if (dbUser) {
        req.user = {
          ...decoded,
          id: dbUser.id,
          username: dbUser.username,
          role: dbUser.role || decoded.role || 'user',
          name: dbUser.name || decoded.name
        };
      } else {
        req.user = decoded;
      }
      next();
    } catch {
      req.user = decoded;
      next();
    }
  });
}

// Project membership authorization middleware
async function requireProjectMember(req, res, next) {
  const projectId = req.params.projectId || 'proj-default';
  if (req.user?.role === 'admin') {
    req.projectRole = 'owner';
    return next();
  }
  try {
    const member = await db.queryOne(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, req.user.id]
    );
    if (!member) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '您无权访问此项目。' });
    }
    req.projectRole = member.role;
    next();
  } catch (err) {
    console.error('RBAC 校验失败:', err.message);
    return res.status(500).json({ error: '权限校验失败，请稍后重试。' });
  }
}

// System Admin authorization middleware
function requireSystemAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN', message: '需要超级管理员权限。' });
  }
  next();
}

// Fine-grained RBAC requireRole middleware
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.projectRole) && req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: '您的角色权限不足以执行此操作。'
      });
    }
    next();
  };
}

async function requireVersionOwnership(userId, versionId) {
  let user = await db.queryOne('SELECT role FROM users WHERE id = $1', [userId]);
  if (!user && typeof userId === 'string' && userId.startsWith('user-')) {
    const uname = userId.replace(/^user-/, '');
    user = await db.queryOne('SELECT role, id FROM users WHERE username = $1', [uname]);
    if (user) userId = user.id;
  }
  if (user && user.role === 'admin') return true;
  const ver = await db.queryOne(
    'SELECT v.project_id FROM versions v JOIN project_members pm ON v.project_id = pm.project_id WHERE v.id = $1 AND pm.user_id = $2',
    [versionId, userId]
  );
  return !!ver;
}

async function requireTermOwnership(userId, termId) {
  let user = await db.queryOne('SELECT role FROM users WHERE id = $1', [userId]);
  if (!user && typeof userId === 'string' && userId.startsWith('user-')) {
    const uname = userId.replace(/^user-/, '');
    user = await db.queryOne('SELECT role, id FROM users WHERE username = $1', [uname]);
    if (user) userId = user.id;
  }
  if (user && user.role === 'admin') return true;
  const term = await db.queryOne(
    `SELECT t.version_id FROM terms t
     JOIN versions v ON t.version_id = v.id
     JOIN project_members pm ON v.project_id = pm.project_id
     WHERE t.id = $1 AND pm.user_id = $2`,
    [termId, userId]
  );
  return !!term;
}

function signUserToken(userPayload) {
  return jwt.sign(userPayload, EFFECTIVE_JWT_SECRET, { expiresIn: '7d' });
}

module.exports = {
  authenticateToken,
  requireProjectMember,
  requireSystemAdmin,
  requireRole,
  requireVersionOwnership,
  requireTermOwnership,
  signUserToken,
  EFFECTIVE_JWT_SECRET
};
