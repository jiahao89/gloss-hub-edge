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
import { Loader2, Sparkles } from 'lucide-react';

export default function AddTermModal({ open, onClose, selectedTableId, targetLanguages = [], excludedTranslateLangs = new Set(), onAddSuccess }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [preserveExisting, setPreserveExisting] = useState(true);
  
  // Initialize state based on fields
  const getInitialFields = () => {
    const fields = {
      '所在页面': '',
      '字号类别': '',
      'KW': '',
      'CN（中文）': ''
    };
    targetLanguages.forEach(lang => {
      fields[lang] = '';
    });
    return fields;
  };

  const [newFields, setNewFields] = useState(getInitialFields());
  const [generatingKw, setGeneratingKw] = useState(false);

  // M12: 仅在 open 由 false→true 的边沿重建表单 ——
  // 目标语种是异步加载的，只在挂载时初始化会导致后加载的语种输入框缺失；
  // 同时保证再次打开时不残留上一次的输入
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setNewFields(getInitialFields());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleFieldChange = (field, value) => {
    setNewFields(prev => ({ ...prev, [field]: value }));
  };

  const handleGenerateKw = async () => {
    const cn = (newFields['CN（中文）'] || '').trim();
    const en = (newFields['EN（英文）'] || newFields['EN'] || '').trim();
    const context = (newFields['所在页面'] || '').trim();
    if (!cn && !en) {
      toast.error('请先填写 CN（中文）源文本或参考英文');
      return;
    }
    setGeneratingKw(true);
    try {
      const res = await apiFetch(`/api/projects/proj-default/generate-kw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cn, enText: en, context }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'KW 生成失败');
      }
      const data = await res.json();
      if (data.kw) {
        setNewFields(prev => ({ ...prev, KW: data.kw }));
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

  const handleAutoTranslate = async () => {
    if (!newFields['CN（中文）']?.trim()) {
      toast.error('请先输入中文源文本');
      return;
    }

    const activeTargetLangs = targetLanguages.filter(l => !excludedTranslateLangs.has(l));
    if (activeTargetLangs.length === 0) {
      toast.info('所有目标语种均已被排除');
      return;
    }

    const existingTrans = extractExistingTranslations(newFields, activeTargetLangs);
    const existingCount = Object.keys(existingTrans).length;

    // 如果启用了保留已有翻译（默认），且所有语言均已存在翻译，则提示无需重复翻译
    if (preserveExisting && existingCount === activeTargetLangs.length) {
      toast.info('所有目标语种均已有翻译。若需全部覆盖重新翻译，请取消勾选“保留已有翻译”');
      return;
    }

    // 仅在保留已有翻译时，把请求语言缩小为缺失的语种，并附上已有参考
    const missingLangs = preserveExisting
      ? activeTargetLangs.filter(l => !existingTrans[l])
      : activeTargetLangs;

    setIsTranslating(true);
    try {
      let contextVal = (newFields['所在页面'] || '').trim();
      const refSnippet = formatExistingReferenceContext(existingTrans);
      if (refSnippet) {
        contextVal = contextVal ? `${contextVal} (${refSnippet})` : refSnippet;
      }

      const inputs = {
        KW: newFields.KW || '',
        text: newFields['CN（中文）'],
        context: contextVal || '无',
        target_languages: (missingLangs.length > 0 ? missingLangs : activeTargetLangs).join(','),
        existing_translations: existingTrans,
        preserve_existing: preserveExisting
      };

      const res = await apiFetch(`/api/projects/proj-default/ai-translate?debug=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs })
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || '翻译接口调用失败');
      }

      const result = await res.json().catch(() => ({}));
      const { updatedFields, changedCount, preservedCount } = mergeTranslations({
        currentFields: newFields,
        aiResult: result,
        targetLanguages: activeTargetLangs,
        preserveExisting
      });

      if (changedCount > 0) {
        setNewFields(updatedFields);
        const msg = preservedCount > 0 
          ? `AI 翻译完成！已补全 ${changedCount} 个语种，已保留 ${preservedCount} 个现存翻译`
          : 'AI 翻译完成！';
        toast.success(msg);
      } else {
        toast.info('AI 未返回对应的语言翻译，请检查目标语言');
      }
    } catch (err) {
      console.error('翻译失败:', err);
      toast.error(`翻译失败: ${err.message}`);
    } finally {
      setIsTranslating(false);
    }
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();
    if (!selectedTableId) {
      toast.error('请先选择一个数据表');
      return;
    }

    if (!newFields.KW?.trim() && !newFields['CN（中文）']?.trim()) {
      toast.error('KW 或 CN（中文）不能同时为空');
      return;
    }

    setLoading(true);
    try {
      const addedForSync = [{
        recordId: `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        fields: newFields
      }];

      const res = await apiFetch(`/api/tables/${selectedTableId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ added: addedForSync, updated: [] })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '新增失败');
      }

      toast.success('新增词条成功');
      setNewFields(getInitialFields());
      onAddSuccess(addedForSync[0]);
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <GlossaModal
      isOpen={true}
      onClose={onClose}
      title="新增翻译词条"
      closeDisabled={loading || isTranslating}
      footer={
        <>
          <button onClick={onClose} className="btn btn-secondary" disabled={loading || isTranslating}>取消</button>
          <button onClick={handleAddSubmit} className="btn btn-primary" disabled={loading || isTranslating}>
            {loading ? '保存中...' : '保存新增'}
          </button>
        </>
      }
    >
      <div className="edit-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', padding: '0.5rem 0' }}>
        <div className="form-group" style={{ gridColumn: 'span 2' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
              KW 标识 (例如: KW_AVG_CADENCE)
            </label>
            <button
              type="button"
              onClick={handleGenerateKw}
              disabled={generatingKw || loading || isTranslating}
              className="btn-text"
              style={{
                fontSize: '0.78rem',
                color: 'var(--accent)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                padding: '2px 6px',
                cursor: 'pointer'
              }}
            >
              {generatingKw ? (
                <><Loader2 size={12} className="animate-spin" /> 生成中...</>
              ) : (
                <><Sparkles size={12} /> 自动生成 KW</>
              )}
            </button>
          </div>
          <input 
            type="text" 
            value={newFields['KW']} 
            onChange={(e) => handleFieldChange('KW', e.target.value)}
            className="input-text"
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
            disabled={loading || isTranslating}
            placeholder="请输入 KW 或点击右上角'自动生成'..."
          />
        </div>
        
        <div className="form-group" style={{ gridColumn: 'span 2' }}>
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
            CN（中文）(源文本)
          </label>
          <input 
            type="text" 
            value={newFields['CN（中文）']} 
            onChange={(e) => handleFieldChange('CN（中文）', e.target.value)}
            className="input-text"
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
            disabled={loading || isTranslating}
            placeholder="请输入中文源文本..."
          />
        </div>

        <div className="form-group">
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
            所在页面
          </label>
          <input 
            type="text" 
            value={newFields['所在页面']} 
            onChange={(e) => handleFieldChange('所在页面', e.target.value)}
            className="input-text"
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
            disabled={loading || isTranslating}
          />
        </div>

        <div className="form-group">
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
            字号类别
          </label>
          <input 
            type="text" 
            value={newFields['字号类别']} 
            onChange={(e) => handleFieldChange('字号类别', e.target.value)}
            className="input-text"
            style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
            disabled={loading || isTranslating}
          />
        </div>

        <div style={{ gridColumn: 'span 2', marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0', color: 'var(--text-primary)' }}>
              目标语言翻译
            </h4>
            <label 
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}
              title="勾选时默认保留已填语种不予修改，仅补充空白语种；取消勾选将全部覆盖重新翻译"
            >
              <input
                type="checkbox"
                checked={preserveExisting}
                onChange={(e) => setPreserveExisting(e.target.checked)}
                disabled={loading || isTranslating}
              />
              <span>保留已有翻译 (不纠正现存语种)</span>
            </label>
          </div>
          <button 
            type="button"
            onClick={handleAutoTranslate}
            disabled={loading || isTranslating || !newFields['CN（中文）']?.trim()}
            className="btn btn-secondary btn-sm"
            style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.35rem 0.6rem' }}
          >
            {isTranslating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} style={{ color: 'var(--purple)' }} />}
            {isTranslating ? '翻译中...' : '一键 AI 翻译'}
          </button>
        </div>

        {targetLanguages.map(lang => (
          <div key={lang} className="form-group">
            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-muted)' }}>
              {lang}
            </label>
            <input 
              type="text" 
              value={newFields[lang] || ''} 
              onChange={(e) => handleFieldChange(lang, e.target.value)}
              className="input-text"
              style={{ width: '100%', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px' }}
              disabled={loading || isTranslating}
            />
          </div>
        ))}
      </div>
    </GlossaModal>
  );
}
