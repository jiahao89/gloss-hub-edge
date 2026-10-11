import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useToast } from './Toast';
import Pagination from './Pagination';
import { Plus, Trash2, Download, Upload, BookOpen, FileSpreadsheet, Search, Loader2 } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { parseCSV, arrayToCSV, fuzzyFindIndex } from '../utils/csvHelper';
import { downloadBlob, buildExportFilename } from '../utils/download';
import GlossaModal from './GlossaModal';

export default function GlossaryTab({ projectRole }) {
  const toast = useToast();
  const [tables, setTables] = useState([]);
  const [selectedTableId, setSelectedTableId] = useState('');
  const [terms, setTerms] = useState([]);
  const [loadingTables, setLoadingTables] = useState(true);
  const [loadingTerms, setLoadingTerms] = useState(false);
  const [importing, setImporting] = useState(false);

  // Search keyword
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Table Modals
  const [addTableModal, setAddTableModal] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [creatingTable, setCreatingTable] = useState(false);

  // Term Modals
  const [addTermModal, setAddTermModal] = useState(false);
  const [newCnTerm, setNewCnTerm] = useState('');
  const [newEnTerm, setNewEnTerm] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [addingTerm, setAddingTerm] = useState(false);

  // CSV Import Ref
  const fileInputRef = useRef(null);

  const fetchTables = async () => {
    try {
      const res = await apiFetch('/api/projects/proj-default/glossary-tables');
      if (!res.ok) throw new Error('加载专业词表失败');
      const data = await res.json();
      setTables(data);
      if (data.length > 0 && !selectedTableId) {
        setSelectedTableId(data[0].id);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingTables(false);
    }
  };

  const fetchTerms = async (tableId) => {
    if (!tableId) return;
    setLoadingTerms(true);
    try {
      const res = await apiFetch(`/api/glossary-tables/${tableId}/terms`);
      if (!res.ok) throw new Error('加载专业术语失败');
      const data = await res.json();
      setTerms(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingTerms(false);
    }
  };

  useEffect(() => {
    fetchTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedTableId) {
      fetchTerms(selectedTableId);
    } else {
      setTerms([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTableId]);

  const activeTable = tables.find(t => t.id === selectedTableId);

  const handleCreateTable = async (e) => {
    e.preventDefault();
    if (!newTableName.trim()) return;

    setCreatingTable(true);
    try {
      const res = await apiFetch('/api/projects/proj-default/glossary-tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableName: newTableName.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setNewTableName('');
        setAddTableModal(false);
        setTables(prev => [...prev, data]);
        setSelectedTableId(data.id);
      } else {
        toast.error(`创建失败: ${data.error}`);
      }
    } catch (err) {
      toast.error(`网络错误: ${err.message}`);
    } finally {
      setCreatingTable(false);
    }
  };

  const handleDeleteTable = async () => {
    if (!selectedTableId || !activeTable) return;
    const confirmDel = window.confirm(
      `⚠️ 警告: 您确定要永久删除专业词汇大表 [${activeTable.table_name}] 吗？\n该操作将永久清空该表下的所有术语记录！`
    );
    if (!confirmDel) return;

    try {
      const res = await apiFetch(`/api/projects/proj-default/glossary-tables/${selectedTableId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const remaining = tables.filter(t => t.id !== selectedTableId);
        setTables(remaining);
        setSelectedTableId(remaining.length > 0 ? remaining[0].id : '');
        toast.success('删除词汇表成功！');
      } else {
        const data = await res.json();
        toast.error(`删除失败: ${data.error}`);
      }
    } catch (err) {
      toast.error(`网络错误: ${err.message}`);
    }
  };

  const handleAddTerm = async (e) => {
    e.preventDefault();
    if (!newCnTerm.trim() || !newEnTerm.trim()) {
      toast.error('中文术语和英文翻译为必填项！');
      return;
    }

    setAddingTerm(true);
    try {
      const res = await apiFetch(`/api/glossary-tables/${selectedTableId}/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cnTerm: newCnTerm.trim(),
          enTerm: newEnTerm.trim(),
          description: newDesc.trim()
        })
      });
      const data = await res.json();
      if (res.ok) {
        setNewCnTerm('');
        setNewEnTerm('');
        setNewDesc('');
        setAddTermModal(false);
        fetchTerms(selectedTableId);
      } else {
        toast.error(`添加失败: ${data.error}`);
      }
    } catch (err) {
      toast.error(`网络错误: ${err.message}`);
    } finally {
      setAddingTerm(false);
    }
  };

  const handleDeleteTerm = async (term) => {
    if (!window.confirm(`确定删除专业术语 [${term.cn_term}] 吗？`)) return;

    try {
      const res = await apiFetch(`/api/glossary-tables/${selectedTableId}/terms/${term.id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setTerms(prev => prev.filter(t => t.id !== term.id));
      } else {
        const data = await res.json();
        toast.error(`删除失败: ${data.error}`);
      }
    } catch (err) {
      toast.error(`网络错误: ${err.message}`);
    }
  };

  // CSV Export
  const handleExportCSV = () => {
    if (terms.length === 0) {
      toast.error('当前词汇表无数据，无法导出！');
      return;
    }
    const displayHeaders = activeTable?.headers || ['中文专业术语', '英文翻译对应', '说明 / 定义'];
    const rows = terms.map(t => {
      return displayHeaders.map(h => {
        return t.fields?.[h] !== undefined ? t.fields[h] : (
          h === '中文专业术语' ? t.cn_term : (
            h === '英文翻译对应' ? t.en_term : (
              h === '说明 / 定义' ? t.description : ''
            )
          )
        );
      });
    });

    const csvContent = arrayToCSV(displayHeaders, rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const tableName = activeTable?.table_name || '专业词汇表';

    // M4: 统一走 utils/download.js 下载通道（内部延迟 revoke，规避部分浏览器提前中断的问题）
    downloadBlob(blob, buildExportFilename('GlossaHub', tableName, 'csv'));
  };

  // CSV Import Parser
  const handleImportCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      setImporting(true);
      try {
        const text = evt.target.result;
        const csvRows = parseCSV(text);
        if (csvRows.length === 0) {
          toast.error('CSV 文件为空！');
          return;
        }

        const firstRow = csvRows[0];
        const cnIdx = fuzzyFindIndex(firstRow, ['cn', 'zh', 'term', 'chinese', 'key'], ['中文', '词条', '键名']);
        const enIdx = fuzzyFindIndex(firstRow, ['en', 'english', 'translation'], ['英文', '翻译', '译文']);
        const descIdx = fuzzyFindIndex(firstRow, ['desc', 'description', 'info', 'context', 'remark'], ['说明', '定义', '释义', '备注']);

        const hasHeader = cnIdx !== -1 || enIdx !== -1 || descIdx !== -1;
        
        let startIdx = 0;
        let finalCnIdx = 0;
        let finalEnIdx = 1;
        let finalDescIdx = 2;

        if (hasHeader) {
          startIdx = 1;
          // 已识别表头时，未命中的列必须留空，不能再回退到列位置默认值（0/1/2），
          // 否则会把「所在界面」「KW」等无关列错当成中文/释义列，导致 cn_term 全表错位。
          finalCnIdx = -1;
          finalEnIdx = -1;
          finalDescIdx = -1;
          const mappings = [];
          if (cnIdx !== -1) {
            finalCnIdx = cnIdx;
            if (!['cn', 'zh', 'term', 'chinese', 'key', '中文', '词条', '键名'].includes(firstRow[cnIdx])) {
              mappings.push(`[${csvRows[0][cnIdx].trim()}] -> 中文源词`);
            }
          }
          if (enIdx !== -1) {
            finalEnIdx = enIdx;
            if (!['en', 'english', 'translation', '英文', '翻译', '译文'].includes(firstRow[enIdx])) {
              mappings.push(`[${csvRows[0][enIdx].trim()}] -> 英文翻译`);
            }
          }
          if (descIdx !== -1) {
            finalDescIdx = descIdx;
            if (!['desc', 'description', 'info', 'context', 'remark', '说明', '定义', '释义', '备注'].includes(firstRow[descIdx])) {
              mappings.push(`[${csvRows[0][descIdx].trim()}] -> 备注释义`);
            }
          }
          if (mappings.length > 0) {
            toast.success(`已智能映射非标准表头: ${mappings.join(', ')}`, { duration: 6000 });
          }
        }

        const rawHeaders = csvRows[0].map(h => h.trim());
        const parsedTerms = [];
        for (let i = startIdx; i < csvRows.length; i++) {
          const row = csvRows[i];
          if (!row || row.length === 0) continue;
          
          const cnTerm = (row[finalCnIdx] || '').trim();
          const enTerm = (row[finalEnIdx] || '').trim();
          const description = (row[finalDescIdx] || '').trim();

          const rowFields = {};
          rawHeaders.forEach((headerName, index) => {
            rowFields[headerName] = (row[index] || '').trim();
          });

          if (cnTerm || enTerm) {
            parsedTerms.push({ 
              cnTerm, 
              enTerm, 
              description,
              fields: rowFields
            });
          }
        }

        if (parsedTerms.length === 0) {
          toast.error('未解析到任何有效的术语行！');
          return;
        }

        if (!window.confirm(`解析成功，共找到 ${parsedTerms.length} 条专业术语。是否批量覆盖导入到当前表 [${activeTable?.table_name}]？`)) {
          return;
        }

        const res = await apiFetch(`/api/glossary-tables/${selectedTableId}/terms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            termsList: parsedTerms,
            headers: rawHeaders
          })
        });
        const data = await res.json();
        if (res.ok) {
          toast.success(data.message || `导入成功！共 ${parsedTerms.length} 条术语`);
          // 刷新表元数据（含新 headers）和术语列表
          await fetchTables();
          await fetchTerms(selectedTableId);
        } else {
          toast.error(`导入失败: ${data.error}`);
        }
      } catch (err) {
        toast.error(`导入发生错误: ${err.message}`);
      } finally {
        setImporting(false);
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  // 低危: 过滤与分页派生值记忆化，避免无关重渲染重复计算
  const filteredTerms = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return terms;
    return terms.filter(t => (
      t.cn_term.toLowerCase().includes(q) ||
      t.en_term.toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q))
    ));
  }, [terms, searchQuery]);

  // 分页：搜索/词表切换时自动回到第 1 页
  const totalPages = Math.max(1, Math.ceil(filteredTerms.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pagedTerms = useMemo(
    () => filteredTerms.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredTerms, safePage, pageSize]
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedTableId, searchQuery, pageSize]);

  if (loadingTables) {
    return (
      <div className="flex-center" style={{ height: '60vh', flexDirection: 'column', gap: '1rem' }}>
        <div className="spinner"></div>
        <span style={{ color: 'var(--text-secondary)' }}>正在装载专业词汇库配置...</span>
      </div>
    );
  }

  return (
    <div style={{ padding: '1.5rem', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      
      {/* Upper header */}
      <div className="tab-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexShrink: 0 }}>
        <div>
          <h2 style={{ margin: '0 0 0.25rem 0', fontSize: '1.75rem', fontWeight: '800', letterSpacing: '-0.02em' }}>专业词汇库</h2>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>管理迈金骑行行业专有词汇与缩写。支持导出为 CSV 导入至 Dify 知识库。</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {projectRole !== 'viewer' && (
            <button className="btn btn-secondary" onClick={() => setAddTableModal(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={15} />
              新建词汇表
            </button>
          )}
        </div>
      </div>

      {/* Switcher & Tools */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexShrink: 0, paddingBottom: '1rem', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>选择词汇表:</label>
          <select 
            value={selectedTableId} 
            onChange={(e) => setSelectedTableId(e.target.value)}
            style={{ padding: '0.5rem 2rem 0.5rem 0.75rem', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none' }}
          >
            {tables.map(t => (
              <option key={t.id} value={t.id}>{t.table_name}</option>
            ))}
            {tables.length === 0 && <option value="">-- 暂无词汇表 --</option>}
          </select>
          {selectedTableId && (
            <>
              {projectRole === 'owner' && (
                <button 
                  onClick={handleDeleteTable}
                  className="icon-btn" 
                  style={{ color: 'var(--red)', padding: '0.4rem', marginLeft: '0.25rem' }} 
                  title="删除此词汇大表"
                  aria-label="删除此词汇大表"
                >
                  <Trash2 size={16} />
                </button>
              )}
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginLeft: '0.75rem', borderLeft: '1px solid var(--border-color)', paddingLeft: '0.75rem' }}>
                共包含词条：<strong style={{ color: 'var(--accent)' }}>{terms.length}</strong> 条
              </span>
            </>
          )}
        </div>

        {selectedTableId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {/* Search Input */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={14} style={{ position: 'absolute', left: '0.62rem', color: 'var(--text-muted)' }} />
              <input 
                type="text" 
                placeholder="搜索术语..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ padding: '0.45rem 0.75rem 0.45rem 1.8rem', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', width: '180px', fontSize: '0.82rem' }}
              />
            </div>

            {projectRole !== 'viewer' && (
              <>
                <button onClick={() => setAddTermModal(true)} className="btn btn-primary" style={{ padding: '0.45rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem' }}>
                  <Plus size={14} />
                  添加术语
                </button>

                <button onClick={() => fileInputRef.current.click()} disabled={importing} className="btn btn-secondary" style={{ padding: '0.45rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem' }}>
                  {importing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                  {importing ? '导入中...' : '导入 CSV'}
                </button>
              </>
            )}
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleImportCSV} 
              accept=".csv" 
              style={{ display: 'none' }} 
            />

            <button onClick={handleExportCSV} className="btn btn-secondary" style={{ padding: '0.45rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem' }}>
              <Download size={14} />
              导出 CSV
            </button>
          </div>
        )}
      </div>

      {/* Main Term Table Container */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-secondary)', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
        
        {loadingTerms ? (
          <div className="flex-center" style={{ flex: 1 }}>
            <div className="spinner"></div>
            <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>正在装载术语列表...</span>
          </div>
        ) : !selectedTableId ? (
          <div className="flex-center" style={{ flex: 1, flexDirection: 'column', gap: '1rem', color: 'var(--text-secondary)' }}>
            <BookOpen size={48} style={{ opacity: 0.2 }} />
            <span>请在上方创建一个专业词汇库以开始管理术语数据。</span>
          </div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', padding: '0.5rem', minHeight: 0 }}>
            {(() => {
              const displayHeaders = activeTable?.headers || ['中文专业术语', '英文翻译对应', '说明 / 定义'];
              return (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: displayHeaders.length > 5 ? '1200px' : 'auto' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                      {displayHeaders.map(h => (
                        <th key={h} style={{
                          padding: '0.75rem',
                          whiteSpace: 'nowrap',
                        }}>{h}</th>
                      ))}
                      <th style={{ padding: '0.75rem', width: '80px', textAlign: 'center', whiteSpace: 'nowrap' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedTerms.map((term) => (
                      <tr key={term.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                        {displayHeaders.map(h => {
                          const cellVal = term.fields?.[h] !== undefined ? term.fields[h] : (
                            h === '中文专业术语' ? term.cn_term : (
                              h === '英文翻译对应' ? term.en_term : (
                                h === '说明 / 定义' ? term.description : ''
                              )
                            )
                          );
                          let cellColor = 'var(--text-secondary)';
                          if (h.includes('中文') || h === 'CN' || h === 'CN（中文）') cellColor = 'var(--text-primary)';
                          else if (h.includes('英文') || h === 'EN' || h === 'EN（英文）' || h.includes('翻译')) cellColor = 'var(--accent)';
                          
                          return (
                            <td 
                              key={h} 
                              style={{ padding: '0.75rem', color: cellColor, maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} 
                              title={cellVal}
                            >
                              {cellVal || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>}
                            </td>
                          );
                        })}
                        <td style={{ padding: '0.75rem', textAlign: 'center' }}>
                          {projectRole !== 'viewer' ? (
                            <button 
                              onClick={() => handleDeleteTerm(term)}
                              className="icon-btn" 
                              style={{ color: 'var(--red)', display: 'inline-flex' }}
                              title="删除术语"
                              aria-label="删除术语"
                            >
                              <Trash2 size={14} />
                            </button>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {pagedTerms.length === 0 && (
                      <tr>
                        <td colSpan={displayHeaders.length + 1} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                          <FileSpreadsheet size={32} style={{ opacity: 0.2, marginBottom: '0.5rem' }} />
                          <p>未找到匹配的术语条目。可以点击“添加术语”或“导入 CSV”写入数据。</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              );
            })()}
          </div>
        )}
      </div>{/* /.term-table-container */}

      {/* 分页器（独立 footer，不跟随表格滚动） */}
      {filteredTerms.length > 0 && (
        <Pagination
          total={filteredTerms.length}
          page={safePage}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
        />
      )}

      {/* Add Table Modal */}
      <GlossaModal
        isOpen={addTableModal}
        onClose={() => setAddTableModal(false)}
        variant="simple"
        width="400px"
      >
        <h3 style={{ margin: '0 0 1rem 0', fontSize: '1.2rem', fontWeight: '600' }}>新建词汇表</h3>
        <form onSubmit={handleCreateTable}>
          <div className="form-group" style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.82rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>词汇大表名称</label>
            <input 
              type="text" 
              value={newTableName}
              onChange={(e) => setNewTableName(e.target.value)}
              placeholder="例如: 迈金骑行通用术语表"
              autoFocus
              required
              style={{ width: '100%', padding: '0.62rem', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" onClick={() => setAddTableModal(false)} className="btn btn-secondary" style={{ padding: '0.5rem 1rem' }}>
              取消
            </button>
            <button type="submit" disabled={creatingTable} className="btn btn-primary" style={{ padding: '0.5rem 1rem' }}>
              {creatingTable ? '正在创建...' : '确认创建'}
            </button>
          </div>
        </form>
      </GlossaModal>

      {/* Add Term Modal */}
      <GlossaModal
        isOpen={addTermModal}
        onClose={() => setAddTermModal(false)}
        variant="simple"
        width="450px"
      >
        <h3 style={{ margin: '0 0 1rem 0', fontSize: '1.2rem', fontWeight: '600' }}>添加专业术语</h3>
        <form onSubmit={handleAddTerm}>
          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.82rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>中文专业术语</label>
            <input 
              type="text" 
              value={newCnTerm}
              onChange={(e) => setNewCnTerm(e.target.value)}
              placeholder="如: 踏频"
              required
              autoFocus
              style={{ width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            />
          </div>

          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.82rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>英文翻译对应</label>
            <input 
              type="text" 
              value={newEnTerm}
              onChange={(e) => setNewEnTerm(e.target.value)}
              placeholder="如: Cadence"
              required
              style={{ width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            />
          </div>

          <div className="form-group" style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.82rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>说明 / 定义 (可选)</label>
            <textarea 
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="输入此术语的使用场景或定义以辅助翻译判断..."
              rows={3}
              style={{ width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" onClick={() => setAddTermModal(false)} className="btn btn-secondary" style={{ padding: '0.5rem 1rem' }}>
              取消
            </button>
            <button type="submit" disabled={addingTerm} className="btn btn-primary" style={{ padding: '0.5rem 1rem' }}>
              {addingTerm ? '正在保存...' : '确认保存'}
            </button>
          </div>
        </form>
      </GlossaModal>

    </div>
  );
}
