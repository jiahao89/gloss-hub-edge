import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToastProvider } from '../../Toast';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AddTermModal from '../AddTermModal';

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

describe('AddTermModal - 智能翻译与已有翻译保护', () => {
  let mockOnClose;
  let mockOnAddSuccess;

  beforeEach(() => {
    mockOnClose = vi.fn();
    mockOnAddSuccess = vi.fn();
    mockFetch.mockReset();
  });

  it('翻译时，如果除了中文，还有已有英语翻译，默认不纠正当前英语翻译', async () => {
    mockFetch.mockImplementation((url) => {
      if (String(url).includes('ai-translate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            'EN（英文）': 'AI Modified English',
            'FR（法）': 'French Translation'
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    render(
      <ToastProvider>
        <AddTermModal
          open={true}
          onClose={mockOnClose}
          selectedTableId="tbl-1"
          targetLanguages={['EN（英文）', 'FR（法）']}
          onAddSuccess={mockOnAddSuccess}
        />
      </ToastProvider>
    );

    // 输入中文
    const cnInput = screen.getByPlaceholderText('请输入中文源文本...');
    fireEvent.change(cnInput, { target: { value: '踏频' } });

    // 手动先填入英文翻译
    const allInputs = screen.getAllByRole('textbox');
    // 目标语言输入框中找到 EN 输入框
    const enField = allInputs.find(input => input.closest('.form-group')?.textContent.includes('EN（英文）'));
    fireEvent.change(enField, { target: { value: 'User Custom Cadence' } });
    expect(enField).toHaveValue('User Custom Cadence');

    // 默认勾选 "保留已有翻译 (不纠正现存语种)"
    const checkbox = screen.getByLabelText('保留已有翻译 (不纠正现存语种)');
    expect(checkbox).toBeChecked();

    // 点击一键 AI 翻译
    fireEvent.click(screen.getByText('一键 AI 翻译').closest('button'));

    // 验证 API 入参包含 preserve_existing: true 以及 existing_translations
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/proj-default/ai-translate'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"preserve_existing":true')
        })
      );
    });

    // 验证：已有英语未被纠正，仍为 'User Custom Cadence'，空白法语被填入
    await waitFor(() => {
      expect(enField).toHaveValue('User Custom Cadence');
      const frField = allInputs.find(input => input.closest('.form-group')?.textContent.includes('FR（法）'));
      expect(frField).toHaveValue('French Translation');
    });
  });

  it('取消勾选"保留已有翻译"后，将覆盖已有的英语翻译', async () => {
    mockFetch.mockImplementation((url) => {
      if (String(url).includes('ai-translate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            'EN（英文）': 'AI Overwritten English',
            'FR（法）': 'French Translation'
          })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    render(
      <ToastProvider>
        <AddTermModal
          open={true}
          onClose={mockOnClose}
          selectedTableId="tbl-1"
          targetLanguages={['EN（英文）', 'FR（法）']}
          onAddSuccess={mockOnAddSuccess}
        />
      </ToastProvider>
    );

    const cnInput = screen.getByPlaceholderText('请输入中文源文本...');
    fireEvent.change(cnInput, { target: { value: '踏频' } });

    const allInputs = screen.getAllByRole('textbox');
    const enField = allInputs.find(input => input.closest('.form-group')?.textContent.includes('EN（英文）'));
    fireEvent.change(enField, { target: { value: 'User Custom Cadence' } });

    // 取消勾选
    const checkbox = screen.getByLabelText('保留已有翻译 (不纠正现存语种)');
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // 点击一键 AI 翻译
    fireEvent.click(screen.getByText('一键 AI 翻译').closest('button'));

    // 验证：英语被覆盖为 AI 结果
    await waitFor(() => {
      expect(enField).toHaveValue('AI Overwritten English');
    });
  });
});
