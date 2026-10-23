import React, { useState, useEffect, useRef } from 'react';
import GlossaModal from '../GlossaModal';
import { apiFetch } from '../../utils/api';
import { 
  findTranslationForLang, 
  extractExistingTranslations, 
  formatExistingReferenceContext, 
  mergeTranslations 
} from '../../utils/languageHelper';
import { useToast } from '../Toast';
import { Plus, Trash2, Loader2, Sparkles } from 'lucide-react';

export default function BatchAddModal({ open, onClose, selectedTableId, onAddSuccess, targetLanguages = [], _difyConfig = {} }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [preserveExisting, setPreserveExisting] = useState(true);
  const [progress, setProgress] = useState({ total: 0, current: 0, status: '' });
  
  const getEmptyRow = () => {
    const row = {
      id: `new_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      KW: '',
      'CN（中文）': '',
      '所在页面': '',
      '字号类别': ''
    };
    targetLanguages.forEach(lang => {
      row[lang] = '';
    });
    return row;
  };

  const [rows, setRows] = useState(Array.from({ length: 5 }, getEmptyRow));

  // M12: 仅在 open 由 false→true 的边沿重建空行 ——
  // 目标语种是异步加载的，仅挂载时初始化会导致后加载的语种列缺失
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setRows(Array.from({ length: 5 }, getEmptyRow));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const updateRow = (id, field, value) => {
    setRows(rows.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const removeRow = (id) => {
    setRows(rows.filter(r => r.id !== id));
  };

  const addRow = () => {
    setRows([...rows, getEmptyRow()]);
  };

  const saveToBackend = async (rowsToSave) => {
    const addedForSync = rowsToSave.map(r => {
      const { id: _id, ...fields } = r;
      return {
        recordId: `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        fields
      };
    });

    const res = await apiFetch(`/api/tables/${selectedTableId}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ added: addedForSync, updated: [] })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || data.error || '批量新增写入失败');
    }

    toast.success(`成功批量新增 ${addedForSync.length} 条记录`);
    setRows(Array.from({ length: 5 }, getEmptyRow));
    onAddSuccess(addedForSync);
    onClose();
  };

  const handleDirectSave = async () => {
    if (!selectedTableId) {
      toast.error('请先选择一个数据表');
      return;
    }

    const validRows = rows.filter(r => r['CN（中文）']?.trim());
    if (validRows.length === 0) {
      toast.error('没有有效的词条可以保存 (中文不能为空)');
      return;
    }

    setLoading(true);
    try {
      await saveToBackend(validRows);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTranslateAndSave = async () => {
    if (!selectedTableId) {
      toast.error('请先选择一个数据表');
      return;
    }

    const validRows = rows.filter(r => r['CN（中文）']?.trim());
    if (validRows.length === 0) {
      toast.error('没有有效的词条可以翻译');
      return;
    }

    setIsTranslating(true);
    // H6: 先克隆出本地工作副本，循环内绝不直接变异 state 中的行对象；
    // 翻译结果以新对象整体替换（不可变更新）
    const workingRows = rows.map(r => ({ ...r }));
    const targetRows = workingRows.filter(r => r['CN（中文）']?.trim());
    const translatedRows = [];

    // 攒批刷新：每处理 5 条或循环结束时才合并一次 setState，避免逐条触发整表重渲染
    let dirtyCount = 0;
    const flushRows = (force = false) => {
      if (force || dirtyCount >= 5) {
        setRows(workingRows.map(r => ({ ...r })));
        dirtyCount = 0;
      }
    };

    for (let i = 0; i < targetRows.length; i++) {
      const row = targetRows[i];
      setProgress({
        total: targetRows.length,
        current: i + 1,
        status: `正在翻译 (${i + 1}/${targetRows.length}): ${row.KW || row['CN（中文）']}`
      });

      // We only translate if Chinese is provided, otherwise we just keep it
      if (row['CN（中文）']?.trim()) {
        const existingTrans = extractExistingTranslations(row, targetLanguages);
        const existingCount = Object.keys(existingTrans).length;

        // 如果开启保留已有翻译，且本行所有目标语种均已手动填入，则无需调用 AI
        if (preserveExisting && existingCount === targetLanguages.length) {
          translatedRows.push(row);
          continue;
        }

        const missingLangs = preserveExisting
          ? targetLanguages.filter(l => !existingTrans[l])
          : targetLanguages;

        try {
          let contextVal = (row['所在页面'] || '').trim();
          const refSnippet = formatExistingReferenceContext(existingTrans);
          if (refSnippet) {
            contextVal = contextVal ? `${contextVal} (${refSnippet})` : refSnippet;
          }

          const inputs = {
            KW: row.KW || '',
            text: row['CN（中文）'],
            context: contextVal || '无',
            target_languages: (missingLangs.length > 0 ? missingLangs : targetLanguages).join(','),
            existing_translations: existingTrans,
            preserve_existing: preserveExisting
          };

          let res = null;
          let lastErr = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              res = await apiFetch(`/api/projects/proj-default/ai-translate?debug=1`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputs })
              });
              if (res.ok) {
                lastErr = null;
                break;
              }
              const error = await res.json().catch(() => ({}));
              console.error(`🔍 [batch-add] Dify error (attempt ${attempt + 1}):`, error);
              let msg = error.error || '翻译接口失败';
              if (msg.includes('PluginInvokeError') || msg.includes('google/genai')) {
                msg = 'Dify 内部大模型插件异常 (Google GenAI 报错或频率超限)';
              } else if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
                msg = 'AI 模型请求频次超限 (Rate Limit)';
              } else if (msg.includes('timeout') || msg.includes('Timeout')) {
                msg = 'AI 翻译请求超时';
              }
              lastErr = new Error(msg);
            } catch (e) {
              lastErr = e;
            }
            if (attempt === 0) {
              await new Promise(r => setTimeout(r, 1000));
            }
          }

          if (!res || !res.ok) {
            throw lastErr || new Error('翻译失败');
          }
          
          const result = await res.json().catch(() => ({}));

          // 使用 mergeTranslations 保证 preserveExisting 时不纠正/覆盖现存翻译
          const { updatedFields: nextRow } = mergeTranslations({
            currentFields: row,
            aiResult: result,
            targetLanguages,
            preserveExisting
          });

          if (result._source === 'tm') {
            nextRow.tmMatch = true;
          }

          const workingIdx = workingRows.findIndex(r => r.id === nextRow.id);
          if (workingIdx !== -1) workingRows[workingIdx] = nextRow;
          dirtyCount++;
          flushRows();
          translatedRows.push(nextRow);
        } catch (err) {
          console.error(`翻译词条 ${row.KW} 失败:`, err);
          toast.error(`翻译词条「${row.KW || row['CN（中文）']}」失败: ${err.message}`);
          translatedRows.push(row);
        }
        await new Promise(resolve => setTimeout(resolve, 600));
      } else {
        translatedRows.push(row);
      }
    }

    flushRows(true);
    setProgress({ total: targetRows.length, current: targetRows.length, status: '翻译完成，正在写入数据库...' });
    
    try {
      await saveToBackend(translatedRows);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setIsTranslating(false);
      setProgress({ total: 0, current: 0, status: '' });
    }
  };

  if (!open) return null;

  const validCount = rows.filter(r => r['CN（中文）']?.trim()).length;
  const isBusy = loading || isTranslating;

  const gridTemplateColumns = `1.5fr 2fr 1fr 1fr 1.5fr 2fr 40px`;

  return (
    <GlossaModal
      isOpen={true}
      onClose={onClose}
      title="批量新增词条"
      maxWidth="90vw"
      closeDisabled={isBusy}
      footer={
        <>
          <button onClick={onClose} className="btn btn-secondary" disabled={isBusy}>取消</button>
          <button onClick={handleDirectSave} className="btn btn-secondary" disabled={isBusy}>
            {loading ? <><Loader2 size={14} className="animate-spin" /> 保存中...</> : `直接保存 (${validCount}条)`}
          </button>
          <button onClick={handleTranslateAndSave} className="btn btn-primary" disabled={isBusy || targetLanguages.length === 0}>
            {isTranslating ? <><Loader2 size={14} className="animate-spin" /> 翻译并写入中...</> : <><Sparkles size={14} /> 自动翻译并录入 ({validCount}条)</>}
          </button>
        </>
      }
    >
      <div style={{ padding: '0 0.5rem', maxHeight: '70vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.6rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
              * 留空的行在保存时会自动被忽略。至少需要填写中文。
            </p>
            <label 
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}
              title="勾选时默认保留已填语种不予修改，仅补充空白语种；取消勾选将全部覆盖重新翻译"
            >
              <input
                type="checkbox"
                checked={preserveExisting}
                onChange={(e) => setPreserveExisting(e.target.checked)}
                disabled={isBusy}
              />
              <span>保留已有翻译 (不纠正现存语种)</span>
            </label>
          </div>
          {targetLanguages.length === 0 && (
            <div className="alert-box alert-box-warning" style={{ margin: 0, padding: '0.4rem 0.8rem' }}>
              当前表没有检测到目标语言列，AI 翻译功能不可用
            </div>
          )}
        </div>

        {isTranslating && (
          <div className="alert-box alert-box-info" style={{ flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
            <div style={{ fontWeight: '600' }}>{progress.status}</div>
            {progress.total > 0 && (
              <div style={{ width: '100%', height: '6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden', marginTop: '0.25rem' }}>
                <div
                  style={{
                    height: '100%',
                    backgroundColor: 'var(--accent)',
                    width: `${(progress.current / progress.total) * 100}%`,
                    transition: 'width 0.2s'
                  }}
                ></div>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {/* Header */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns, 
            gap: '0.5rem', padding: '0.5rem 0', fontWeight: '500', color: 'var(--text-muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border-color)', position: 'sticky', top: 0, backgroundColor: 'var(--bg-primary)', zIndex: 1 
          }}>
            <div>KW 标识 (选填)</div>
            <div>CN（中文）*</div>
            <div>所在页面</div>
            <div>字号类别</div>
            <div>待翻译语种</div>
            <div>AI 翻译预览</div>
            <div style={{ textAlign: 'center' }}>操作</div>
          </div>

          {/* Rows */}
          {rows.map((row) => (
            <div key={row.id} style={{ display: 'grid', gridTemplateColumns, gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="KW_..."
                className="input-text"
                value={row.KW}
                onChange={(e) => updateRow(row.id, 'KW', e.target.value)}
                disabled={isBusy}
                style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '0.85rem' }}
              />
              <input
                type="text"
                placeholder="中文文本..."
                className="input-text"
                value={row['CN（中文）']}
                onChange={(e) => updateRow(row.id, 'CN（中文）', e.target.value)}
                disabled={isBusy}
                style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '0.85rem' }}
              />
              <input
                type="text"
                placeholder="页面..."
                className="input-text"
                value={row['所在页面']}
                onChange={(e) => updateRow(row.id, '所在页面', e.target.value)}
                disabled={isBusy}
                style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '0.85rem' }}
              />
              <input
                type="text"
                placeholder="类别..."
                className="input-text"
                value={row['字号类别']}
                onChange={(e) => updateRow(row.id, '字号类别', e.target.value)}
                disabled={isBusy}
                style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '0.85rem' }}
              />
              
              <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={targetLanguages.join(', ')}>
                {targetLanguages.join(', ')}
              </div>
              <div style={{ fontSize: '0.75rem', maxHeight: '80px', overflowY: 'auto', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-secondary)' }}>
                {targetLanguages.some(lang => row[lang]) ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {targetLanguages.filter(lang => row[lang]).map(lang => (
                      <div key={lang}>
                        <span style={{ color: 'var(--accent)' }}>{lang}:</span> {row[lang]}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>等待运行...</span>
                )}
              </div>

              <button
                onClick={() => removeRow(row.id)}
                disabled={isBusy || rows.length === 1}
                style={{ 
                  background: 'none', border: 'none', color: rows.length === 1 ? 'var(--text-muted)' : 'var(--red)', 
                  cursor: rows.length === 1 ? 'not-allowed' : 'pointer', padding: '0.2rem', display: 'flex', alignItems: 'center', justifyContent: 'center' 
                }}
                title="删除此行"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}

          {/* Add Row Button */}
          <button
            onClick={addRow}
            disabled={isBusy}
            className="btn btn-secondary btn-sm"
            style={{ alignSelf: 'flex-start', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
          >
            <Plus size={14} /> 增加一行
          </button>
        </div>
      </div>
    </GlossaModal>
  );
}
