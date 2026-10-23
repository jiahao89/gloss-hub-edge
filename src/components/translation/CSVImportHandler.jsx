import React, { useState, useRef } from 'react';
import { useToast } from '../Toast';
import GlossaModal from '../GlossaModal';
import { parseCSV, fuzzyFindIndex } from '../../utils/csvHelper';
import { apiFetch } from '../../utils/api';
import { Upload } from 'lucide-react';

const fuzzyKeywords = ['中文', 'CN', '汉语', 'Chinese'];

export default function CSVImportHandler({ selectedTableId, currentRecords, targetLanguages = [], onImportComplete, disabled }) {
  const toast = useToast();
  const fileInputRef = useRef(null);
  const [importDiff, setImportDiff] = useState(null); // { added: [], modified: [], unchanged: [], removed: [], csvRecords: [] }
  const [importPreviewOpen, setImportPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleTriggerImport = () => {
    fileInputRef.current?.click();
  };

  const handleCsvImportSelected = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const text = e.target.result;
        const parsedRows = parseCSV(text);
        if (parsedRows.length === 0) {
          toast.error('CSV 文件中没有有效数据！');
          return;
        }

        const headers = parsedRows[0];
        const rows = parsedRows.slice(1);

        if (rows.length === 0) {
          toast.error('CSV 文件中没有有效数据！');
          return;
        }

        // --- Column Mapping ---
        const colMap = [];

        const kwIdx = fuzzyFindIndex(headers, ['KW', 'KeyWord', '键名', '标识'], ['kw', 'key']);
        const zhIdx = fuzzyFindIndex(headers, ['CN（中文）', '中文', 'CN', 'Chinese', '源文本'], fuzzyKeywords);
        const pageIdx = fuzzyFindIndex(headers, ['所在页面', '页面', '所属界面', '界面'], ['页面', '界面', 'page']);
        const typeIdx = fuzzyFindIndex(headers, ['字号类别', '类别', '字号'], ['字号', '类别', 'type']);

        if (kwIdx === -1 && zhIdx === -1) {
          toast.error('CSV 结构非法：必须包含 "KW" 或 "CN（中文）" 列！');
          return;
        }

        if (kwIdx !== -1) colMap.push({ idx: kwIdx, fieldName: 'KW' });
        if (zhIdx !== -1) colMap.push({ idx: zhIdx, fieldName: 'CN（中文）' });
        if (pageIdx !== -1) colMap.push({ idx: pageIdx, fieldName: '所在页面' });
        if (typeIdx !== -1) colMap.push({ idx: typeIdx, fieldName: '字号类别' });

        targetLanguages.forEach(lang => {
          let fuzzyKeys = [lang.toLowerCase()];
          const match = lang.match(/([a-zA-Z]+)[（(](.+)[)）]/);
          if (match) {
            fuzzyKeys = [match[1].toLowerCase(), match[2].toLowerCase()];
          }
          const csvLangIdx = fuzzyFindIndex(headers, [lang], fuzzyKeys);
          if (csvLangIdx !== -1) {
            colMap.push({ idx: csvLangIdx, fieldName: lang });
          }
        });

        // --- Build CSV Objects ---
        const validCsvRecords = [];
        let orderCounter = 1;
        rows.forEach((row, ridx) => {
          const fields = {};
          colMap.forEach(({ idx, fieldName }) => {
            if (row[idx] !== undefined) fields[fieldName] = row[idx];
          });
          const kw = (fields['KW'] || '').trim();
          const zh = (fields['CN（中文）'] || '').trim();
          if (kw || zh) {
            validCsvRecords.push({
              recordId: `csv-import-${ridx}`,
              fields,
              kw,
              csvOrder: orderCounter++,
            });
          }
        });
        const csvRecords = validCsvRecords;

        if (csvRecords.length === 0) {
          toast.error('CSV 文件中没有有效的数据！');
          return;
        }

        // --- Fetch Full Database Records for Accurate Diffing ---
        // M3: 服务端分页上限固定 —— 改为循环翻页拉全（每页 500，按 total 终止，200 页上限防死循环）
        let allCurrentRecords = currentRecords || [];
        if (selectedTableId) {
          try {
            const PAGE_SIZE = 500;
            const MAX_PAGES = 200;
            const fetched = [];
            let page = 1;
            let total = Infinity;
            while (page <= MAX_PAGES && fetched.length < total) {
              const fetchRes = await apiFetch(`/api/tables/${selectedTableId}/records?page=${page}&pageSize=${PAGE_SIZE}`);
              if (!fetchRes.ok) break;
              const fullData = await fetchRes.json();
              if (fullData && Array.isArray(fullData.records)) {
                fetched.push(...fullData.records);
                if (typeof fullData.total === 'number') total = fullData.total;
                if (fullData.records.length < PAGE_SIZE) break;
              } else if (Array.isArray(fullData)) {
                // 兼容旧版 API 直接返回数组的形态
                fetched.push(...fullData);
                break;
              } else {
                break;
              }
              page += 1;
            }
            if (fetched.length > 0) {
              allCurrentRecords = fetched;
            }
          } catch (fetchErr) {
            console.warn('全量拉取数据表词条失败，降级使用当前页数据比对:', fetchErr);
          }
        }

        // --- Diffing against Current Records ---
        const currentByKw = {};
        const currentByZh = {};
        allCurrentRecords.forEach(rec => {
          const kw = (rec.fields?.['KW'] || rec.kw || '').trim();
          const zh = (rec.fields?.['CN（中文）'] || rec.zh_cn || '').trim();
          if (kw && !kw.startsWith('__EMPTY_KW_')) currentByKw[kw.toLowerCase()] = rec;
          if (zh) currentByZh[zh] = rec;
        });

        const added = [];
        const modified = [];
        const unchanged = [];
        const matchedRecordIds = new Set();

        csvRecords.forEach(csvRec => {
          const csvKw = (csvRec.kw || '').toLowerCase();
          const csvZh = (csvRec.fields?.['CN（中文）'] || '').trim();
          let existing = csvKw ? currentByKw[csvKw] : null;
          if (!existing && csvZh) {
            existing = currentByZh[csvZh];
          }

          if (!existing) {
            added.push(csvRec);
          } else {
            const existingId = existing.id || existing.recordId;
            if (existingId) matchedRecordIds.add(existingId);
            if (csvKw) delete currentByKw[csvKw];
            const existingKw = (existing.fields?.['KW'] || existing.kw || '').trim().toLowerCase();
            if (existingKw && !existingKw.startsWith('__empty_kw_')) {
              delete currentByKw[existingKw];
            }
            const existingZh = (existing.fields?.['CN（中文）'] || existing.zh_cn || '').trim();
            if (existingZh) {
              delete currentByZh[existingZh];
            }

            const changes = {};
            const allFields = ['KW', 'CN（中文）', ...targetLanguages];
            allFields.forEach(field => {
              const csvVal = (csvRec.fields[field] || '').trim();
              const curVal = (existing.fields?.[field] || '').trim();
              if (csvVal !== curVal) {
                changes[field] = { old: curVal, new: csvVal };
              }
            });
            if (Object.keys(changes).length > 0) {
              modified.push({ ...csvRec, existingRecord: existing, changes });
            } else {
              unchanged.push({ ...csvRec, existingRecord: existing });
            }
          }
        });

        const removed = allCurrentRecords.filter(rec => {
          const id = rec.id || rec.recordId;
          return id && !matchedRecordIds.has(id);
        });

        const orderChanged = unchanged.some(rec => {
          const curSort = rec.existingRecord?.sort_order ?? rec.existingRecord?.sortOrder;
          return curSort !== rec.csvOrder;
        });

        if (added.length === 0 && modified.length === 0 && !orderChanged) {
          toast.info(`没有检测到变化（${unchanged.length} 条一致，${removed.length} 条不在CSV中）`);
          return;
        }

        setImportDiff({ added, modified, unchanged, removed, csvRecords, orderChanged });
        setImportPreviewOpen(true);
      } catch (err) {
        toast.error(`解析 CSV 失败: ${err.message}`);
      } finally {
        setLoading(false);
        event.target.value = '';
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleConfirmImport = async () => {
    if (!importDiff || !selectedTableId) return;

    try {
      setLoading(true);

      const csvMaxSort = importDiff.csvRecords.length;

      const addedForSync = importDiff.added.map(rec => {
        const newRecordId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        return {
          recordId: newRecordId,
          fields: rec.fields,
          sortOrder: rec.csvOrder ?? csvMaxSort
        };
      });

      const updatedForSync = importDiff.modified.map(rec => {
        const existingRecordId = rec.existingRecord.id || rec.existingRecord.recordId;
        const newFields = { ...rec.existingRecord.fields };
        Object.entries(rec.changes).forEach(([field, { new: newVal }]) => {
          newFields[field] = newVal;
        });
        return {
          recordId: existingRecordId,
          fields: newFields,
          sortOrder: rec.csvOrder ?? csvMaxSort
        };
      });

      // Reorder unchanged records to match CSV positions
      // And place removed records (existing records not in CSV) after all CSV records
      const reorderForSync = [
        ...importDiff.unchanged.map(rec => {
          const existingRecordId = rec.existingRecord?.id || rec.existingRecord?.recordId || rec.recordId;
          return {
            recordId: existingRecordId,
            sortOrder: rec.csvOrder ?? csvMaxSort
          };
        }),
        ...(importDiff.removed || []).map((rec, idx) => {
          const existingRecordId = rec.id || rec.recordId;
          return {
            recordId: existingRecordId,
            sortOrder: csvMaxSort + 1 + idx
          };
        })
      ].filter(r => r.recordId && r.sortOrder !== undefined);

      const res = await apiFetch(`/api/tables/${selectedTableId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          added: addedForSync,
          updated: updatedForSync,
          reorder: reorderForSync
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '批量同步失败');
      }

      toast.success(`导入成功！新增 ${addedForSync.length} 条，更新 ${updatedForSync.length} 条，已按 CSV 顺序排列。`);
      setImportPreviewOpen(false);
      setImportDiff(null);
      
      if (onImportComplete) {
        onImportComplete({ added: addedForSync, updated: updatedForSync, reorder: reorderForSync });
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button 
        onClick={handleTriggerImport} 
        className="heroui-btn" 
        title="导入 CSV"
        disabled={disabled || loading}
      >
        <Upload size={14} />
        <span>导入 CSV</span>
      </button>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleCsvImportSelected}
        accept=".csv"
      />

      {importPreviewOpen && importDiff && (
        <GlossaModal
          isOpen={true}
          onClose={() => setImportPreviewOpen(false)}
          title="CSV 导入预览"
          maxWidth="900px"
          closeDisabled={loading}
          footer={
            <>
              <button onClick={() => setImportPreviewOpen(false)} className="btn btn-secondary" disabled={loading}>取消</button>
              <button onClick={handleConfirmImport} className="btn btn-primary" disabled={loading}>
                {loading ? '正在导入...' : (
                  importDiff.added.length === 0 && importDiff.modified.length === 0
                    ? `确认按 CSV 顺序排列 (${importDiff.unchanged.length} 条)`
                    : `确认导入 (新增 ${importDiff.added.length}, 修改 ${importDiff.modified.length})`
                )}
              </button>
            </>
          }
        >
          <div style={{ marginBottom: '1rem', padding: '0.8rem', background: 'var(--bg-panel)', borderRadius: '6px' }}>
            <div style={{ display: 'flex', gap: '2rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <div><strong>新增词条：</strong> <span style={{ color: 'var(--green)' }}>{importDiff.added.length} 条</span></div>
              <div><strong>修改词条：</strong> <span style={{ color: 'var(--blue)' }}>{importDiff.modified.length} 条</span></div>
              <div><strong>无变化：</strong> <span style={{ color: 'var(--text-muted)' }}>{importDiff.unchanged.length} 条</span></div>
              {importDiff.orderChanged && <div><strong>顺序更新：</strong> <span style={{ color: 'var(--blue)' }}>按 CSV 文件顺序</span></div>}
              {importDiff.removed.length > 0 && <span style={{ color: 'var(--red)' }}>CSV外 {importDiff.removed.length} 条 (不受影响，排在最后)</span>}
            </div>

            {importDiff.added.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <h4 style={{ color: 'var(--green)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>新增词条</h4>
                {importDiff.added.slice(0, 10).map((rec, i) => (
                  <div key={`add-${i}`} style={{ background: 'var(--green-bg)', border: '1px solid var(--green)', borderRadius: '4px', padding: '0.4rem 0.6rem', marginBottom: '0.3rem', fontSize: '0.8rem' }}>
                    <strong>{rec.kw}</strong> - {rec.fields['CN（中文）'] || ''}
                  </div>
                ))}
                {importDiff.added.length > 10 && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>... 等共 {importDiff.added.length} 条</div>}
              </div>
            )}

            {importDiff.modified.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <h4 style={{ color: 'var(--blue)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>修改词条</h4>
                {importDiff.modified.slice(0, 10).map((rec, i) => (
                  <div key={`mod-${i}`} style={{ background: 'var(--blue-bg)', border: '1px solid var(--blue)', borderRadius: '4px', padding: '0.4rem 0.6rem', marginBottom: '0.3rem', fontSize: '0.8rem' }}>
                    <strong>{rec.kw}</strong> - {rec.fields['CN（中文）'] || ''}
                    <div style={{ marginTop: '0.3rem', paddingLeft: '0.5rem', borderLeft: '2px solid var(--blue)' }}>
                      {Object.entries(rec.changes).map(([field, diff]) => (
                        <div key={field}>
                          <span style={{ color: 'var(--text-muted)' }}>{field}:</span>{' '}
                          <span style={{ color: 'var(--red)', textDecoration: 'line-through' }}>{diff.old || '(空)'}</span>
                          {' -> '}
                          <span style={{ color: 'var(--green)' }}>{diff.new || '(空)'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {importDiff.modified.length > 10 && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>... 等共 {importDiff.modified.length} 条</div>}
              </div>
            )}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
              注：CSV 中不存在的词条（{importDiff.removed.length}条）将保持原样，不会被删除。
            </div>
          </div>
        </GlossaModal>
      )}
    </>
  );
}
