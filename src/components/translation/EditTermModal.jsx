import React, { useState, useEffect, useRef } from 'react';
import GlossaModal from '../GlossaModal';
import { Sparkles, Loader2, History, GitBranch, RotateCcw, Eraser, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../utils/api';
import { 
  findTranslationForLang, 
  extractExistingTranslations, 
  formatExistingReferenceContext, 
  mergeTranslations 
} from '../../utils/languageHelper';
import { useToast } from '../Toast';

// ============================================================
// EditTermModal — 编辑单条词条
//
// 之前 v1.1 时期 TranslationTab.jsx 里有这个模态框的 inline 实现 (含"生成
// KW"按钮), 但后续 v1.2 重构时整个 inline 模态框被删除, 只剩
// `setEditModalRecord(rec)` 调用 — 编辑按钮无响应。
//
// 本组件:
//   1. 编辑现有词条 (PUT /api/terms/:id)
//   2. 提供"生成 KW"按钮 — 调用 /api/projects/:id/generate-kw
//   3. 字段与 AddTermModal 保持一致 (KW/CN/所在页面/字号类别 + 目标语言列)
//
// 用法：
//   <EditTermModal
//     open={!!editModalRecord}
////     record={editModalRecord}
//     projectId={projectId}
//     targetLanguages={TARGET_LANGUAGES}
//     fieldMap={fieldMap}
//     getRecordValue={getRecordValue}
//     onClose={() => setEditModalRecord(null)}
//     onSaveSuccess={() => loadTableData(selectedTableId)}
//   />
// ============================================================

export default function EditTermModal({
  open,
  record,
  projectId = 'proj-default',
  targetLanguages = [],
  fieldMap = {},
  getRecordValue,
  currentUserRole = '',
  projectRole = 'viewer',
  onClose,
  onSaveSuccess
}) {
  const toast = useToast();
  const [fields, setFields] = useState({});
  const [loading, setLoading] = useState(false);
  const [generatingKw, setGeneratingKw] = useState(false);
  const [retranslating, setRetranslating] = useState(false);
  const [preserveExisting, setPreserveExisting] = useState(true);

  // Right-side tab: 'tm' (跨版本参考) | 'history' (修改历史快照)
  // v1.2 重构后此功能丢失 — 现在恢复
  const [rightTab, setRightTab] = useState('tm');
  const [tmReferences, setTmReferences] = useState([]);
  const [loadingTm, setLoadingTm] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [rollingBackId, setRollingBackId] = useState('');

  // Refs so useEffect below can read latest values without re-running
  // on every parent re-render (which would cause OOM from setState loop).
  const fieldMapRef = useRef(fieldMap);
  const getRecordValueRef = useRef(getRecordValue);
  const targetLanguagesRef = useRef(targetLanguages);
  useEffect(() => { fieldMapRef.current = fieldMap; }, [fieldMap]);
  useEffect(() => { getRecordValueRef.current = getRecordValue; }, [getRecordValue]);
  useEffect(() => { targetLanguagesRef.current = targetLanguages; }, [targetLanguages]);

  // Re-init fields only when a different record is opened
  useEffect(() => {
    if (!record) {
      setFields({});
      return;
    }
    const init = {};
    const allFieldNames = new Set([
      'KW',
      'CN（中文）',
      '所在页面',
      '字号类别',
      ...targetLanguagesRef.current,
    ]);
    for (const name of allFieldNames) {
      const fId = fieldMapRef.current[name];
      if (fId) {
        init[name] = getRecordValueRef.current
          ? (getRecordValueRef.current(record, fId) || '')
          : '';
      } else if (record.fields) {
        init[name] = record.fields[name] || '';
      } else {
        init[name] = '';
      }
    }
    setFields(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record]);

  const handleFieldChange = (field, value) => {
    setFields(prev => ({ ...prev, [field]: value }));
  };

  const handleGenerateKw = async () => {
    const cn = (fields['CN（中文）'] || '').trim();
    const en = (fields['EN（英文）'] || fields['EN'] || '').trim();
    const context = (fields['所在页面'] || '').trim();
    if (!cn && !en) {
      toast.error('请先填写 CN（中文）源文本或参考英文');
      return;
    }
    setGeneratingKw(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/generate-kw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cn, enText: en, context }),
      timeoutMs: 45000,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'KW 生成失败');
      }
      const data = await res.json();
      if (data.kw) {
        setFields(prev => ({ ...prev, KW: data.kw }));
        toast.success(`KW 自动生成成功: ${data.kw}`);
      } else {
        toast.error('生成结果为空，请手动填写');
      }
    } catch (err) {
      toast.error(err.message || '生成 KW 失败');
    } finally {
      setGeneratingKw(false);
    }
  };

  // 清空翻译：删除中文外的其他语种（仅清空表单, 需保存才生效）
  const handleClearTranslations = () => {
    const langs = targetLanguagesRef.current;
    if (langs.length === 0) return;
    if (!window.confirm('确定要清空全部目标语言的翻译吗？\n仅清空表单内容，点击「保存修改」后才会生效，也可取消不保存。')) {
      return;
    }
    setFields(prev => {
      const next = { ...prev };
      langs.forEach(lang => { next[lang] = ''; });
      return next;
    });
    toast.success('已清空翻译，点击「保存修改」确认');
  };

  // 重新翻译：调用 AI 翻译接口, 更新词条翻译（默认保留已有翻译不予纠正，仅写入表单, 需保存才生效）
  const handleRetranslate = async () => {
    const cn = (fields['CN（中文）'] || '').trim();
    if (!cn) {
      toast.error('请先填写 CN（中文）源文本再重新翻译');
      return;
    }
    const langs = targetLanguagesRef.current;
    if (langs.length === 0) {
      toast.error('暂无目标语言');
      return;
    }

    const existingTrans = extractExistingTranslations(fields, langs);
    const existingCount = Object.keys(existingTrans).length;

    // 如果开启保留已有翻译（默认），且所有语言均已存在翻译，提醒用户取消勾选才能全部覆盖重新翻译
    if (preserveExisting && existingCount === langs.length) {
      toast.info('当前所有语种均已有翻译。若需全部覆盖重新翻译，请取消勾选“保留已有翻译”');
      return;
    }

    const missingLangs = preserveExisting
      ? langs.filter(l => !existingTrans[l])
      : langs;

    setRetranslating(true);
    try {
      let contextVal = (fields['所在页面'] || '').trim();
      const refSnippet = formatExistingReferenceContext(existingTrans);
      if (refSnippet) {
        contextVal = contextVal ? `${contextVal} (${refSnippet})` : refSnippet;
      }

      const inputs = {
        KW: (fields.KW || '').trim(),
        text: cn,
        context: contextVal || '无',
        target_languages: (missingLangs.length > 0 ? missingLangs : langs).join(','),
        existing_translations: existingTrans,
        preserve_existing: preserveExisting,
      };
      const res = await apiFetch(`/api/projects/${projectId}/ai-translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      timeoutMs: 110000,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '翻译接口失败');
      }
      const result = await res.json().catch(() => ({}));
      const { updatedFields, changedCount, preservedCount } = mergeTranslations({
        currentFields: fields,
        aiResult: result,
        targetLanguages: langs,
        preserveExisting
      });

      if (changedCount === 0) {
        toast.error('AI 未返回有效翻译结果，请稍后重试');
        return;
      }
      setFields(updatedFields);
      const successMsg = preservedCount > 0
        ? `翻译完成，已补充 ${changedCount} 个语种，已保留 ${preservedCount} 个现存翻译，点击「保存修改」确认`
        : `重新翻译完成，已更新 ${changedCount} 个语种，点击「保存修改」确认`;
      toast.success(successMsg);
    } catch (err) {
      toast.error(err.message || '重新翻译失败');
    } finally {
      setRetranslating(false);
    }
  };

  const handleSave = async () => {
    if (!record) return;
    if (!fields.KW?.trim() && !fields['CN（中文）']?.trim()) {
      toast.error('KW 或 CN（中文）不能同时为空');
      return;
    }
    setLoading(true);
    try {
      const termId = record.recordId || record.id;
      // 把 fields 拆成 server 期望的 { kw, context, owner, zh_cn, translations, translationsMeta, oldUpdatedAt }
      const translations = {};
      const baseMeta = record.translationsMeta || record.translations_meta || {};
      const translationsMeta = { ...(typeof baseMeta === 'string' ? JSON.parse(baseMeta || '{}') : baseMeta) };
      for (const lang of targetLanguagesRef.current) {
        const val = fields[lang] || '';
        translations[lang] = val;
        if (!val.trim()) {
          delete translationsMeta[lang];
        }
      }
      const res = await apiFetch(`/api/terms/${termId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kw: fields.KW,
          context: fields['所在页面'] ?? '',
          owner: fields['字号类别'] ?? '',
          zh_cn: fields['CN（中文）'] ?? '',
          translations,
          translationsMeta,
          // Optimistic locking — server-side `oldUpdatedAt` parameter name,
          // value is the record's last-known updatedAt from the fetch.
          oldUpdatedAt: record.updatedAt || record.updated_at,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '保存失败');
      }
      toast.success('词条已更新');
      if (onSaveSuccess) onSaveSuccess();
      onClose();
    } catch (err) {
      toast.error(err.message || '保存异常');
    } finally {
      setLoading(false);
    }
  };

  // 跨版本翻译参考 (TM) — 加载同项目其他表里同一个 KW 的翻译
  const loadTmReferences = async () => {
    const kw = (fields.KW || record?.kw || '').trim();
    if (!kw) {
      toast.error('KW 为空,无法查找跨版本参考');
      return;
    }
    setLoadingTm(true);
    try {
      const versionId = record.versionId || record.version_id || '';
      const url = versionId
        ? `/api/versions/${versionId}/terms/${encodeURIComponent(kw)}/references`
        : null;
      if (!url) {
        // 没有 versionId 时, 没法查 TM
        setTmReferences([]);
        return;
      }
      const res = await apiFetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '加载跨版本参考失败');
      }
      const data = await res.json();
      setTmReferences(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(err.message || '加载跨版本参考失败');
      setTmReferences([]);
    } finally {
      setLoadingTm(false);
    }
  };

  // 修改历史快照
  const loadSnapshots = async () => {
    const termId = record.recordId || record.id;
    if (!termId) return;
    setLoadingSnapshots(true);
    try {
      const res = await apiFetch(`/api/terms/${termId}/snapshots`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '加载历史快照失败');
      }
      const data = await res.json();
      setSnapshots(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(err.message || '加载历史快照失败');
      setSnapshots([]);
    } finally {
      setLoadingSnapshots(false);
    }
  };

  // 回退到指定快照
  const handleRollback = async (snapshotId) => {
    if (!window.confirm('确定要回退到此历史快照吗？\n当前未保存的编辑会丢失, 但快照本身也会创建一条新快照作为回退点。')) {
      return;
    }
    const termId = record.recordId || record.id;
    setRollingBackId(snapshotId);
    try {
      const res = await apiFetch(`/api/terms/${termId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '回退失败');
      }
      toast.success('已回退到该历史快照');
      // Reload snapshots + propagate new fields back to caller
      await loadSnapshots();
      if (onSaveSuccess) onSaveSuccess();
    } catch (err) {
      toast.error(err.message || '回退失败');
    } finally {
      setRollingBackId('');
    }
  };

  // 切换右侧 tab 时按需加载
  useEffect(() => {
    if (!open || !record) return;
    if (rightTab === 'tm' && tmReferences.length === 0 && !loadingTm) {
      loadTmReferences();
    } else if (rightTab === 'history' && snapshots.length === 0 && !loadingSnapshots) {
      loadSnapshots();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightTab, open, record]);

  if (!open || !record) return null;

  const isLocked = record.isLocked === 1 || record.isLocked === true;
  const canManageLock = currentUserRole === 'admin' || projectRole === 'owner';
  const canWrite = projectRole === 'owner' || projectRole === 'editor' || currentUserRole === 'admin';
  const inputsDisabled = loading || (isLocked && !canManageLock);
  const transToolsDisabled = inputsDisabled || !canWrite || retranslating;

  return (
    <GlossaModal
      isOpen={true}
      onClose={onClose}
      title={isLocked ? '查看词条 (已锁定)' : '编辑词条'}
      maxWidth="1100px"
      closeDisabled={loading}
      footer={
        <>
          <button onClick={onClose} className="btn btn-secondary" disabled={loading}>
            取消
          </button>
          <button onClick={handleSave} className="btn btn-primary" disabled={loading || inputsDisabled}>
            {loading ? '保存中...' : '保存修改'}
          </button>
        </>
      }
    >
      <div className="edit-term-modal-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: '1rem', padding: '0.5rem 0', minHeight: '420px' }}>
        {/* 左侧: 编辑表单 */}
        <div className="edit-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', alignContent: 'start' }}>
        {/* KW + 生成按钮 */}
        <div className="form-group" style={{ gridColumn: 'span 2' }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
            <span>KW 标识 (例如: KW_AVG_CADENCE)</span>
            {!inputsDisabled && (
              <button
                type="button"
                onClick={handleGenerateKw}
                disabled={generatingKw}
                className="btn-text"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  fontSize: '0.78rem',
                  color: 'var(--accent)',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '4px',
                }}
                title="根据中文语义生成 KW 键名"
              >
                {generatingKw ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                <span>{generatingKw ? '生成中...' : '生成 KW'}</span>
              </button>
            )}
          </label>
          <input
            type="text"
            value={fields['KW'] || ''}
            onChange={(e) => handleFieldChange('KW', e.target.value)}
            disabled={inputsDisabled}
            placeholder="请输入 KW..."
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
          />
        </div>

        {/* CN（中文） */}
        <div className="form-group" style={{ gridColumn: 'span 2' }}>
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
            CN（中文）(源文本)
          </label>
          <input
            type="text"
            value={fields['CN（中文）'] || ''}
            onChange={(e) => handleFieldChange('CN（中文）', e.target.value)}
            disabled={inputsDisabled}
            placeholder="请输入中文源文本..."
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
          />
        </div>

        {/* 所在页面 */}
        <div className="form-group">
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
            所在页面
          </label>
          <input
            type="text"
            value={fields['所在页面'] || ''}
            onChange={(e) => handleFieldChange('所在页面', e.target.value)}
            disabled={inputsDisabled}
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
          />
        </div>

        {/* 字号类别 */}
        <div className="form-group">
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
            字号类别
          </label>
          <input
            type="text"
            value={fields['字号类别'] || ''}
            onChange={(e) => handleFieldChange('字号类别', e.target.value)}
            disabled={inputsDisabled}
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
          />
        </div>

        {/* 翻译列 */}
        <div style={{ gridColumn: 'span 2', marginTop: '1rem' }}>
          <h4 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: '0.5rem', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
            <span>目标语言翻译</span>
            {!inputsDisabled && canWrite && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
                <label 
                  style={{ 
                    display: 'inline-flex', 
                    alignItems: 'center', 
                    gap: '0.25rem', 
                    fontSize: '0.75rem', 
                    color: 'var(--text-secondary)', 
                    cursor: 'pointer', 
                    userSelect: 'none'
                  }} 
                  title="勾选时默认保留已填语种不予修改，仅补充空白语种；取消勾选将全部覆盖重新翻译"
                >
                  <input
                    type="checkbox"
                    checked={preserveExisting}
                    onChange={(e) => setPreserveExisting(e.target.checked)}
                    disabled={transToolsDisabled}
                  />
                  <span>保留已有翻译</span>
                </label>
                <button
                  type="button"
                  onClick={handleClearTranslations}
                  disabled={transToolsDisabled}
                  className="btn-text"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    fontSize: '0.78rem',
                    color: 'var(--red)',
                    padding: '0.15rem 0.5rem',
                    borderRadius: '4px',
                  }}
                  title="删除中文外的其他语种翻译（需保存后生效）"
                >
                  <Eraser size={12} />
                  <span>清空翻译</span>
                </button>
                <button
                  type="button"
                  onClick={handleRetranslate}
                  disabled={transToolsDisabled}
                  className="btn-text"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    fontSize: '0.78rem',
                    color: 'var(--accent)',
                    padding: '0.15rem 0.5rem',
                    borderRadius: '4px',
                  }}
                  title={preserveExisting ? "调用 AI 补充缺失语种翻译（保留现有翻译不予修改）" : "调用 AI 重新翻译全部语种（覆盖所有语种）"}
                >
                  {retranslating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  <span>{retranslating ? '翻译中...' : '重新翻译'}</span>
                </button>
              </span>
            )}
          </h4>
        </div>

        {targetLanguages.map(lang => (
          <div key={lang} className="form-group">
            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
              {lang}
            </label>
            <input
              type="text"
              value={fields[lang] || ''}
              onChange={(e) => handleFieldChange(lang, e.target.value)}
              disabled={inputsDisabled}
              style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
            />
          </div>
        ))}

        {isLocked && (
          <div style={{ gridColumn: 'span 2', marginTop: '0.5rem', padding: '0.5rem 0.75rem', background: 'var(--red-bg)', color: 'var(--red)', borderRadius: '4px', fontSize: '0.78rem' }}>
            ⚠️ 此词条已被锁定只读。需要编辑请先解锁(行首 Lock 图标)。
          </div>
        )}
        </div>
        {/* end 左列 */}

        {/* 右侧: 跨版本参考 / 修改历史 (v1.2 重构后丢失, 现在恢复) */}
        <div className="right-panel" style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border-color)', paddingLeft: '0.75rem', minHeight: 0 }}>
          <div role="tablist" style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'tm'}
              onClick={() => setRightTab('tm')}
              className={`btn btn-sm ${rightTab === 'tm' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, height: '30px', fontSize: '0.8rem' }}
            >
              <GitBranch size={13} />
              <span>跨版本参考 ({tmReferences.length})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'history'}
              onClick={() => setRightTab('history')}
              className={`btn btn-sm ${rightTab === 'history' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, height: '30px', fontSize: '0.8rem' }}
            >
              <History size={13} />
              <span>修改历史 ({snapshots.length})</span>
            </button>
          </div>

          <div role="tabpanel" style={{ flex: 1, overflowY: 'auto', minHeight: 0, border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '0.5rem' }}>
            {rightTab === 'tm' ? (
              <TmPanel
                loading={loadingTm}
                references={tmReferences}
                onReload={loadTmReferences}
                onApplyTranslation={(t) => {
                  // 用户点击 "套用" 按钮, 把跨版本某条记录的 translations 灌入当前编辑表单
                  if (isLocked && !canManageLock) {
                    toast.error('词条已锁定,无法套用');
                    return;
                  }
                  setFields(prev => ({ ...prev, ...t }));
                  toast.success('已套用该版本的翻译');
                }}
              />
            ) : (
              <HistoryPanel
                loading={loadingSnapshots}
                snapshots={snapshots}
                onReload={loadSnapshots}
                onRollback={handleRollback}
                rollingBackId={rollingBackId}
                canRollback={!isLocked || canManageLock}
              />
            )}
          </div>
        </div>
      </div>
    </GlossaModal>
  );
}

// ============================================================
// 子组件: TmPanel — 跨版本翻译参考
// ============================================================
function TmPanel({ loading, references, onReload, onApplyTranslation }) {
  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        <Loader2 className="animate-spin" size={14} style={{ marginRight: '0.4rem' }} />
        正在加载其他大表的翻译参考...
      </div>
    );
  }
  if (!references || references.length === 0) {
    return (
      <div style={{ padding: '2rem 0.5rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 0.6rem 0' }}>
          其他大表暂无相同 KW 的翻译参考
        </p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReload} style={{ height: '26px', fontSize: '0.75rem' }}>
          重新加载
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {references.map((ref, idx) => {
        const trans = ref.translations || {};
        return (
          <div key={idx} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.6rem', fontSize: '0.8rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <strong style={{ color: 'var(--accent)' }}>{ref.versionName}</strong>
              <button
                type="button"
                className="btn-text"
                onClick={() => onApplyTranslation(trans)}
                style={{ fontSize: '0.75rem', color: 'var(--accent)' }}
                title="把该版本的翻译灌入左侧编辑表单"
              >
                套用此版 →
              </button>
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)' }}>CN: </span>
              <span style={{ color: 'var(--text-primary)' }}>{ref.zh_cn || '—'}</span>
            </div>
            {Object.entries(trans).filter(([, v]) => v && String(v).trim()).length > 0 && (
              <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {Object.entries(trans).filter(([, v]) => v && String(v).trim()).map(([lang, val]) => (
                  <div key={lang} style={{ fontSize: '0.78rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{lang}: </span>
                    <span style={{ color: 'var(--text-primary)' }}>{val}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: '0.3rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              {ref.owner && <>负责人: {ref.owner} · </>}
              {ref.updatedAt && <>{new Date(ref.updatedAt).toLocaleDateString()}</>}
            </div>
          </div>
        );
      })}
      <button type="button" className="btn btn-secondary btn-sm" onClick={onReload} style={{ height: '26px', fontSize: '0.75rem', alignSelf: 'flex-start' }}>
        重新加载
      </button>
    </div>
  );
}

// ============================================================
// 子组件: HistoryPanel — 修改历史快照
// ============================================================
function HistoryPanel({ loading, snapshots, onReload, onRollback, rollingBackId, canRollback }) {
  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        <Loader2 className="animate-spin" size={14} style={{ marginRight: '0.4rem' }} />
        正在加载历史快照...
      </div>
    );
  }
  if (!snapshots || snapshots.length === 0) {
    return (
      <div style={{ padding: '2rem 0.5rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 0.6rem 0' }}>
          该词条暂无历史快照（可能从未被修改过，或快照已被清理）
        </p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReload} style={{ height: '26px', fontSize: '0.75rem' }}>
          重新加载
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {snapshots.map((snap) => {
        const trans = snap.translations || {};
        const isRolling = rollingBackId === snap.id;
        return (
          <div key={snap.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.6rem', fontSize: '0.78rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>
                {snap.createdAt ? new Date(snap.createdAt).toLocaleString() : '-'}
              </span>
              {canRollback && (
                <button
                  type="button"
                  onClick={() => onRollback(snap.id)}
                  disabled={isRolling}
                  className="btn-text"
                  style={{ fontSize: '0.72rem', color: isRolling ? 'var(--text-muted)' : 'var(--accent)' }}
                  title="回退至此快照"
                >
                  <RotateCcw size={11} style={{ verticalAlign: 'middle', marginRight: '2px' }} />
                  {isRolling ? '回退中...' : '回退'}
                </button>
              )}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
              操作者: {snap.creatorName || '未知'}
            </div>
            {snap.zh_cn && (
              <div style={{ color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                CN: <span style={{ color: 'var(--text-primary)' }}>{snap.zh_cn}</span>
              </div>
            )}
            {Object.entries(trans).filter(([, v]) => v && String(v).trim()).length > 0 && (
              <div style={{ marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '1px' }}>
                {Object.entries(trans).filter(([, v]) => v && String(v).trim()).map(([lang, val]) => (
                  <div key={lang}>
                    <span style={{ color: 'var(--text-muted)' }}>{lang}: </span>
                    <span style={{ color: 'var(--text-primary)' }}>{val}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}