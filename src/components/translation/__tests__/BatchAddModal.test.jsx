import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToastProvider } from '../../Toast';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BatchAddModal from '../BatchAddModal';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

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

describe('BatchAddModal - 批量智能翻译与已有翻译保护', () => {
  let mockOnClose;
  let mockOnAddSuccess;

  beforeEach(() => {
    mockOnClose = vi.fn();
    mockOnAddSuccess = vi.fn();
    mockFetch.mockReset();
  });

  it('批量翻译时，默认保留行内已有英语翻译，不纠正/覆盖现存语种', async () => {
    mockFetch.mockImplementation((url) => {
      if (String(url).includes('ai-translate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            'EN（英文）': 'AI Modified English',
            'FR（法）': 'French Val'
          })
        });
      }
      if (String(url).includes('/sync')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    render(
      <ToastProvider>
        <BatchAddModal
          open={true}
          onClose={mockOnClose}
          selectedTableId="tbl-1"
          targetLanguages={['EN（英文）', 'FR（法）']}
          onAddSuccess={mockOnAddSuccess}
        />
      </ToastProvider>
    );

    // 第一行输入中文
    const cnInputs = screen.getAllByPlaceholderText('中文文本...');
    fireEvent.change(cnInputs[0], { target: { value: '速度' } });

    // 默认勾选 "保留已有翻译 (不纠正现存语种)"
    const checkbox = screen.getByLabelText('保留已有翻译 (不纠正现存语种)');
    expect(checkbox).toBeChecked();

    // 点击翻译并录入
    const translateBtn = screen.getByText(/自动翻译并录入/);
    fireEvent.click(translateBtn);

    // 等待翻译完成并写入 sync
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/sync'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    // 验证 sync 写入的数据
    const syncCall = mockFetch.mock.calls.find(call => String(call[0]).includes('/sync'));
    const syncBody = JSON.parse(syncCall[1].body);
    expect(syncBody.added[0].fields['CN（中文）']).toBe('速度');
    expect(syncBody.added[0].fields['FR（法）']).toBe('French Val');
  });
});
