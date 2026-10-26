const path = require('path');
const crypto = require('crypto');

const DB_PATH = (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
  ? path.join('/tmp', 'glossahub.db')
  : path.join(__dirname, '..', '..', 'glossahub.db');
const pgUrl = process.env.DATABASE_URL;

let dbType = 'sqlite';
let sqliteDb = null;
let pgPool = null;
let pgError = null;
let pgDebug = null;

let dbInitPromise = null;
let dbInitError = null;

// SHA256 hashing helper for legacy password compatibility
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// bcrypt hashing helper (new standard) — 异步执行，避免 ~100ms CPU 哈希阻塞事件循环
const bcrypt = require('bcryptjs');
const BCRYPT_ROUNDS = 10;
async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
async function verifyPassword(plain, hash) {
  // 兼容旧 SHA256 哈希（64 位 hex = SHA256）
  if (hash && hash.length === 64) {
    return sha256(plain) === hash;
  }
  return bcrypt.compare(plain, hash);
}

// 创建关键索引以加速常用查询（SQLite 与 Postgres 均需执行，索引语句语法两库通用，无 SQLite 专有写法）
async function ensureIndexes() {
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_versions_project_id ON versions(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_terms_version_id ON terms(version_id)',
    'CREATE INDEX IF NOT EXISTS idx_terms_version_sort ON terms(version_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_logs_v2_user_id ON logs_v2(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_languages_project_id ON languages(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_glossary_terms_table_id ON glossary_terms(table_id)'
  ];
  if (dbType === 'sqlite' && sqliteDb) {
    indexes.forEach(idx => sqliteDb.run(idx));
    console.log('⚡ SQLite 索引已就绪');
  } else if (dbType === 'postgres' && pgPool) {
    for (const idx of indexes) {
      // logs_v2 是 SQLite 专有表名（PG 审计日志表为 logs，且 db_init_pg.sql 已建 idx_pg_logs_user_id），PG 分支跳过
      if (idx.includes('logs_v2')) continue;
      try {
        await pgPool.query(idx);
      } catch (err) {
        // 部分部署可能尚未创建对应表（如 languages / glossary_terms），单条失败不阻塞其余索引
        console.warn('⚠️ PG 索引创建跳过:', err.message);
      }
    }
    console.log('⚡ PG 索引已就绪');
  }
}

async function initSqliteTables() {
  // 种子用户哈希预生成（异步 bcrypt，不阻塞事件循环）
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || 'magene123';
  if (process.env.NODE_ENV === 'production' && adminPassword === 'magene123') {
    console.warn('🚨🚨 安全警告: 生产环境仍在使用默认管理员种子密码 (magene123)，请立即通过 INITIAL_ADMIN_PASSWORD 环境变量修改！ 🚨🚨');
  }
  const [passHash, userHash, viewerHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword('user123'),
    hashPassword('viewer123')
  ]);

  return new Promise((resolve, _reject) => {
    sqliteDb.serialize(() => {
      // 1. users
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          created_at TEXT
        )
      `);

      // 2. projects
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          description TEXT,
          dify_config TEXT DEFAULT '{}',
          created_at TEXT
        )
      `);

      // 3. project_members (RBAC)
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS project_members (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'viewer',
          created_at TEXT,
          UNIQUE(project_id, user_id)
        )
      `);

      // 4. versions
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS versions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version_name TEXT NOT NULL,
          created_at TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(project_id, version_name)
        )
      `);

      // 5. terms
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS terms (
          id TEXT PRIMARY KEY,
          version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
          kw TEXT NOT NULL,
          context TEXT,
          owner TEXT,
          zh_cn TEXT NOT NULL,
          translations TEXT NOT NULL DEFAULT '{}',
          translations_meta TEXT NOT NULL DEFAULT '{}',
          created_at TEXT,
          updated_at TEXT,
          updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          is_locked INTEGER DEFAULT 0,
          locked_by TEXT,
          locked_at TEXT,
          status TEXT DEFAULT 'DRAFT',
          reject_reason TEXT,
          sort_order INTEGER DEFAULT 0,
          UNIQUE(version_id, kw)
        )
      `);

      // 5b. term_snapshots
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS term_snapshots (
          id TEXT PRIMARY KEY,
          term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
          version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
          kw TEXT NOT NULL,
          zh_cn TEXT,
          translations TEXT NOT NULL DEFAULT '{}',
          created_at TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL
        )
      `);

      // 6b. ai_usage_logs
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS ai_usage_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          project_id TEXT NOT NULL,
          term_kw TEXT,
          zh_cn TEXT,
          target_languages TEXT,
          total_tokens INTEGER DEFAULT 0,
          elapsed_time REAL DEFAULT 0,
          status TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 6. logs_v2
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS logs_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT,
          kw TEXT,
          chinese TEXT,
          action TEXT NOT NULL,
          details TEXT,
          version_name TEXT,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL
        )
      `);

      // Pre-populate users
      sqliteDb.run(`
        INSERT OR IGNORE INTO users (id, username, password_hash, name, role, created_at)
        VALUES 
        ('user-wangzhaoyun', 'wangzhaoyun', ?, 'wangzhaoyun', 'admin', datetime('now')),
        ('user-shidongsheng', 'shidongsheng', ?, 'shidongsheng', 'admin', datetime('now')),
        ('user-liuchenlu', 'liuchenlu', ?, 'liuchenlu', 'admin', datetime('now')),
        ('user-liuyuanyuan', 'liuyuanyuan', ?, 'liuyuanyuan', 'admin', datetime('now')),
        ('user-bizihao', 'bizihao', ?, 'bizihao', 'admin', datetime('now')),
        ('user-shengyongbang', 'shengyongbang', ?, 'shengyongbang', 'admin', datetime('now')),
        ('user-lanyiwei', 'lanyiwei', ?, 'lanyiwei', 'admin', datetime('now')),
        ('user-jiahao', 'jiahao', ?, 'jiahao', 'admin', datetime('now')),
        ('user-user1', 'user1', ?, 'User One', 'user', datetime('now')),
        ('user-user2', 'user2', ?, 'User Two', 'user', datetime('now')),
        ('user-viewer1', 'viewer1', ?, 'Viewer One', 'user', datetime('now')),
        ('user-viewer2', 'viewer2', ?, 'Viewer Two', 'user', datetime('now'))
      `, [
        passHash, passHash, passHash, passHash, passHash, passHash, passHash, passHash,
        userHash, userHash, viewerHash, viewerHash
      ]);

      // Pre-populate default project
      sqliteDb.run(`
        INSERT OR IGNORE INTO projects (id, name, description, created_at)
        VALUES ('proj-default', '迈金智能骑行码表', 'Magene 码表固件词条多人协同翻译项目', datetime('now'))
      `);

      // Pre-populate project member relationships
      sqliteDb.run(`
        INSERT OR IGNORE INTO project_members (id, project_id, user_id, role, created_at)
        VALUES 
        ('mem-1', 'proj-default', 'user-wangzhaoyun', 'owner', datetime('now')),
        ('mem-2', 'proj-default', 'user-shidongsheng', 'owner', datetime('now')),
        ('mem-liuchenlu', 'proj-default', 'user-liuchenlu', 'owner', datetime('now')),
        ('mem-liuyuanyuan', 'proj-default', 'user-liuyuanyuan', 'owner', datetime('now')),
        ('mem-bizihao', 'proj-default', 'user-bizihao', 'owner', datetime('now')),
        ('mem-shengyongbang', 'proj-default', 'user-shengyongbang', 'owner', datetime('now')),
        ('mem-lanyiwei', 'proj-default', 'user-lanyiwei', 'owner', datetime('now')),
        ('mem-jiahao', 'proj-default', 'user-jiahao', 'owner', datetime('now')),
        ('mem-user1', 'proj-default', 'user-user1', 'editor', datetime('now')),
        ('mem-user2', 'proj-default', 'user-user2', 'editor', datetime('now')),
        ('mem-viewer1', 'proj-default', 'user-viewer1', 'viewer', datetime('now')),
        ('mem-viewer2', 'proj-default', 'user-viewer2', 'viewer', datetime('now'))
      `);

      // 7. languages
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS languages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          lang_code TEXT NOT NULL,
          lang_name TEXT NOT NULL,
          display_order INTEGER DEFAULT 0,
          created_at TEXT,
          UNIQUE(project_id, lang_code)
        )
      `);

      // 8. glossary_tables & terms
      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS glossary_tables (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          table_name TEXT NOT NULL,
          created_at TEXT,
          headers TEXT DEFAULT '["中文专业术语","英文翻译对应","说明 / 定义"]'
        )
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS glossary_terms (
          id TEXT PRIMARY KEY,
          table_id TEXT NOT NULL REFERENCES glossary_tables(id) ON DELETE CASCADE,
          cn_term TEXT,
          en_term TEXT,
          description TEXT,
          created_at TEXT,
          fields TEXT DEFAULT '{}'
        )
      `);

      sqliteDb.run(`
        CREATE TABLE IF NOT EXISTS recycle_bin (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_name TEXT NOT NULL,
          payload TEXT NOT NULL,
          deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          deleted_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `);

      // Schema migrations (ignore column already exists errors)
      sqliteDb.run("ALTER TABLE glossary_tables ADD COLUMN headers TEXT", () => {});
      sqliteDb.run("ALTER TABLE glossary_terms ADD COLUMN fields TEXT", () => {});
      sqliteDb.run("ALTER TABLE terms ADD COLUMN is_locked INTEGER DEFAULT 0", () => {});
      sqliteDb.run("ALTER TABLE terms ADD COLUMN locked_by TEXT", () => {});
      sqliteDb.run("ALTER TABLE terms ADD COLUMN locked_at TEXT", () => {});
      sqliteDb.run("ALTER TABLE terms ADD COLUMN status TEXT DEFAULT 'DRAFT'", () => {});
      sqliteDb.run("ALTER TABLE terms ADD COLUMN reject_reason TEXT", () => {});
      sqliteDb.run("ALTER TABLE terms ADD COLUMN translations_meta TEXT DEFAULT '{}'", () => {});
      sqliteDb.run("ALTER TABLE terms ADD COLUMN sort_order INTEGER DEFAULT 0", () => {});

      // Languages seeding
      sqliteDb.get("SELECT COUNT(*) as count FROM languages WHERE project_id = 'proj-default'", (_countErr, row) => {
        if (row && row.count === 0) {
          const defaultLangs = [
            { code: 'EN', name: 'EN（英文）' },
            { code: 'FR', name: 'FR（法）' },
            { code: 'DE', name: 'DE（德）' },
            { code: 'ES', name: 'ES（西班牙）' },
            { code: 'IT', name: 'IT（意大利）' },
            { code: 'PT', name: 'PT（葡萄牙）' },
            { code: 'KO', name: 'KO（韩）' },
            { code: 'JP', name: 'JP（日）' },
            { code: 'RU', name: 'RU（俄罗斯）' },
            { code: 'PL', name: 'PL（波兰）' },
            { code: 'TC', name: 'TC（繁）' },
            { code: 'DA', name: 'DA（丹麦）' },
            { code: 'CZ', name: 'CZ(捷克)' },
            { code: 'SE', name: '瑞典' },
            { code: 'NO', name: '挪威' },
            { code: 'NL', name: '荷兰' }
          ];

          const stmt = sqliteDb.prepare("INSERT OR IGNORE INTO languages (id, project_id, lang_code, lang_name, display_order, created_at) VALUES (?, 'proj-default', ?, ?, ?, datetime('now'))");
          defaultLangs.forEach((lang, idx) => {
            stmt.run([`lang-${lang.code.toLowerCase()}`, lang.code, lang.name, idx]);
          });
          stmt.finalize((finErr) => {
            if (finErr) console.error('⚠️ 预置 SQLite 默认语言失败:', finErr.message);
            else console.log('⚡ 成功预置迈金默认 16 个语种词典表');
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  });
}

async function initSqlite() {
  dbType = 'sqlite';
  let sqlite3;
  try {
    // eslint-disable-next-line no-eval
    const dynamicRequire = eval('require');
    sqlite3 = dynamicRequire('sqlite3').verbose();
  } catch (err) {
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      console.warn('⚠️ Vercel 云端 Serverless 环境下原生 sqlite3 模块不可用。', err.message);
      throw new Error('Vercel 环境必须在环境变量中配置有效的 DATABASE_URL 以连接 PostgreSQL / Supabase。');
    }
    throw err;
  }

  return new Promise((resolve, reject) => {
    sqliteDb = new sqlite3.Database(DB_PATH, async (err) => {
      if (err) {
        console.error('❌ 无法连接到 SQLite 数据库:', err.message);
        reject(err);
      } else {
        console.log('⚡ 成功连接到本地 SQLite 数据库 (glossahub.db)');
        sqliteDb.run('PRAGMA journal_mode = WAL;', (walErr) => {
          if (!walErr) console.log('⚡ SQLite 已成功开启 WAL (Write-Ahead Logging) 模式');
        });
        sqliteDb.run('PRAGMA synchronous = NORMAL;');
        sqliteDb.run('PRAGMA busy_timeout = 5000;');
        try {
          await initSqliteTables();
          resolve();
        } catch (tableErr) {
          reject(tableErr);
        }
      }
    });
  });
}

async function initDatabase() {
  if (process.env.VERCEL && !pgUrl) {
    console.warn('⚠️ 警告: 运行在 Vercel Serverless 环境下未配置 DATABASE_URL！/tmp 目录在冷启动时将被重置，数据无法持久存储！');
  }

  if (pgUrl) {
    try {
      const { Pool } = require('pg');
      const { parse } = require('pg-connection-string');

      let pgConfig = {};
      try {
        pgConfig = parse(pgUrl);
      } catch {
        pgConfig = {};
      }

      const isSupabase = pgUrl.includes('supabase');
      const sslConfig = isSupabase ? { rejectUnauthorized: false } : false;

      // 1. First attempt: Direct connection string as provided in DATABASE_URL
      try {
        const primaryPool = new Pool({
          connectionString: pgUrl,
          ssl: sslConfig,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 8000
        });

        await primaryPool.query('SELECT 1');
        pgPool = primaryPool;
        dbType = 'postgres';
        pgDebug = { host: pgConfig.host || 'connectionString', user: pgConfig.user || 'pg', database: pgConfig.database || 'postgres' };
        console.log('⚡ 成功直接连接到云端 PostgreSQL 数据库 (DATABASE_URL)');
      } catch (directErr) {
        console.warn('⚠️ 数据库直连尝试失败:', directErr.message, '尝试应用 Supabase Pooler 智能重写...');

        // 2. Fallback attempt: Apply Supabase Pooler rewrite helper
        const regexMatch = pgUrl.match(/postgres(?:ql)?:\/\/([^:]+):(.*)@([^:/]+):([0-9]+)\/([^?]+)/);
        if (regexMatch) {
          pgConfig.user = regexMatch[1];
          pgConfig.password = regexMatch[2];
          pgConfig.host = regexMatch[3];
          pgConfig.port = regexMatch[4];
          pgConfig.database = regexMatch[5].split('?')[0];
        }

        if (pgConfig.password) {
          try { pgConfig.password = decodeURIComponent(pgConfig.password); } catch {}
        }

        const directMatch = pgConfig.host && pgConfig.host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
        if (directMatch) {
          const projectRef = directMatch[1];
          pgConfig.host = 'aws-1-ap-northeast-2.pooler.supabase.com';
          pgConfig.port = '6543';
          pgConfig.user = `postgres.${projectRef}`;
        }

        if (pgConfig.host === 'aws-0-ap-northeast-2.pooler.supabase.com') {
          pgConfig.host = 'aws-1-ap-northeast-2.pooler.supabase.com';
          pgConfig.port = '6543';
        }

        const servername = pgConfig.host || undefined;
        pgConfig.ssl = isSupabase ? { rejectUnauthorized: false, servername } : false;
        pgConfig.max = 10;
        pgConfig.idleTimeoutMillis = 30000;
        pgConfig.connectionTimeoutMillis = 10000;

        pgDebug = { host: pgConfig.host, port: pgConfig.port, user: pgConfig.user, database: pgConfig.database, sslServername: servername };
        pgPool = new Pool(pgConfig);

        await pgPool.query('SELECT 1');
        dbType = 'postgres';
        console.log('⚡ 通过 Pooler 智能重写成功连接到云端 PostgreSQL 数据库');
      }

      pgPool.on('error', (err) => {
        console.error('⚠️ PG 连接池空闲连接错误 (已自动恢复):', err.message);
      });

      try {
        await pgPool.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') THEN
              CREATE TYPE member_role AS ENUM ('owner', 'editor', 'viewer');
            END IF;
          END$$;

          CREATE TABLE IF NOT EXISTS users (
              id VARCHAR(64) PRIMARY KEY,
              username TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              name TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'user',
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS projects (
              id VARCHAR(64) PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              description TEXT,
              dify_config JSONB DEFAULT '{}'::jsonb,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              created_by VARCHAR(64)
          );

          CREATE TABLE IF NOT EXISTS project_members (
              id VARCHAR(64) PRIMARY KEY,
              project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              role member_role NOT NULL DEFAULT 'viewer',
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              UNIQUE(project_id, user_id)
          );

          CREATE TABLE IF NOT EXISTS versions (
              id VARCHAR(64) PRIMARY KEY,
              project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              version_name TEXT NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              created_by VARCHAR(64),
              UNIQUE(project_id, version_name)
          );

          CREATE TABLE IF NOT EXISTS terms (
              id VARCHAR(64) PRIMARY KEY,
              version_id VARCHAR(64) NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
              kw TEXT NOT NULL,
              context TEXT,
              owner TEXT,
              zh_cn TEXT NOT NULL,
              translations JSONB NOT NULL DEFAULT '{}'::jsonb,
              translations_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              updated_by VARCHAR(64),
              is_locked BOOLEAN DEFAULT FALSE,
              locked_by VARCHAR(64),
              locked_at TIMESTAMP WITH TIME ZONE,
              status TEXT DEFAULT 'DRAFT',
              reject_reason TEXT,
              sort_order INTEGER DEFAULT 0,
              UNIQUE(version_id, kw)
          );

          CREATE TABLE IF NOT EXISTS term_snapshots (
              id VARCHAR(64) PRIMARY KEY,
              term_id VARCHAR(64) NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
              version_id VARCHAR(64) NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
              kw TEXT NOT NULL,
              zh_cn TEXT,
              translations JSONB NOT NULL DEFAULT '{}'::jsonb,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              created_by VARCHAR(64)
          );

          CREATE TABLE IF NOT EXISTS logs (
              id SERIAL PRIMARY KEY,
              timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              kw TEXT,
              chinese TEXT,
              action TEXT NOT NULL,
              details TEXT,
              version_name TEXT,
              user_id VARCHAR(64)
          );

          CREATE TABLE IF NOT EXISTS languages (
              id TEXT PRIMARY KEY,
              project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              lang_code TEXT NOT NULL,
              lang_name TEXT NOT NULL,
              display_order INTEGER DEFAULT 0,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              UNIQUE(project_id, lang_code)
          );

          CREATE TABLE IF NOT EXISTS glossary_tables (
              id VARCHAR(64) PRIMARY KEY,
              project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              table_name TEXT NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              headers TEXT DEFAULT '["中文专业术语","英文翻译对应","说明 / 定义"]'
          );

          CREATE TABLE IF NOT EXISTS glossary_terms (
              id VARCHAR(64) PRIMARY KEY,
              table_id VARCHAR(64) NOT NULL REFERENCES glossary_tables(id) ON DELETE CASCADE,
              cn_term TEXT,
              en_term TEXT,
              description TEXT,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              fields TEXT DEFAULT '{}'
          );

          CREATE TABLE IF NOT EXISTS ai_usage_logs (
              id SERIAL PRIMARY KEY,
              user_id VARCHAR(64),
              project_id VARCHAR(64) NOT NULL,
              term_kw TEXT,
              zh_cn TEXT,
              target_languages TEXT,
              total_tokens INTEGER DEFAULT 0,
              elapsed_time REAL DEFAULT 0,
              status TEXT,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS recycle_bin (
              id VARCHAR(64) PRIMARY KEY,
              entity_type TEXT NOT NULL,
              entity_name TEXT NOT NULL,
              payload JSONB NOT NULL,
              deleted_by VARCHAR(64),
              deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
              expires_at TIMESTAMP WITH TIME ZONE NOT NULL
          );

          INSERT INTO projects (id, name, description)
          VALUES ('proj-default', '迈金智能骑行码表', 'Magene 码表固件词条多人协同翻译项目')
          ON CONFLICT (id) DO NOTHING;

          ALTER TABLE projects ADD COLUMN IF NOT EXISTS dify_config JSONB DEFAULT '{}'::jsonb;
          ALTER TABLE terms ADD COLUMN IF NOT EXISTS translations_meta JSONB NOT NULL DEFAULT '{}'::jsonb;
          ALTER TABLE terms ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
          CREATE INDEX IF NOT EXISTS idx_terms_version_sort ON terms(version_id, sort_order);
          CREATE INDEX IF NOT EXISTS idx_pg_recycle_bin_expires_at ON recycle_bin(expires_at);
        `);
        console.log('✅ 数据库同步完成: Postgres 全量表结构与索引已就绪');
      } catch (err) {
        console.warn('⚠️ 数据库同步警告 (Postgres):', err.message);
      }
    } catch (err) {
      pgError = err.message;
      if (pgPool) {
        try { await pgPool.end(); } catch {}
        pgPool = null;
      }
      const isCloudOrProd = process.env.NODE_ENV === 'production' || 
                            !!process.env.RENDER || 
                            !!process.env.VERCEL || 
                            !!process.env.AWS_LAMBDA_FUNCTION_NAME;
      if (isCloudOrProd) {
        console.error('❌ 云端/生产环境 PostgreSQL 数据库连接失败，严禁降级到临时 SQLite！', err.message);
        throw new Error(`云端 PostgreSQL 数据库连接失败（若使用 Supabase 免费层，可能因长时间无访问进入休眠状态，请前往 Supabase 控制台唤醒）: ${err.message}`);
      }
      console.warn('⚠️ 连接 PostgreSQL 失败，本地开发模式自动切换为 SQLite 数据库:', err.message);
      await initSqlite();
    }
  } else {
    const isCloudOrProd = process.env.NODE_ENV === 'production' || 
                          !!process.env.RENDER || 
                          !!process.env.VERCEL || 
                          !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (isCloudOrProd) {
      console.error('❌ 云端/生产环境缺少 DATABASE_URL 配置，拒绝启动无持久化 SQLite！');
      throw new Error('生产环境未配置 DATABASE_URL 环境变量，无法持久化数据！');
    }
    await initSqlite();
  }
}

// 自动调整历史复制到表且缺少 sort_order 的词条至末尾（如迪卡侬词条中的复制项）
async function fixDecathlonAndCopiedTermsOrder() {
  try {
    const decathlonVer = await db.queryOne(
      dbType === 'postgres'
        ? "SELECT id, version_name FROM versions WHERE version_name ILIKE '%迪卡侬%' OR version_name ILIKE '%decathlon%'"
        : "SELECT id, version_name FROM versions WHERE version_name LIKE '%迪卡侬%' OR version_name LIKE '%decathlon%'"
    );

    if (decathlonVer) {
      const targetChinese = [
        '请在手机端确认',
        '核对数字',
        '配对成功',
        '正在建立安全连接',
        '配对失败',
        '请在手机端继续完成设置',
        '重试'
      ];

      const maxSortRow = await db.queryOne(
        'SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM terms WHERE version_id = $1',
        [decathlonVer.id]
      );
      let maxSort = parseInt(maxSortRow?.max_sort || 0, 10);

      const placeholders = targetChinese.map((_, i) => `$${i + 2}`).join(',');
      const termsToMove = await db.query(
        `SELECT id, zh_cn, sort_order FROM terms WHERE version_id = $1 AND zh_cn IN (${placeholders})`,
        [decathlonVer.id, ...targetChinese]
      );

      if (termsToMove.length > 0) {
        const needsMove = termsToMove.some(t => !t.sort_order || t.sort_order <= 20);
        if (needsMove) {
          console.log(`⚡ 正在将 [${decathlonVer.version_name}] 中的 ${termsToMove.length} 条已复制词条移动至末尾...`);
          const orderMap = {
            '请在手机端确认': 1,
            '核对数字': 2,
            '配对成功': 3,
            '正在建立安全连接': 4,
            '配对失败': 5,
            '请在手机端继续完成设置': 6,
            '重试': 7
          };
          termsToMove.sort((a, b) => (orderMap[a.zh_cn] || 99) - (orderMap[b.zh_cn] || 99));

          for (const term of termsToMove) {
            maxSort++;
            if (dbType === 'postgres') {
              await db.run(
                'UPDATE terms SET sort_order = $1, updated_at = NOW() WHERE id = $2',
                [maxSort, term.id]
              );
            } else {
              await db.run(
                "UPDATE terms SET sort_order = $1, updated_at = datetime('now') WHERE id = $2",
                [maxSort, term.id]
              );
            }
          }
          console.log(`✅ [${decathlonVer.version_name}] 中的词条已成功移动至末尾 (最新 sort_order: ${maxSort})！`);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ 调整复制词条顺序遇到非致命错误:', err.message);
  }
}

function ensureDbInit() {
  if (!dbInitPromise) {
    dbInitPromise = initDatabase()
      .then(async () => {
        dbInitError = null;
        try { await ensureIndexes(); } catch (e) { console.warn('Index error:', e.message); }
        try { await fixDecathlonAndCopiedTermsOrder(); } catch (e) { console.warn('Sort order fix error:', e.message); }
      })
      .catch((err) => {
        dbInitError = err;
        dbInitPromise = null;
        throw err;
      });
  }
  return dbInitPromise;
}

// SQLite 共用单连接: 并发事务的 BEGIN/COMMIT 会在共享连接上交错执行,
// 第一个 COMMIT 会提前终结另一个请求的事务。用 promise 链把事务区间串行化,
// 保证同一时刻只有一个事务在打开状态（本地开发路径）。
let sqliteTxTail = Promise.resolve();
function runSerializedSqliteTx(task) {
  const exec = sqliteTxTail.then(task, task);
  sqliteTxTail = exec.then(() => undefined, () => undefined);
  return exec;
}

// 统一 SQL 驱动接口
const db = {
  async query(sql, params = []) {
    if (dbType === 'postgres') {
      const res = await pgPool.query(sql, params);
      return res.rows;
    } else {
      const sqliteSql = sql.replace(/\$\d+/g, '?');
      return new Promise((resolve, reject) => {
        sqliteDb.all(sqliteSql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      });
    }
  },
  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] || null;
  },
  async run(sql, params = []) {
    if (dbType === 'postgres') {
      const res = await pgPool.query(sql, params);
      return { lastID: null, changes: res.rowCount };
    } else {
      const sqliteSql = sql.replace(/\$\d+/g, '?');
      return new Promise((resolve, reject) => {
        sqliteDb.run(sqliteSql, params, function (err) {
          if (err) return reject(err);
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    }
  },
  async transaction(callback) {
    if (dbType === 'postgres') {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const txDb = {
          async query(sql, params = []) {
            const res = await client.query(sql, params);
            return res.rows;
          },
          async queryOne(sql, params = []) {
            const rows = await this.query(sql, params);
            return rows[0] || null;
          },
          async run(sql, params = []) {
            const res = await client.query(sql, params);
            return { lastID: null, changes: res.rowCount };
          }
        };
        const result = await callback(txDb);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } else {
      return runSerializedSqliteTx(async () => {
        await this.run('BEGIN TRANSACTION');
        try {
          const result = await callback(this);
          await this.run('COMMIT');
          return result;
        } catch (e) {
          try {
            await this.run('ROLLBACK');
          } catch { }
          throw e;
        }
      });
    }
  }
};

const shutdownDatabase = async () => {
  try {
    if (dbType === 'sqlite' && sqliteDb) {
      await new Promise((resolve) => sqliteDb.close(() => resolve()));
      console.log('💾 本地 SQLite 数据库连接已安全释放。');
    } else if (dbType === 'postgres' && pgPool) {
      await pgPool.end();
      console.log('⚡ 云端 PostgreSQL 连接池已安全销毁。');
    }
  } catch (err) {
    console.error('⚠️ 关闭数据库连接时发生错误:', err);
  }
};

module.exports = {
  db,
  ensureDbInit,
  getDbType: () => dbType,
  getDbInitError: () => dbInitError,
  getPgError: () => pgError,
  getPgDebug: () => pgDebug,
  hashPassword,
  verifyPassword,
  shutdownDatabase
};
