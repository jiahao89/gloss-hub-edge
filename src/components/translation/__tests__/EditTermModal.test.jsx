import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToastProvider } from '../../Toast';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditTermModal from '../EditTermModal';

// ============================================================
// EditTermModal — 编辑单条词条 + 一键生成 KW
//
// 回归测试: 之前 v1.2 重构时整个 inline 编辑模态框被删,
// 只剩 setEditModalRecord(rec) 调用, 编辑按钮无响应。
// 本组件恢复该功能 + "生成 KW" 按钮 (调用 /generate-kw 端点)。
// ============================================================

// Module-level fetch mock — must be installed before EditTermModal imports
// apiFetch, otherwise the apiFetch module captures a reference to the
// original global fetch. (Same pattern as src/utils/__tests__/api.test.js.)
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// In-memory localStorage stub — apiFetch calls localStorage.getItem('token')
// and jsdom's default localStorage throws "Cannot read properties of
// undefined" in some vitest runs. Same pattern as api.test.js.
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, val) => { store[key] = String(val); }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true, configurable: true });

describe('EditTermModal', () => {
  let mockOnClose;
  let mockOnSaveSuccess;

  beforeEach(() => {
    mockOnClose = vi.fn();
    mockOnSaveSuccess = vi.fn();
    mockFetch.mockReset();
  });

  const sampleRecord = {
    recordId: 'rec-123',
    id: 'rec-123',
    fields: {
      'KW': 'KW_EXISTING',
      'CN（中文）': '现有中文',
      '所在页面': '主页',
      '字号类别': '大号',
    },
  };

  const fieldMap = {
    'KW': 'f_kw',
    'CN（中文）': 'f_cn',
    '所在页面': 'f_page',
    '字号类别': 'f_size',
    'EN（英文）': 'f_en',
  };

  const getRecordValue = (rec, fId) => {
    const inv = { f_kw: 'KW', f_cn: 'CN（中文）', f_page: '所在页面', f_size: '字号类别', f_en: 'EN（英文）' };
    return rec.fields[inv[fId]] || '';
  };

  it('当 record 为 null 时, 不渲染任何内容', () => {
    const { container } = render(
      <ToastProvider>
        <EditTermModal
          open={false}
          record={null}
          onClose={mockOnClose}
        />
      </ToastProvider>
    );
    expect(container.querySelector('.modal-backdrop')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  it('打开模态框时, 用 record.fields 填充表单', () => {
    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={sampleRecord}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    // KW field 显示现有值
    expect(screen.getByDisplayValue('KW_EXISTING')).toBeInTheDocument();
    // CN 字段
    expect(screen.getByDisplayValue('现有中文')).toBeInTheDocument();
    // 模态框标题
    expect(screen.getByText('编辑词条')).toBeInTheDocument();
    // "生成 KW" 按钮存在
    expect(screen.getByText('生成 KW')).toBeInTheDocument();
  });

  it('点击"生成 KW"按钮: 调用 /generate-kw 端点, 用 CN 文本', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kw: 'KW_AUTO_GENERATED' }),
    });

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={sampleRecord}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('生成 KW').closest('button'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/proj-default/generate-kw'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: '现有中文', enText: '', context: '主页' }),
        })
      );
    });

    // 生成后, KW 输入框更新
    await waitFor(() => {
      expect(screen.getByDisplayValue('KW_AUTO_GENERATED')).toBeInTheDocument();
    });
  });

  it('CN 为空时点"生成 KW", 提示先填写 CN, 不调用端点', async () => {
    const emptyRecord = { ...sampleRecord, fields: { ...sampleRecord.fields, 'CN（中文）': '' } };

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={emptyRecord}
        fieldMap={fieldMap}
        getRecordValue={(rec, fId) => {
          const v = getRecordValue(rec, fId);
          return fId === 'f_cn' ? '' : v;
        }}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('生成 KW').closest('button'));

    // 不调用 fetch
    await waitFor(() => {
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it('点击"清空翻译": 确认后清空全部目标语言输入框 (不自动保存)', async () => {
    const origConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    const recWithEn = {
      ...sampleRecord,
      fields: { ...sampleRecord.fields, 'EN（英文）': 'old-en' },
    };

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={recWithEn}
        fieldMap={{ ...fieldMap }}
        getRecordValue={(rec, fId) => {
          const inv = { f_kw: 'KW', f_cn: 'CN（中文）', f_page: '所在页面', f_size: '字号类别', f_en: 'EN（英文）' };
          return rec.fields[inv[fId]] || '';
        }}
        targetLanguages={['EN（英文）']}
        projectRole="editor"
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('清空翻译').closest('button'));

    // EN 输入框被清空
    await waitFor(() => {
      expect(screen.queryByDisplayValue('old-en')).toBeNull();
    });
    // 中文源文本保留
    expect(screen.getByDisplayValue('现有中文')).toBeInTheDocument();
    // 未触发保存
    expect(mockOnSaveSuccess).not.toHaveBeenCalled();
    expect(mockOnClose).not.toHaveBeenCalled();

    window.confirm = origConfirm;
  });

  it('点击"重新翻译": 调用 ai-translate 并把结果写入全部语种输入框', async () => {
    // 按 URL 分发 mock, 不依赖请求顺序 (references 默认加载 vs ai-translate)
    mockFetch.mockImplementation((url) => {
      if (String(url).includes('ai-translate')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ 'EN（英文）': 'new-en' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={sampleRecord}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        projectRole="editor"
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('重新翻译').closest('button'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/proj-default/ai-translate'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    // AI 结果写入 EN 输入框
    await waitFor(() => {
      expect(screen.getByDisplayValue('new-en')).toBeInTheDocument();
    });
    // 未自动保存
    expect(mockOnSaveSuccess).not.toHaveBeenCalled();
  });

  it('重新翻译时，如果已有英语翻译，默认不纠正当前英语翻译，仅补充空白语种', async () => {
    const recordWithEn = {
      recordId: 'rec-456',
      id: 'rec-456',
      fields: {
        'KW': 'KW_CADENCE',
        'CN（中文）': '踏频',
        'EN（英文）': 'Existing Cadence',
        'FR（法）': ''
      }
    };

    mockFetch.mockImplementation((url) => {
      if (String(url).includes('ai-translate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            'EN（英文）': 'AI Modified Cadence', // AI 试图纠正/更改英语
            'FR（法）': 'Cadence FR'
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });

    render(
      <ToastProvider>
        <EditTermModal
          open={true}
          record={recordWithEn}
          fieldMap={{ ...fieldMap, 'FR（法）': 'f_fr' }}
          getRecordValue={getRecordValue}
          targetLanguages={['EN（英文）', 'FR（法）']}
          projectRole="editor"
          onClose={mockOnClose}
        />
      </ToastProvider>
    );

    // 验证初始状态：英语输入框显示已有的 "Existing Cadence"
    expect(screen.getByDisplayValue('Existing Cadence')).toBeInTheDocument();

    // 点击重新翻译（默认勾选"保留已有翻译"）
    fireEvent.click(screen.getByText('重新翻译').closest('button'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/proj-default/ai-translate'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"preserve_existing":true')
        })
      );
    });

    // 验证：已有的英语翻译没有被纠正/覆盖，仍为 "Existing Cadence"
    await waitFor(() => {
      expect(screen.getByDisplayValue('Existing Cadence')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('AI Modified Cadence')).not.toBeInTheDocument();
      // 空白的法语被填入
      expect(screen.getByDisplayValue('Cadence FR')).toBeInTheDocument();
    });
  });

  it('取消勾选"保留已有翻译"后，重新翻译将覆盖已有的英语翻译', async () => {
    const recordWithEn = {
      recordId: 'rec-456',
      id: 'rec-456',
      fields: {
        'KW': 'KW_CADENCE',
        'CN（中文）': '踏频',
        'EN（英文）': 'Existing Cadence',
        'FR（法）': ''
      }
    };

    mockFetch.mockImplementation((url) => {
      if (String(url).includes('ai-translate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            'EN（英文）': 'AI Overwritten Cadence',
            'FR（法）': 'Cadence FR'
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });

    render(
      <ToastProvider>
        <EditTermModal
          open={true}
          record={recordWithEn}
          fieldMap={{ ...fieldMap, 'FR（法）': 'f_fr' }}
          getRecordValue={getRecordValue}
          targetLanguages={['EN（英文）', 'FR（法）']}
          projectRole="editor"
          onClose={mockOnClose}
        />
      </ToastProvider>
    );

    // 取消勾选"保留已有翻译"
    const checkbox = screen.getByLabelText('保留已有翻译');
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // 点击重新翻译
    fireEvent.click(screen.getByText('重新翻译').closest('button'));

    // 验证：英语被覆盖为新结果 "AI Overwritten Cadence"
    await waitFor(() => {
      expect(screen.getByDisplayValue('AI Overwritten Cadence')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Existing Cadence')).not.toBeInTheDocument();
    });
  });

  it('viewer 角色不显示"清空翻译/重新翻译"按钮', () => {
    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={sampleRecord}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        projectRole="viewer"
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    expect(screen.queryByText('清空翻译')).toBeNull();
    expect(screen.queryByText('重新翻译')).toBeNull();
  });

  it('点击"保存修改": 调用 PUT /api/terms/:id 并触发 onSaveSuccess + onClose', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={sampleRecord}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
        onSaveSuccess={mockOnSaveSuccess}
      />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/terms/rec-123'),
        expect.objectContaining({ method: 'PUT' })
      );
      expect(mockOnSaveSuccess).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});

// ============================================================
// 右侧 tab: 跨版本参考 (TM) + 修改历史 (History)
//
// v1.2 重构后这两个功能从 EditTermModal 整体丢失,
// 现在恢复。后端端点 (GET /api/versions/:id/terms/:kw/references
// 和 GET /api/terms/:id/snapshots) 已存在, 只需验证前端正确调用。
// ============================================================

describe('EditTermModal 右侧 tab', () => {
  let mockOnClose;
  let mockOnSaveSuccess;

  beforeEach(() => {
    mockOnClose = vi.fn();
    mockOnSaveSuccess = vi.fn();
    mockFetch.mockReset();
  });

  const recordWithVersion = {
    recordId: 'rec-tm-1',
    id: 'rec-tm-1',
    versionId: 'ver-tm-1',
    kw: 'KW_TM_TEST',
    fields: { 'KW': 'KW_TM_TEST', 'CN（中文）': '测试TM' },
  };

  const fieldMap = { 'KW': 'f_kw', 'CN（中文）': 'f_cn' };
  const getRecordValue = (rec, fId) => {
    const inv = { f_kw: 'KW', f_cn: 'CN（中文）' };
    return rec.fields[inv[fId]] || '';
  };

  it('打开模态框时, 默认显示跨版本参考 tab 并调用 /references 端点', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ([
        { versionName: '海外 2.1', zh_cn: 'A', translations: { 'EN（英文）': 'A-en' }, owner: '王赵云', updatedAt: '2026-08-01' }
      ]),
    });

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={recordWithVersion}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/versions/ver-tm-1/terms/KW_TM_TEST/references'),
        expect.anything()
      );
    });

    // 跨版本参考 tab 显示版本名
    expect(await screen.findByText('海外 2.1')).toBeInTheDocument();
  });

  it('点击"修改历史" tab: 调用 /snapshots 端点', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([]) })  // /references (default load)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([
          { id: 'snap-1', termId: 'rec-tm-1', versionId: 'ver-tm-1', kw: 'KW_TM_TEST',
            zh_cn: '历史CN', translations: { 'EN（英文）': 'history-en' },
            createdAt: '2026-08-01T10:00:00Z', creatorName: '老王' }
        ]),
      });

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={recordWithVersion}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    // 切到"修改历史" tab — 用 role=tab 定位避免歧义
    const historyTab = screen.getByRole('tab', { name: /修改历史/ });
    fireEvent.click(historyTab);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/terms/rec-tm-1/snapshots'),
        expect.anything()
      );
    });

    // 等到快照渲染 — 操作者字段包含 "老王"
    expect(await screen.findByText(/老王/)).toBeInTheDocument();
  });

  it('点击"套用此版"按钮: 把跨版本翻译灌入左侧编辑表单', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ([
        { versionName: '海外 2.1', zh_cn: '源CN', translations: { 'EN（英文）': 'source-en' }, owner: '王赵云', updatedAt: '2026-08-01' }
      ]),
    });

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={recordWithVersion}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
      />
      </ToastProvider>
    );

    // 等跨版本参考数据加载
    const applyBtn = await screen.findByText(/套用此版/);
    fireEvent.click(applyBtn);

    // EN 字段更新为 source-en
    await waitFor(() => {
      const enInput = screen.getByDisplayValue('source-en');
      expect(enInput).toBeInTheDocument();
    });
  });

  it('点击"回退"按钮: 弹出 confirm 并调用 /rollback 端点', async () => {
    // Mock window.confirm
    const origConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([]) })  // /references
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([
          { id: 'snap-rb-1', termId: 'rec-tm-1', versionId: 'ver-tm-1',
            kw: 'KW_TM_TEST', zh_cn: '历史CN', translations: {},
            createdAt: '2026-08-01T10:00:00Z', creatorName: '老王' }
        ]),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });  // /rollback

    render(
      <ToastProvider>
        <EditTermModal
        open={true}
        record={recordWithVersion}
        fieldMap={fieldMap}
        getRecordValue={getRecordValue}
        targetLanguages={['EN（英文）']}
        onClose={mockOnClose}
        onSaveSuccess={mockOnSaveSuccess}
        currentUserRole="admin"  // 让 canRollback=true
      />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole('tab', { name: /修改历史/ }));
    const rollbackBtn = await screen.findByText('回退');
    fireEvent.click(rollbackBtn);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/terms/rec-tm-1/rollback'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ snapshotId: 'snap-rb-1' }),
        })
      );
    });

    window.confirm = origConfirm;
  });
});