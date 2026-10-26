import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { apiFetch, safeGetLocalStorage } from '../../utils/api';
import { 
  findTranslationForLang, 
  DEFAULT_TARGET_LANGUAGES,
  extractExistingTranslations,
  formatExistingReferenceContext
} from '../../utils/languageHelper';
import { downloadBlob, buildExportFilename } from '../../utils/download.js';
import { useToast } from '../Toast';
import { BatchCategoryModal, BatchCopyModal, BatchApproveModal } from './BatchActionsModal';
import BatchTranslateModal from './BatchTranslateModal';
import TranslationToolbar from './TranslationToolbar';
import CSVImportHandler from './CSVImportHandler';
import AddTermModal from './AddTermModal';
import BatchAddModal from './BatchAddModal';
import EditTermModal from './EditTermModal';
import InheritModal from './InheritModal';
import TranslationTable from './TranslationTable';
import CopyContentModal from './CopyContentModal';
import BatchGenerateKwModal from './BatchGenerateKwModal';

export default function TranslationTab({ 
  difyConnected = false,
  user: propUser,
  selectedTableId: propSelectedTableId,
  setSelectedTableId: propSetSelectedTableId,
  projectRole = 'viewer'
}) {
  const toast = useToast();

  const [targetLanguagesList, setTargetLanguagesList] = useState(DEFAULT_TARGET_LANGUAGES);
  // TARGET_LANGUAGES 别名：组件内多处沿用该命名，统一指向异步加载后的语种列表
  const TARGET_LANGUAGES = targetLanguagesList;
  const [difyConfigured, setDifyConfigured] = useState(false);

  useEffect(() => {
    const loadProjLanguages = async () => {
      try {
        const res = await apiFetch('/api/projects/proj-default/languages');
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data && data.length > 0) {
            setTargetLanguagesList(data.map(item => item.lang_name));
          }
        }
      } catch (err) {
        console.error('加载语种列表失败:', err);
      }
    };

    const loadDifyState = async () => {
      try {
        const res = await apiFetch('/api/projects/proj-default/dify');
        if (res.ok) {
          const data = await res.json();
          setDifyConfigured(data.apiKeyConfigured);
        }
      } catch (err) {
        console.error('加载 Dify 配置状态失败:', err);
      }
    };

    loadProjLanguages();
    loadDifyState();
  }, []);

  // Bitable State
  const [tables, setTables] = useState([]);
  const [internalSelectedTableId, setInternalSelectedTableId] = useState(() => {
    return safeGetLocalStorage('glossa_last_selected_table_id', '');
  });
  const selectedTableId = (propSelectedTableId !== undefined && propSelectedTableId !== '') ? propSelectedTableId : internalSelectedTableId;
  const setSelectedTableId = useCallback((val) => {
    if (val) {
      localStorage.setItem('glossa_last_selected_table_id', val);
    }
    if (propSetSelectedTableId) {
      propSetSelectedTableId(val);
    } else {
      setInternalSelectedTableId(val);
    }
  }, [propSetSelectedTableId]);

  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);

  // 单元格高亮（修改/新增标记）状态 — 已从 App.jsx 下沉到唯一消费者 TranslationTab
  const [modifiedCells, setModifiedCells] = useState(() => {
    return safeGetLocalStorage('glossahub_modified_cells', {});
  });

  // 防抖 localStorage 持久化（避免每次单元格编辑都阻塞主线程）
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem('glossahub_modified_cells', JSON.stringify(modifiedCells));
      } catch (err) {
        console.warn('Failed to persist modified cells:', err);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [modifiedCells]);

  // 竞态防护：每次发起 loadTableData 递增，迟到响应据此丢弃
  const reqIdRef = useRef(0);

  // State for Batch Add Modal
  const [batchAddModalOpen, setBatchAddModalOpen] = useState(false);
  const [inheritOpen, setInheritOpen] = useState(false);

  useEffect(() => {
    setModifiedCells({});
    // Switching data tables must clear the row-selection set; otherwise
    // a recordId selected in the previous table would silently fail to
    // match anything in the new table, and downstream bulk actions would
    // either report "都已完成翻译" (misleading) or operate on 0 rows.
    setSelectedRecordIds(new Set());
  }, [selectedTableId]);

  // Column Visibility States
  // Column dropdown visibility is managed internally by TranslationToolbar.
  const [visibleLanguages, setVisibleLanguages] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1000) {
      return ['EN（英文）'];
    }
    return targetLanguagesList;
  });

  // Base columns that can be hidden (所在页面, 字号/负责人). Default: both hidden.
  const BASE_OPTIONAL_COLUMNS = [
    { key: '所在页面', label: '所在页面' },
    { key: '字号类别', label: '字号/负责人' },
  ];
  const [hiddenBaseColumns, setHiddenBaseColumns] = useState(() => {
    return new Set(['所在页面', '字号类别']);
  });

  // Filter/Search State
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchInput);
      setCurrentPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const [filterUntranslated, setFilterUntranslated] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [sortBy, setSortBy] = useState('default');
  // sortOrder 仅作为 API 查询参数读取，无需 setter
  const [sortOrder] = useState('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Field mappings
  const [fieldMap, setFieldMap] = useState({});

  // Sorting State (only affects online browsing, does not affect export)
  const [sortField, setSortField] = useState(null);
  const [sortDirection, setSortDirection] = useState(null); // 'asc' | 'desc' | null

  // Modal States
  const [editModalRecord, setEditModalRecord] = useState(null);
  const [_addModalOpen, setAddModalOpen] = useState(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState(new Set());
  const [copyContentOpen, setCopyContentOpen] = useState(false);
  const [batchTranslateOpen, setBatchTranslateOpen] = useState(false);
  const [batchGenerateKwOpen, setBatchGenerateKwOpen] = useState(false);

  const [batchTargetTableId, setBatchTargetTableId] = useState('');
  const [selectedBatchItemIds, setSelectedBatchItemIds] = useState(new Set());
  const [batchPreviewList, setBatchPreviewList] = useState([]);
  const [isTranslatingBatch, setIsTranslatingBatch] = useState(false);
  const [isSavingBatch, setIsSavingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ total: 0, current: 0, status: '' });

  // Batch Update/Copy/Approve States
  const [batchUpdateOpen, setBatchUpdateOpen] = useState(false);
  const [batchCopyOpen, setBatchCopyOpen] = useState(false);
  const [batchUpdateFields, setBatchUpdateFields] = useState({ context: '', owner: '' });
  const [batchCopyTargetTableId, setBatchCopyTargetTableId] = useState('');
  const [batchCopyDuplicateStrategy, setBatchCopyDuplicateStrategy] = useState('skip');
  const [lockLoadingId, setLockLoadingId] = useState('');
  const [batchApproveOpen, setBatchApproveOpen] = useState(false);
  const [batchApproveStatus, setBatchApproveStatus] = useState('APPROVED');
  const [batchApproveRejectReason, setBatchApproveRejectReason] = useState('');

  // 当前用户：优先使用父组件传入的 user prop，localStorage 兜底
  const fallbackUser = useMemo(() => safeGetLocalStorage('user', null), []);
  const currentUser = propUser ?? fallbackUser;

  // Excluded target languages for translation (remembered per-table + global fallback)
  const [excludedTranslateLangs, setExcludedTranslateLangs] = useState(() => {
    return new Set(safeGetLocalStorage('glossa_excluded_translate_langs', []));
  });

  useEffect(() => {
    if (selectedTableId) {
      const tableSaved = safeGetLocalStorage(`glossa_excluded_translate_langs_${selectedTableId}`, null);
      if (tableSaved && Array.isArray(tableSaved)) {
        setExcludedTranslateLangs(new Set(tableSaved));
      }
    }
  }, [selectedTableId]);

  const handleSetExcludedTranslateLangs = useCallback((newSet) => {
    setExcludedTranslateLangs(newSet);
    if (selectedTableId) {
      try {
        localStorage.setItem(`glossa_excluded_translate_langs_${selectedTableId}`, JSON.stringify(Array.from(newSet)));
        localStorage.setItem('glossa_excluded_translate_langs', JSON.stringify(Array.from(newSet)));
      } catch {}
    }
  }, [selectedTableId]);

  const handleToggleExcludeLang = useCallback((lang) => {
    const next = new Set(excludedTranslateLangs);
    if (next.has(lang)) {
      next.delete(lang);
    } else {
      next.add(lang);
    }
    handleSetExcludedTranslateLangs(next);
  }, [excludedTranslateLangs, handleSetExcludedTranslateLangs]);

  const handleOpenBatchTranslate = async () => {
    let targetRecords = records;
    if (selectedRecordIds.size > 0) {
      targetRecords = records.filter(r => selectedRecordIds.has(r.recordId || r.id));
    }

    const activeTargetLangs = TARGET_LANGUAGES.filter(lang => !excludedTranslateLangs.has(lang));

    const itemsToTranslate = targetRecords.map(r => {
      const fields = r.fields || {};
      const zhCn = (fields['CN（中文）'] || '').trim();
      if (!zhCn) return null; // Skip terms without Chinese source text
      
      const missingLangs = activeTargetLangs.filter(lang => !fields[lang] || String(fields[lang]).trim() === '');
      if (missingLangs.length === 0) return null;
      
      return {
        recordId: r.recordId || r.id,
        KW: fields['KW'] || '',
        '中文': zhCn,
        '所在页面': fields['所在页面'] || '',
        existingFields: fields,
        missingLangs,
        translations: {}
      };
    }).filter(Boolean);

    if (itemsToTranslate.length === 0) {
      if (selectedRecordIds.size > 0) {
        if (targetRecords.length === 0) {
          toast.info('选中的记录不在当前表中, 请重新勾选');
        } else {
          toast.info('选中的词条在当前翻译语种范围内均已完成翻译');
        }
      } else {
        toast.info('当前表格中在选定语种范围内没有待翻译的词条');
      }
      return;
    }

    setBatchTargetTableId(selectedTableId);
    setBatchPreviewList(itemsToTranslate);
    setBatchTranslateOpen(true);
    setBatchProgress({ total: itemsToTranslate.length, current: 0, status: '等待开始批量翻译' });
    setSelectedBatchItemIds(new Set(itemsToTranslate.map(i => i.recordId)));
  };

  // Dynamically update missing languages when excludedTranslateLangs changes while modal is open
  useEffect(() => {
    if (batchTranslateOpen && batchPreviewList.length > 0) {
      const activeTargetLangs = targetLanguagesList.filter(lang => !excludedTranslateLangs.has(lang));
      setBatchPreviewList(prev => prev.map(item => {
        const fields = item.existingFields || {};
        const missingLangs = activeTargetLangs.filter(lang => !fields[lang] || String(fields[lang]).trim() === '');
        return {
          ...item,
          missingLangs
        };
      }));
    }
  }, [excludedTranslateLangs, batchTranslateOpen, targetLanguagesList, batchPreviewList.length]);

  const handleStartBatchTranslate = async () => {
    setIsTranslatingBatch(true);
    // 本地工作副本 + 节流刷新：不再直接变异 state 对象，也不每条都全量 setState
    const workingList = batchPreviewList.map(item => ({ ...item }));
    let successCount = 0;
    let errorCount = 0;

    // 攒批刷新：每翻译完 2 条或距上次刷新超过 300ms 才真正 setState 一次
    let pendingFlush = 0;
    let lastFlushAt = Date.now();
    const flushPreview = (force = false) => {
      const now = Date.now();
      if (force || pendingFlush >= 2 || now - lastFlushAt >= 300) {
        setBatchPreviewList([...workingList]);
        pendingFlush = 0;
        lastFlushAt = now;
      }
    };

    const activeTargetLangs = targetLanguagesList.filter(lang => !excludedTranslateLangs.has(lang));

    // 收集所有待翻译的任务项
    const tasks = [];
    for (let i = 0; i < workingList.length; i++) {
      const item = workingList[i];
      if (!selectedBatchItemIds.has(item.recordId)) continue;
      
      const effectiveMissingLangs = (item.missingLangs || []).filter(l => activeTargetLangs.includes(l));
      if (effectiveMissingLangs.length === 0) continue;
      tasks.push({ item, index: i, effectiveMissingLangs });
    }

    if (tasks.length === 0) {
      setIsTranslatingBatch(false);
      setBatchProgress({ total: 0, current: 0, status: '所选项已全部翻译，无需重复翻译。' });
      return;
    }

    const totalTasks = tasks.length;
    let completedCount = 0;

    setBatchProgress({
      total: totalTasks,
      current: 0,
      status: `准备就绪，正在以并发模式启动翻译 (0/${totalTasks})...`
    });

    const translateTask = async (task) => {
      const { item, index: i, effectiveMissingLangs } = task;
      try {
        const targetLangsReq = effectiveMissingLangs.join(',');
        const existingTrans = extractExistingTranslations(item.existingFields, targetLanguagesList);

        let contextVal = (item['所在页面'] || '').trim();
        const refSnippet = formatExistingReferenceContext(existingTrans);
        if (refSnippet) {
          contextVal = contextVal ? `${contextVal} (${refSnippet})` : refSnippet;
        }

        const inputs = {
          KW: item.KW,
          text: item['中文'],
          context: contextVal || '无',
          target_languages: targetLangsReq,
          existing_translations: existingTrans,
          preserve_existing: true
        };

        let res = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            res = await apiFetch(`/api/projects/proj-default/ai-translate?debug=1`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ inputs }),
            timeoutMs: 110000,
            });
            if (res.ok) {
              lastErr = null;
              break;
            }
            const error = await res.json().catch(() => ({}));
            console.error(`🔍 [batch-translate] Dify error (attempt ${attempt + 1}):`, error);
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
        
        const trans = {};
        effectiveMissingLangs.forEach(lang => {
          const val = findTranslationForLang(result, lang);
          if (val) trans[lang] = val;
        });
        
        const nextItem = { ...workingList[i] };
        if (result._source === 'tm') {
          nextItem.tmMatch = true;
        }
        
        if (Object.keys(trans).length > 0) {
          nextItem.translations = { ...(nextItem.translations || {}), ...trans };
          successCount++;
        } else {
          errorCount++;
        }
        workingList[i] = nextItem;
      } catch (err) {
        errorCount++;
        console.error(`翻译词条 ${item.KW} 失败:`, err);
        toast.error(`翻译词条「${item.KW || item['中文']}」失败: ${err.message}`);
      } finally {
        completedCount++;
        pendingFlush++;
        flushPreview();
        setBatchProgress({
          total: totalTasks,
          current: completedCount,
          status: `正在并发翻译 (${completedCount}/${totalTasks}): ${item.KW || item['中文']}`
        });
      }
    };

    // 并发工作池 (3 路并发，在消除 600ms 冗余休眠的同时避免频控，提速 300%)
    const CONCURRENCY = 3;
    let taskPointer = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
      while (taskPointer < tasks.length) {
        const currentTask = tasks[taskPointer++];
        await translateTask(currentTask);
      }
    });

    await Promise.all(workers);

    // 循环结束强制终刷，确保后续「确认写入」能读到完整数据
    flushPreview(true);
    setIsTranslatingBatch(false);
    if (errorCount > 0) {
      setBatchProgress(prev => ({ 
        ...prev, 
        status: `批量翻译完成！${successCount} 条成功` + (errorCount > 0 ? `，${errorCount} 条失败/无输出` : '') + '。请检查预览内容。' 
      }));
    } else {
      setBatchProgress(prev => ({ ...prev, status: '批量翻译全部完成！请检查预览内容并确认写入。' }));
    }
  };

  const handleConfirmBatchWrite = async () => {
    try {
      setIsSavingBatch(true);
      const recordsToUpdate = [];
      
      batchPreviewList.forEach(item => {
        if (!selectedBatchItemIds.has(item.recordId)) return;
        const fields = {};
        let hasNewTrans = false;
        Object.keys(item.translations).forEach(lang => {
          if (item.translations[lang]) {
            fields[lang] = item.translations[lang];
            hasNewTrans = true;
          }
        });
        if (hasNewTrans) {
          recordsToUpdate.push({
            id: item.recordId,
            ...fields
          });
        }
      });

      if (recordsToUpdate.length === 0) {
        setBatchTranslateOpen(false);
        return;
      }

      const updatedForSync = recordsToUpdate.map(r => {
        const { id, ...newFields } = r;
        const existingRec = records.find(rec => (rec.recordId || rec.id) === id);
        const itemInPreview = batchPreviewList.find(i => i.recordId === id);

        const existingMeta = existingRec ? (existingRec.translationsMeta || {}) : {};
        const newMeta = { ...existingMeta };
        if (itemInPreview) {
          Object.keys(itemInPreview.translations || {}).forEach(lang => {
            if (itemInPreview.translations[lang]) {
              newMeta[lang] = itemInPreview.tmMatch ? 'tm' : 'ai';
            }
          });
        }

        return {
          recordId: id,
          fields: {
             ...(existingRec ? existingRec.fields : {}),
             ...newFields
          },
          translationsMeta: newMeta
        };
      });

      const res = await apiFetch(`/api/tables/${batchTargetTableId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ added: [], updated: updatedForSync })
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '写入失败');
      }
      
      toast.success('批量翻译写入成功');
      setModifiedCells(prev => {
        const newModified = { ...prev };
        recordsToUpdate.forEach(r => {
          const itemInPreview = batchPreviewList.find(i => i.recordId === r.id);
          const langs = {};
          if (itemInPreview && itemInPreview.translations) {
            Object.keys(itemInPreview.translations).forEach(l => {
              if (itemInPreview.translations[l]) langs[l] = true;
            });
          }
          newModified[r.id] = { ...(newModified[r.id] || {}), ...langs, isModified: true };
        });
        return newModified;
      });
      setBatchTranslateOpen(false);
      setBatchPreviewList([]);
      loadTableData(batchTargetTableId);
    } catch(err) {
      toast.error(err.message);
    } finally {
      setIsSavingBatch(false);
    }
  };

  // 仅拉取表格列表，不再依赖 selectedTableId（选中恢复逻辑拆到下方独立 effect）
  const loadTables = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch('/api/tables');
      if (res.ok) {
        const data = await res.json().catch(() => []);
        setTables(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('获取表格列表失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 选中表恢复：列表就绪后，若当前无选中或选中表已不存在，则恢复上次选中或选首表
  useEffect(() => {
    if (tables.length === 0) return;
    const savedTableId = safeGetLocalStorage('glossa_last_selected_table_id', '');
    const matched = tables.find(t => t.id === (selectedTableId || savedTableId));
    if (matched) {
      if (matched.id !== selectedTableId) {
        setSelectedTableId(matched.id);
      }
    } else if (!selectedTableId) {
      setSelectedTableId(tables[0].id);
    }
  }, [tables, selectedTableId, setSelectedTableId]);

  const [totalRecords, setTotalRecords] = useState(0);

  const loadTableData = useCallback(async (tableId) => {
    if (!tableId) return;
    // 竞态防护：本次请求领取唯一递增 id；任何更新的请求发出后，本响应即视为迟到并丢弃
    const myId = ++reqIdRef.current;
    try {
      setLoading(true);

      const queryParams = new URLSearchParams({
        page: currentPage,
        pageSize,
        search: debouncedSearchQuery,
        status: filterStatus,
        untranslated: filterUntranslated ? 'true' : 'false',
        sortBy,
        sortOrder
      });

      const res = await apiFetch(`/api/tables/${tableId}/records?${queryParams.toString()}`);

      if (myId !== reqIdRef.current) return;

      if (res.ok) {
        const rData = await res.json().catch(() => ({}));
        if (myId !== reqIdRef.current) return;
        setRecords(rData.records || []);
        setTotalRecords(rData.total || 0);
        // REMOVED: setModifiedCells({}) here to avoid pagination clearing

        const fMap = {
          'KW': 'KW',
          'CN（中文）': 'CN（中文）',
          '所在页面': '所在页面',
          '字号类别': '字号类别'
        };
        targetLanguagesList.forEach(lang => {
          fMap[lang] = lang;
        });

        setFieldMap(fMap);
      } else {
        toast.error('获取词条数据失败');
      }
    } catch (err) {
      if (myId === reqIdRef.current) {
        console.error('加载表格数据失败:', err);
        toast.error(`获取词条数据失败: ${err.message}`);
      }
    } finally {
      // 迟到响应不得打断新请求的 loading 态
      if (myId === reqIdRef.current) {
        setLoading(false);
      }
    }
  }, [currentPage, pageSize, debouncedSearchQuery, filterStatus, filterUntranslated, sortBy, sortOrder, toast, targetLanguagesList]);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  useEffect(() => {
    if (selectedTableId) {
      loadTableData(selectedTableId);
    }
  }, [selectedTableId, loadTableData]);

  const getRecordValue = useCallback((rec, fieldId) => {
    if (!rec || !rec.fields) return '';
    return rec.fields[fieldId] || '';
  }, []);

  const getRecordValueByName = useCallback((rec, fieldName) => {
    const fId = fieldMap[fieldName];
    if (fId) return getRecordValue(rec, fId);
    return rec?.fields ? rec.fields[fieldName] || '' : '';
  }, [fieldMap, getRecordValue]);

  const handleToggleSort = useCallback((field) => {
    if (sortField !== field) {
      setSortField(field);
      setSortDirection('asc');
    } else if (sortDirection === 'asc') {
      setSortDirection('desc');
    } else {
      setSortField(null);
      setSortDirection(null);
    }
  }, [sortField, sortDirection]);

  // Online browser sorting (does not affect DB export)
  const sortedRecords = useMemo(() => {
    if (!sortField || !sortDirection) {
      return records;
    }

    return [...records].sort((a, b) => {
      if (sortField === '#index' || sortField === 'index') {
        const ordA = a.sortOrder ?? a.sort_order ?? 0;
        const ordB = b.sortOrder ?? b.sort_order ?? 0;
        return sortDirection === 'asc' ? ordA - ordB : ordB - ordA;
      }

      if (sortField === 'status') {
        const stA = a.status || 'DRAFT';
        const stB = b.status || 'DRAFT';
        const cmp = stA.localeCompare(stB);
        return sortDirection === 'asc' ? cmp : -cmp;
      }

      if (sortField === 'progress') {
        const getProgressCount = (rec) => {
          let filled = 0;
          TARGET_LANGUAGES.forEach(lang => {
            const val = getRecordValueByName(rec, lang);
            if (val && String(val).trim()) filled++;
          });
          return filled;
        };
        const pA = getProgressCount(a);
        const pB = getProgressCount(b);
        return sortDirection === 'asc' ? pA - pB : pB - pA;
      }

      const valA = String(getRecordValueByName(a, sortField) || '');
      const valB = String(getRecordValueByName(b, sortField) || '');
      const cmp = valA.localeCompare(valB, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    // TARGET_LANGUAGES 即 targetLanguagesList 的渲染期别名，作为依赖与别名用法保持一致
  }, [records, sortField, sortDirection, getRecordValueByName, TARGET_LANGUAGES]);

  const paginatedRecords = sortedRecords;

  // 选中词条记忆化：引用稳定，避免父组件任意重渲染都产生新数组，
  // 导致 BatchGenerateKwModal 等子弹窗误判数据变化而重置用户输入
  const selectedTerms = useMemo(
    () => records.filter(r => selectedRecordIds.has(r.recordId || r.id)),
    [records, selectedRecordIds]
  );

  // Handlers
  // 单行锁定切换；返回 true/false 表示成功与否，供批量操作 Promise.allSettled 统计
  const handleToggleRowLock = useCallback(async (recId, currentLockState) => {
    const nextState = !currentLockState;
    try {
      setLockLoadingId(recId);
      const res = await apiFetch(`/api/terms/${recId}/lock`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isLocked: nextState })
      });
      if (res.ok) {
        toast.success(nextState ? '词条已成功锁定' : '词条已解锁');
        setRecords(prev => prev.map(r => r.recordId === recId ? { ...r, isLocked: nextState ? 1 : 0 } : r));
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      toast.error(errData.error || '操作失败');
      return false;
    } catch {
      toast.error('修改锁定状态失败');
      return false;
    } finally {
      setLockLoadingId('');
    }
  }, [toast]);

  const handleSelectAllOnPage = useCallback((checked) => {
    if (checked) {
      setSelectedRecordIds(prev => new Set([...prev, ...paginatedRecords.map(r => r.recordId || r.id)]));
    } else {
      const pageIds = new Set(paginatedRecords.map(r => r.recordId || r.id));
      setSelectedRecordIds(prev => new Set([...prev].filter(id => !pageIds.has(id))));
    }
  }, [paginatedRecords]);

  const handleToggleSelectRow = useCallback((recId, checked) => {
    setSelectedRecordIds(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(recId);
      } else {
        next.delete(recId);
      }
      return next;
    });
  }, []);

  // 打开编辑弹窗并清除该行的"已修改"高亮。
  // useCallback + 函数式 setState：引用稳定，不击穿子组件 memo
  const handleEditClick = useCallback((rec) => {
    setEditModalRecord(rec);
    const recId = rec.recordId || rec.id;
    if (!recId) return;
    setModifiedCells(prev => {
      if (!prev[recId]) return prev;
      const next = { ...prev };
      delete next[recId];
      return next;
    });
  }, []);

  // 批量锁定/解锁：并发执行 + allSettled 统计成功/失败数，完成后统一刷新表格数据
  const handleBatchLock = useCallback(async (lock) => {
    const ids = Array.from(selectedRecordIds);
    if (ids.length === 0) return;
    const results = await Promise.allSettled(
      ids.map(id => handleToggleRowLock(id, !lock))
    );
    const okCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    const failCount = ids.length - okCount;
    if (failCount > 0) {
      toast.error(`批量${lock ? '锁定' : '解锁'}完成：${okCount} 条成功，${failCount} 条失败`);
    } else {
      toast.success(`批量${lock ? '锁定' : '解锁'}完成：${okCount} 条成功`);
    }
    await loadTableData(selectedTableId);
  }, [selectedRecordIds, handleToggleRowLock, loadTableData, selectedTableId, toast]);

  const handleBatchApproveSubmit = async () => {
    if (selectedRecordIds.size === 0) return;
    const termIds = Array.from(selectedRecordIds);
    try {
      setLoading(true);
      const res = await apiFetch('/api/terms/batch-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          termIds,
          status: batchApproveStatus,
          rejectReason: batchApproveStatus === 'REJECTED' ? batchApproveRejectReason : undefined
        })
      });
      if (res.ok) {
        toast.success(`成功更新 ${termIds.length} 条词条处理状态为 ${batchApproveStatus}`);
        setBatchApproveOpen(false);
        setSelectedRecordIds(new Set());
        loadTableData(selectedTableId);
      } else {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || '批量审核失败');
      }
    } catch (err) {
      // apiFetch 非 ok 不抛 Response 而是返回 res（上面已处理）；此处 catch 到的均为 Error 对象
      toast.error(`批量审核失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 批量删除 (走回收站, 30 天可恢复)
  const handleBatchDelete = async () => {
    if (selectedRecordIds.size === 0) return;
    const termIds = Array.from(selectedRecordIds);
    if (!window.confirm(
      `确定要将选中的 ${termIds.length} 条词条送入回收站吗？\n\n` +
      `• 30 天内可在「数据回收站」一键恢复\n` +
      `• 已锁定的词条会被自动跳过\n` +
      `• 此操作会写入「批量删除」审计日志`
    )) {
      return;
    }
    try {
      setLoading(true);
      const res = await apiFetch('/api/terms/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termIds }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '批量删除失败');
      }
      const data = await res.json();
      const lockedNote = data.lockedSkipped > 0
        ? ` (跳过 ${data.lockedSkipped} 条已锁定词条)`
        : '';
      toast.success(`${data.message || '已删除'}${lockedNote}`);
      setSelectedRecordIds(new Set());
      await loadTableData(selectedTableId);
    } catch (err) {
      toast.error(err.message || '批量删除失败');
    } finally {
      setLoading(false);
    }
  };

  // 批量清空翻译（保留中文，删除其他所有目标语种翻译）
  const handleBatchClearTranslations = async () => {
    if (selectedRecordIds.size === 0) return;
    const termIds = Array.from(selectedRecordIds);
    if (!window.confirm(
      `确定要清空选中的 ${termIds.length} 条词条的全部目标语种翻译吗？\n\n` +
      `• 将保留中文（CN）及 KW、所在页面、字号类别等基础属性\n` +
      `• 清空全部目标语种（英文、法、德、西等）翻译内容\n` +
      `• 已锁定的词条将被自动跳过保护`
    )) {
      return;
    }
    try {
      setLoading(true);
      const res = await apiFetch('/api/terms/batch-clear-translations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termIds })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '批量清空翻译失败');
      }
      const data = await res.json();
      toast.success(data.message || `成功清空 ${termIds.length} 条词条的翻译！`);
      setSelectedRecordIds(new Set());
      await loadTableData(selectedTableId);
    } catch (err) {
      toast.error(err.message || '批量清空翻译失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchUpdateCategorySubmit = async () => {
    if (selectedRecordIds.size === 0) return;
    try {
      setLoading(true);
      const updates = {};
      if (batchUpdateFields.context) updates['所在页面'] = batchUpdateFields.context;
      if (batchUpdateFields.owner) updates['字号类别'] = batchUpdateFields.owner;

      const res = await apiFetch(`/api/terms/batch-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          termIds: Array.from(selectedRecordIds),
          updates
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '批量修改分类失败');
      }

      toast.success('批量更新分类成功！');
      setBatchUpdateOpen(false);
      setBatchUpdateFields({ context: '', owner: '' });
      setSelectedRecordIds(new Set());
      await loadTableData(selectedTableId);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBatchCopySubmit = async () => {
    if (selectedRecordIds.size === 0 || !batchCopyTargetTableId) return;
    try {
      setLoading(true);
      const res = await apiFetch(`/api/terms/batch-copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          termIds: Array.from(selectedRecordIds),
          targetVersionId: batchCopyTargetTableId,
          duplicateStrategy: batchCopyDuplicateStrategy
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '复制失败');
      }

      const result = await res.json().catch(() => ({}));
      toast.success(result.message || '复制成功！');
      setBatchCopyOpen(false);
      setSelectedRecordIds(new Set());
      if (batchCopyTargetTableId === selectedTableId) {
        await loadTableData(selectedTableId);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExportXLS = async () => {
    if (!selectedTableId) {
      toast.error('请选择需要导出的数据表！');
      return;
    }

    try {
      toast.info('正在导出 Excel 文件...');
      const res = await apiFetch(`/api/tables/${selectedTableId}/export-xls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modifiedCells,
          highlightIds: Object.keys(modifiedCells || {})
        }),
      timeoutMs: 120000,
      });
      if (res.ok) {
        const blob = await res.blob();
        const tableName = tables.find(t => t.id === selectedTableId)?.name || selectedTableId;
        downloadBlob(blob, buildExportFilename('GlossaHub', tableName, 'xlsx'));
        toast.success('导出 Excel 文件成功！');
      } else {
        const errData = await res.json().catch(() => ({}));
        toast.error(`导出失败: ${errData.error || '服务器响应异常'}`);
      }
    } catch (err) {
      console.error('导出异常:', err);
      toast.error(`导出失败: ${err.message}`);
    }
  };

  const handleExportCSV = async () => {
    if (!selectedTableId) {
      toast.error('请选择需要导出的数据表！');
      return;
    }

    try {
      toast.info('正在导出 CSV 文件...');
      const res = await apiFetch(`/api/tables/${selectedTableId}/export-csv`);
      if (res.ok) {
        const blob = await res.blob();
        const tableName = tables.find(t => t.id === selectedTableId)?.name || selectedTableId;
        downloadBlob(blob, buildExportFilename('GlossaHub', tableName, 'csv'));
        toast.success('导出 CSV 文件成功！');
      } else {
        const errData = await res.json().catch(() => ({}));
        toast.error(`导出 CSV 失败: ${errData.error || '服务器响应异常'}`);
      }
    } catch (err) {
      console.error('导出 CSV 异常:', err);
      toast.error(`导出 CSV 失败: ${err.message}`);
    }
  };

  const handleDataClean = async () => {
    if (!window.confirm('确定要清理当前数据表中的空词条（无KW或无中文）吗？这无法撤销！')) {
      return;
    }
    try {
      setLoading(true);
      const res = await apiFetch(`/api/tables/${selectedTableId}/clean-empty`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '清理失败');
      }
      const data = await res.json();
      toast.success(data.message || '清理完成');
      await loadTableData(selectedTableId);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '0.8rem 1.2rem', gap: '0.8rem' }}>
      <TranslationToolbar
        searchInput={searchInput}
        setSearchInput={(val) => {
          setSearchInput(val);
          setCurrentPage(1);
        }}
        totalRecords={totalRecords}
        difyConfigured={difyConfigured || difyConnected}
        filterStatus={filterStatus}
        setFilterStatus={(val) => {
          setFilterStatus(val);
          setCurrentPage(1);
        }}
        sortBy={sortBy}
        setSortBy={(val) => {
          setSortBy(val);
          setSortField(null);
          setSortDirection(null);
          setCurrentPage(1);
        }}
        filterUntranslated={filterUntranslated}
        setFilterUntranslated={(val) => {
          setFilterUntranslated(val);
          setCurrentPage(1);
        }}
        targetLanguages={targetLanguagesList}
        visibleLanguages={visibleLanguages}
        setVisibleLanguages={setVisibleLanguages}
        baseOptionalColumns={BASE_OPTIONAL_COLUMNS}
        hiddenBaseColumns={hiddenBaseColumns}
        setHiddenBaseColumns={setHiddenBaseColumns}
        tables={tables}
        selectedTableId={selectedTableId}
        setSelectedTableId={setSelectedTableId}
        selectedCount={selectedRecordIds.size}
        onClearSelection={() => setSelectedRecordIds(new Set())}
        onCopyContent={() => setCopyContentOpen(true)}
        onBatchClearTranslations={handleBatchClearTranslations}
        onBatchApprove={() => setBatchApproveOpen(true)}
        onBatchCategory={() => setBatchUpdateOpen(true)}
        onBatchCopy={() => setBatchCopyOpen(true)}
        onBatchLock={() => handleBatchLock(true)}
        onBatchUnlock={() => handleBatchLock(false)}
        onBatchDelete={handleBatchDelete}
        onExportXLS={handleExportXLS}
        onExportCSV={handleExportCSV}
        csvImportNode={
          <CSVImportHandler 
            selectedTableId={selectedTableId}
            currentRecords={records}
            targetLanguages={targetLanguagesList}
            onImportComplete={(diff) => {
              if (diff) {
                setModifiedCells(prev => {
                  const next = { ...prev };
                  if (Array.isArray(diff.added)) {
                    diff.added.forEach(item => {
                      if (item.recordId) next[item.recordId] = { isAdded: true };
                    });
                  }
                  if (Array.isArray(diff.updated)) {
                    diff.updated.forEach(item => {
                      if (item.recordId) next[item.recordId] = { isModified: true };
                    });
                  }
                  return next;
                });
              }
              // 导入完成后重置排序与分页，确保词条按照 CSV 文件的原始顺序呈现
              setSortBy('default');
              setSortField(null);
              setSortDirection(null);
              setCurrentPage(1);
              loadTableData(selectedTableId);
            }}
            disabled={loading}
          />
        }
        onAddTerm={() => setAddModalOpen(true)}
        onBatchAdd={() => setBatchAddModalOpen(true)}
        onInherit={() => setInheritOpen(true)}
        onBatchGenerateKw={() => setBatchGenerateKwOpen(true)}

        onBatchTranslate={handleOpenBatchTranslate}
        onDataClean={handleDataClean}
        onClearHighlights={() => setModifiedCells({})}
        modifiedCount={Object.keys(modifiedCells).length}
        loading={loading}
        projectRole={projectRole}
      />

      <TranslationTable
        loading={loading}
        records={records}
        paginatedRecords={paginatedRecords}
        totalRecords={totalRecords}
        safePage={currentPage}
        pageSize={pageSize}
        setCurrentPage={setCurrentPage}
        setPageSize={setPageSize}
        selectedRecordIds={selectedRecordIds}
        onSelectAll={handleSelectAllOnPage}
        onToggleSelectRow={handleToggleSelectRow}
        targetLanguages={targetLanguagesList}
        visibleLanguages={visibleLanguages}
        hiddenBaseColumns={hiddenBaseColumns}
        modifiedCells={modifiedCells}
        lockLoadingId={lockLoadingId}
        onToggleRowLock={handleToggleRowLock}
        currentUserRole={currentUser?.role}
        projectRole={projectRole}
        getRecordValueByName={getRecordValueByName}
        getRecordValue={getRecordValue}
        fieldMap={fieldMap}
        sortField={sortField}
        sortDirection={sortDirection}
        onToggleSort={handleToggleSort}
        onEditClick={handleEditClick}
      />

      {/* Subcomponent Modals */}
      <AddTermModal
        open={_addModalOpen}
        onClose={() => setAddModalOpen(false)}
        selectedTableId={selectedTableId}
        targetLanguages={TARGET_LANGUAGES}
        excludedTranslateLangs={excludedTranslateLangs}
        onAddSuccess={(addedItem) => {
          if (addedItem && addedItem.recordId) {
            setModifiedCells(prev => ({
              ...prev,
              [addedItem.recordId]: { isAdded: true }
            }));
          }
          loadTableData(selectedTableId);
        }}
      />

      <EditTermModal
        open={!!editModalRecord}
        record={editModalRecord}
        projectId="proj-default"
        targetLanguages={TARGET_LANGUAGES}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        currentUserRole={currentUser?.role}
        projectRole={projectRole}
        onClose={() => setEditModalRecord(null)}
        onSaveSuccess={() => loadTableData(selectedTableId)}
      />

      <InheritModal
        open={inheritOpen}
        onClose={() => setInheritOpen(false)}
        currentTableId={selectedTableId}
        tables={tables}
        onSuccess={() => loadTableData(selectedTableId)}
      />

      <BatchAddModal
        open={batchAddModalOpen}
        onClose={() => setBatchAddModalOpen(false)}
        selectedTableId={selectedTableId}
        targetLanguages={TARGET_LANGUAGES}
        onAddSuccess={(addedItems) => {
          if (Array.isArray(addedItems)) {
            setModifiedCells(prev => {
              const next = { ...prev };
              addedItems.forEach(item => {
                if (item.recordId) next[item.recordId] = { isAdded: true };
              });
              return next;
            });
          }
          loadTableData(selectedTableId);
        }}
      />

      {/* M7: 原 <HistoryModal> 及其 snapshots/loadingSnapshots/rollingBackId 死 state 已移除 ——
          修改历史/回退能力现由 EditTermModal 右侧 HistoryPanel 承载 */}

      <BatchCategoryModal
        open={batchUpdateOpen}
        onClose={() => setBatchUpdateOpen(false)}
        selectedCount={selectedRecordIds.size}
        batchUpdateFields={batchUpdateFields}
        setBatchUpdateFields={setBatchUpdateFields}
        onSubmit={handleBatchUpdateCategorySubmit}
        loading={loading}
      />

      <BatchCopyModal
        open={batchCopyOpen}
        onClose={() => setBatchCopyOpen(false)}
        selectedCount={selectedRecordIds.size}
        tables={tables}
        currentTableId={selectedTableId}
        batchCopyTargetTableId={batchCopyTargetTableId}
        setBatchCopyTargetTableId={setBatchCopyTargetTableId}
        duplicateStrategy={batchCopyDuplicateStrategy}
        setDuplicateStrategy={setBatchCopyDuplicateStrategy}
        onSubmit={handleBatchCopySubmit}
        loading={loading}
      />

      <BatchApproveModal
        open={batchApproveOpen}
        onClose={() => setBatchApproveOpen(false)}
        selectedCount={selectedRecordIds.size}
        status={batchApproveStatus}
        setStatus={setBatchApproveStatus}
        rejectReason={batchApproveRejectReason}
        setRejectReason={setBatchApproveRejectReason}
        onSubmit={handleBatchApproveSubmit}
        loading={loading}
      />

      <BatchTranslateModal
        open={batchTranslateOpen}
        onClose={() => setBatchTranslateOpen(false)}
        tables={tables}
        batchTargetTableId={batchTargetTableId}
        onBatchTargetTableChange={(id) => setBatchTargetTableId(id)}
        batchPreviewList={batchPreviewList}
        selectedBatchItemIds={selectedBatchItemIds}
        setSelectedBatchItemIds={setSelectedBatchItemIds}
        batchProgress={batchProgress}
        isTranslatingBatch={isTranslatingBatch}
        isSavingBatch={isSavingBatch}
        onStartBatchTranslate={handleStartBatchTranslate}
        onConfirmBatchWrite={handleConfirmBatchWrite}
        targetLanguages={TARGET_LANGUAGES}
        excludedTranslateLangs={excludedTranslateLangs}
        onToggleExcludeLang={handleToggleExcludeLang}
        onSetExcludedLangs={handleSetExcludedTranslateLangs}
      />

      <CopyContentModal
        open={copyContentOpen}
        onClose={() => setCopyContentOpen(false)}
        selectedRecords={selectedTerms}
        targetLanguages={TARGET_LANGUAGES}
        getRecordValueByName={getRecordValueByName}
      />

      <BatchGenerateKwModal
        open={batchGenerateKwOpen}
        onClose={() => setBatchGenerateKwOpen(false)}
        selectedTableId={selectedTableId}
        tableName={tables.find(t => t.id === selectedTableId)?.name || ''}
        selectedTerms={selectedTerms}
        allRecords={records}
        onSuccess={() => loadTableData(selectedTableId)}
      />
    </div>
  );
}
