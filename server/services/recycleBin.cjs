const crypto = require('crypto');
const { db, getDbType } = require('../config/db.cjs');

async function backupToRecycleBin(entityType, entityId, entityName, userId) {
  let payload = {};
  const dbType = getDbType();

  if (entityType === 'version') {
    const version = await db.queryOne('SELECT * FROM versions WHERE id = $1', [entityId]);
    if (!version) return;
    const terms = await db.query('SELECT * FROM terms WHERE version_id = $1', [entityId]);
    const snapshots = await db.query('SELECT * FROM term_snapshots WHERE version_id = $1', [entityId]);
    payload = { version, terms, snapshots };
  } else if (entityType === 'glossary_table') {
    const glossaryTable = await db.queryOne('SELECT * FROM glossary_tables WHERE id = $1', [entityId]);
    if (!glossaryTable) return;
    const glossaryTerms = await db.query('SELECT * FROM glossary_terms WHERE table_id = $1', [entityId]);
    payload = { glossary_table: glossaryTable, glossary_terms: glossaryTerms };
  } else if (entityType === 'language') {
    const language = await db.queryOne('SELECT * FROM languages WHERE id = $1', [entityId]);
    if (!language) return;

    const langName = language.lang_name;
    const terms = await db.query(
      `SELECT t.id, t.translations, t.translations_meta FROM terms t
       JOIN versions v ON t.version_id = v.id
       WHERE v.project_id = $1`,
      [language.project_id]
    );

    const termTranslations = {};
    for (const t of terms) {
      const trans = typeof t.translations === 'string' ? JSON.parse(t.translations || '{}') : (t.translations || {});
      const meta = typeof t.translations_meta === 'string' ? JSON.parse(t.translations_meta || '{}') : (t.translations_meta || {});
      if (trans[langName] !== undefined || meta[langName] !== undefined) {
        termTranslations[t.id] = {
          translation: trans[langName],
          meta: meta[langName]
        };
      }
    }
    payload = { language, term_translations: termTranslations };
  } else if (entityType === 'term') {
    // 单个词条: 记录完整字段, 恢复时通过 batch-restore 走快照路径
    const term = await db.queryOne('SELECT * FROM terms WHERE id = $1', [entityId]);
    if (!term) return;
    const snapshots = await db.query('SELECT * FROM term_snapshots WHERE term_id = $1', [entityId]);
    payload = { term, snapshots };
  } else {
    throw new Error('Unsupported entity type: ' + entityType);
  }

  const id = crypto.randomUUID();
  const deletedAt = dbType === 'postgres' ? new Date() : new Date().toISOString();

  const expiresAtDate = new Date();
  expiresAtDate.setDate(expiresAtDate.getDate() + 30);
  const expiresAt = dbType === 'postgres' ? expiresAtDate : expiresAtDate.toISOString();

  const payloadStr = JSON.stringify(payload);
  if (dbType === 'postgres') {
    await db.run(
      `INSERT INTO recycle_bin (id, entity_type, entity_name, payload, deleted_by, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [id, entityType, entityName, payloadStr, userId, deletedAt, expiresAt]
    );
  } else {
    await db.run(
      `INSERT INTO recycle_bin (id, entity_type, entity_name, payload, deleted_by, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, entityType, entityName, payloadStr, userId, deletedAt, expiresAt]
    );
  }
}

// 批量写入 recycle_bin（多行 VALUES 单条 INSERT）。
// executor 传入事务执行器（tx）可保证备份与硬删同事务原子提交。
// rows: [{ id, entityType, entityName, payloadJson }]
async function bulkInsertToRecycleBin(executor, rows, userId) {
  if (!rows || rows.length === 0) return;
  const dbType = getDbType();

  const deletedAt = dbType === 'postgres' ? new Date() : new Date().toISOString();
  const expiresAtDate = new Date();
  expiresAtDate.setDate(expiresAtDate.getDate() + 30);
  const expiresAt = dbType === 'postgres' ? expiresAtDate : expiresAtDate.toISOString();

  const valuesClauses = [];
  const params = [];
  rows.forEach((row, i) => {
    const b = i * 7;
    const payloadPh = dbType === 'postgres' ? `$${b + 4}::jsonb` : `$${b + 4}`;
    valuesClauses.push(`($${b + 1}, $${b + 2}, $${b + 3}, ${payloadPh}, $${b + 5}, $${b + 6}, $${b + 7})`);
    params.push(row.id, row.entityType, row.entityName, row.payloadJson, userId, deletedAt, expiresAt);
  });

  await executor.run(
    `INSERT INTO recycle_bin (id, entity_type, entity_name, payload, deleted_by, deleted_at, expires_at)
     VALUES ${valuesClauses.join(', ')}`,
    params
  );
}

module.exports = {
  backupToRecycleBin,
  bulkInsertToRecycleBin
};
