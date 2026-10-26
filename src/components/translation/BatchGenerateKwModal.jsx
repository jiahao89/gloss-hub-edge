import React, { useState, useEffect, useRef } from 'react';
import GlossaModal from '../GlossaModal';
import { apiFetch } from '../../utils/api';
import { useToast } from '../Toast';
import { Zap, Loader2, Check, RefreshCw } from 'lucide-react';

export default function BatchGenerateKwModal({
  open,
  onClose,
  selectedTableId,
  tableName = '',
  selectedTerms = [],
  allRecords = [],
  projectId = 'proj-default',
  onSuccess = () => {}
}) {
  const toast = useToast();
  const [mode, setMode] = useState('missing_only'); // 'missing_only' | 'all'
  const [items, setItems] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const formatRecord = (r) => {
    const id = r.recordId || r.id;
    const kw = r.fields?.KW || r.kw || '';
    const cn = r.fields?.['CN（中文）'] || r.zh_cn || '';
    const en = r.fields?.['EN（英文）'] || r.fields?.EN || (r.translations ? (typeof r.translations === 'object' ? r.translations['EN（英文）'] || r.translations.EN : '') : '') || '';
    const context = r.fields?.['所在页面'] || r.context || '';

    return {
      id,
      originalKw: kw,
      kw: kw,
      generatedKw: '',
      cn,
      en,
      context,
      status: kw ? 'has_kw' : 'empty_kw'
    };
  };

  // 仅在 open 由 false→true 的边沿重建 items；
  // 之后父组件重渲染导致 selectedTerms 引用变化时只做增量合并，
  // 绝不整体重建 —— 否则会覆盖用户已手动修改的 KW 输入
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open) return;

    const source = selectedTerms.length > 0 ? selectedTerms : allRecords;

    if (!wasOpen) {
      // 边沿打开：完整重建候选列表
      setItems(source.map(formatRecord));
      return;
    }

    // 已打开状态下数据变化：按词条 id 增量合并，保留用户已编辑的项
    setItems(prev => {
      const prevIds = new Set(prev.map(it => it.id));
      const additions = source.map(formatRecord).filter(it => !prevIds.has(it.id));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [open, selectedTerms, allRecords]);

  if (!open) return null;

  const targetItems = items.filter(item => {
    if (mode === 'missing_only') {
      return !item.originalKw || item.originalKw.trim() === '';
    }
    return true;
  });

  const handleStartGenerate = async () => {
    const listToProcess = targetItems.filter(item => item.cn?.trim() || item.en?.trim());
    if (listToProcess.length === 0) {
      toast.info('没有需要生成 KW 的词条');
      return;
    }

    setIsGenerating(true);
    setProgress({ current: 0, total: listToProcess.length });

    try {
      // Chunk requests in batches of 10 for responsive UI
      const BATCH_SIZE = 10;
      const updatedMap = {};

      for (let i = 0; i < listToProcess.length; i += BATCH_SIZE) {
        const chunk = listToProcess.slice(i, i + BATCH_SIZE);
        const payload = chunk.map(item => ({
          id: item.id,
          text: item.cn,
          enText: item.en,
          context: item.context
        }));

        const res = await apiFetch(`/api/projects/${projectId}/batch-generate-kw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: payload }),
        timeoutMs: 115000,
        });

        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.results)) {
            data.results.forEach(r => {
              if (r.id && r.kw) {
                updatedMap[r.id] = r.kw;
              }
            });
          }
        }

        setProgress({ current: Math.min(i + BATCH_SIZE, listToProcess.length), total: listToProcess.length });
      }

      setItems(prev => prev.map(item => {
        if (updatedMap[item.id]) {
          return {
            ...item,
            kw: updatedMap[item.id],
            generatedKw: updatedMap[item.id],
            status: 'generated'
          };
        }
        return item;
      }));

      toast.success(`成功生成 ${Object.keys(updatedMap).length} 个 KW 标识！`);
    } catch (err) {
      console.error('批量生成 KW 失败:', err);
      toast.error('批量生成失败: ' + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    const toUpdate = items.filter(item => item.generatedKw && item.generatedKw.trim());
    if (toUpdate.length === 0) {
      toast.info('暂无新生成的 KW 需保存');
      return;
    }

    setIsSaving(true);
    try {
      const updates = toUpdate.map(i => ({ id: i.id, kw: i.kw }));
      const res = await apiFetch(`/api/tables/${selectedTableId}/batch-generate-kw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates,
          overwrite: mode === 'all'
        }),
      timeoutMs: 115000,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || '保存失败');
      }

      const data = await res.json();
      toast.success(data.message || `成功保存 ${updates.length} 条 KW 键名！`);
      onSuccess();
      onClose();
    } catch (err) {
      console.error('保存 KW 失败:', err);
      toast.error('保存失败: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const hasGeneratedItems = items.some(i => i.generatedKw && i.generatedKw.trim());

  return (
    <GlossaModal
      isOpen={open}
      onClose={onClose}
      maxWidth="860px"
      closeDisabled={isGenerating || isSaving}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap size={18} style={{ color: 'var(--yellow)' }} />
          <span>批量生成 KW 键名标识 ({tableName || '当前数据表'})</span>
        </div>
      }
      footer={
        <>
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isGenerating || isSaving}
          >
            取消
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleStartGenerate}
            disabled={isGenerating || isSaving || targetItems.length === 0}
          >
            {isGenerating ? (
              <><Loader2 size={14} className="animate-spin" /> 生成中 ({progress.current}/{progress.total})...</>
            ) : (
              <><RefreshCw size={14} /> 开始生成 ({targetItems.length})</>
            )}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={isGenerating || isSaving || !hasGeneratedItems}
          >
            {isSaving ? (
              <><Loader2 size={14} className="animate-spin" /> 正在写入数据表...</>
            ) : (
              <><Check size={14} /> 保存并应用到数据表</>
            )}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {/* Scope Mode Radio */}
        <div style={{ background: 'var(--bg-primary)', padding: '12px 16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            生成范围与覆盖规则：
          </div>
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="kw_mode"
                value="missing_only"
                checked={mode === 'missing_only'}
                onChange={() => setMode('missing_only')}
                disabled={isGenerating || isSaving}
              />
              <span>仅为空白的 KW 生成（推荐，共 {items.filter(i => !i.originalKw).length} 条）</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="kw_mode"
                value="all"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
                disabled={isGenerating || isSaving}
              />
              <span>覆盖所有选中词条（共 {items.length} 条）</span>
            </label>
          </div>
        </div>

        {/* Progress Bar */}
        {isGenerating && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <span>正在批量生成 KW...</span>
              <span>{progress.current} / {progress.total}</span>
            </div>
            <div style={{ height: '6px', background: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  background: 'var(--accent)',
                  width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                  transition: 'width 0.2s ease'
                }}
              />
            </div>
          </div>
        )}

        {/* Preview List Table */}
        <div style={{ maxHeight: '380px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-color)', textAlign: 'left', position: 'sticky', top: 0, zIndex: 2 }}>
                <th style={{ padding: '8px 12px', width: '50px' }}>#</th>
                <th style={{ padding: '8px 12px', width: '25%' }}>中文源词</th>
                <th style={{ padding: '8px 12px', width: '25%' }}>参考英文</th>
                <th style={{ padding: '8px 12px' }}>生成 KW 键名预览 (可修改)</th>
              </tr>
            </thead>
            <tbody>
              {targetItems.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    当前选择范围内无匹配词条
                  </td>
                </tr>
              ) : (
                targetItems.map((item, idx) => (
                  <tr
                    key={item.id}
                    style={{
                      borderBottom: '1px solid var(--border-color)',
                      background: item.generatedKw ? 'rgba(59, 130, 246, 0.04)' : 'transparent'
                    }}
                  >
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{idx + 1}</td>
                    <td style={{ padding: '8px 12px', fontWeight: 500 }}>{item.cn || '-'}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{item.en || '-'}</td>
                    <td style={{ padding: '6px 12px' }}>
                      <input
                        type="text"
                        className="input-field"
                        style={{
                          width: '100%',
                          padding: '4px 8px',
                          fontSize: '0.82rem',
                          fontFamily: 'monospace',
                          fontWeight: 600,
                          borderColor: item.generatedKw ? 'var(--accent)' : 'var(--border-color)',
                          color: item.generatedKw ? 'var(--accent)' : 'var(--text-primary)'
                        }}
                        placeholder="点击'开始生成'自动填充"
                        value={item.kw || ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setItems(prev => prev.map(it => it.id === item.id ? { ...it, kw: val, generatedKw: val } : it));
                        }}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </GlossaModal>
  );
}
