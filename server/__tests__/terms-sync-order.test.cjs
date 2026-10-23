const request = require('supertest');
const app = require('../app.cjs');
const { ensureDbInit, db, getDbType } = require('../config/db.cjs');

describe('Terms Sync Order & CSV Import Ordering (/api/tables/:tableId/sync)', () => {
  let adminToken = '';
  const testVersionId = 'ver-order-' + Date.now();
  const existingTerm1Id = 'term-ord-1-' + Date.now();
  const existingTerm2Id = 'term-ord-2-' + Date.now();
  const existingTerm3Id = 'term-ord-3-' + Date.now();

  beforeAll(async () => {
    await ensureDbInit();

    // Login as admin
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'wangzhaoyun', password: 'magene123' });
    adminToken = adminRes.body.token;

    // Create test version
    const nowExpr = getDbType() === 'postgres' ? 'NOW()' : "datetime('now')";
    const testVersionName = '排序测试表_' + Date.now();
    await db.run(
      `INSERT INTO versions (id, project_id, version_name, created_at) VALUES ($1, 'proj-default', $2, ${nowExpr})`,
      [testVersionId, testVersionName]
    );

    // Seed 3 existing terms with initial sort_orders: 10, 20, 30
    await db.run(
      `INSERT OR IGNORE INTO terms (id, version_id, kw, context, owner, zh_cn, translations, translations_meta, sort_order, created_at, updated_at, is_locked)
       VALUES ($1, $2, 'KW_INITIAL_A', '页面A', '王赵云', '苹果', '{"EN（英文）":"Apple"}', '{}', 10, ${nowExpr}, ${nowExpr}, 0)`,
      [existingTerm1Id, testVersionId]
    );

    await db.run(
      `INSERT OR IGNORE INTO terms (id, version_id, kw, context, owner, zh_cn, translations, translations_meta, sort_order, created_at, updated_at, is_locked)
       VALUES ($1, $2, 'KW_INITIAL_B', '页面B', '王赵云', '香蕉', '{"EN（英文）":"Banana"}', '{}', 20, ${nowExpr}, ${nowExpr}, 0)`,
      [existingTerm2Id, testVersionId]
    );

    await db.run(
      `INSERT OR IGNORE INTO terms (id, version_id, kw, context, owner, zh_cn, translations, translations_meta, sort_order, created_at, updated_at, is_locked)
       VALUES ($1, $2, 'KW_INITIAL_C', '页面C', '王赵云', '橙子', '{"EN（英文）":"Orange"}', '{}', 30, ${nowExpr}, ${nowExpr}, 0)`,
      [existingTerm3Id, testVersionId]
    );
  });

  it('should update sort_order when syncing modified terms with explicit sortOrder', async () => {
    // Term B was 20, now user moves it to row 1 (sortOrder: 1)
    const res = await request(app)
      .post(`/api/tables/${testVersionId}/sync`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        updated: [
          {
            recordId: existingTerm2Id,
            fields: {
              'KW': 'KW_INITIAL_B',
              'CN（中文）': '香蕉(更新)',
              'EN（英文）': 'Banana (Updated)'
            },
            sortOrder: 1
          }
        ]
      });

    expect(res.status).toBe(200);

    const termB = await db.queryOne('SELECT sort_order, zh_cn FROM terms WHERE id = $1', [existingTerm2Id]);
    expect(termB.sort_order).toBe(1);
    expect(termB.zh_cn).toBe('香蕉(更新)');
  });

  it('should apply sort_order to newly added terms and reordered terms', async () => {
    // Simulating a CSV import where order is:
    // 1. New Term X (sortOrder: 1)
    // 2. Existing Term B (sortOrder: 2, modified)
    // 3. Existing Term A (sortOrder: 3, unchanged -> reorder)
    // 4. Existing Term C (sortOrder: 4, removed from CSV -> pushed to end)
    const newTermXId = 'rec_new_x_' + Date.now();

    const res = await request(app)
      .post(`/api/tables/${testVersionId}/sync`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        added: [
          {
            recordId: newTermXId,
            fields: {
              'KW': 'KW_NEW_X',
              'CN（中文）': '西瓜',
              'EN（英文）': 'Watermelon'
            },
            sortOrder: 1
          }
        ],
        updated: [
          {
            recordId: existingTerm2Id,
            fields: {
              'KW': 'KW_INITIAL_B',
              'CN（中文）': '香蕉(最终)',
              'EN（英文）': 'Banana'
            },
            sortOrder: 2
          }
        ],
        reorder: [
          {
            recordId: existingTerm1Id,
            sortOrder: 3
          },
          {
            recordId: existingTerm3Id,
            sortOrder: 4
          }
        ]
      });

    expect(res.status).toBe(200);

    // Fetch records via GET endpoint to ensure sort_order ASC is obeyed
    const listRes = await request(app)
      .get(`/api/tables/${testVersionId}/records`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    const records = listRes.body.records;
    expect(records.length).toBe(4);

    // Exact CSV order: X (1), B (2), A (3), C (4)
    expect(records[0].id).toBe(newTermXId);
    expect(records[0].sort_order).toBe(1);

    expect(records[1].id).toBe(existingTerm2Id);
    expect(records[1].sort_order).toBe(2);

    expect(records[2].id).toBe(existingTerm1Id);
    expect(records[2].sort_order).toBe(3);

    expect(records[3].id).toBe(existingTerm3Id);
    expect(records[3].sort_order).toBe(4);
  });
});
