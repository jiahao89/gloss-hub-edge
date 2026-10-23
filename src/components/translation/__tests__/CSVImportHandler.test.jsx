import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToastProvider } from '../../Toast';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CSVImportHandler from '../CSVImportHandler';

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

describe('CSVImportHandler - 词条按照 CSV 文件的顺序导入', () => {
  let mockOnImportComplete;

  beforeEach(() => {
    mockOnImportComplete = vi.fn();
    mockFetch.mockReset();
  });

  it('导入 CSV 时，词条严格按照 CSV 行的顺序设置 sortOrder', async () => {
    // Current database has 1 existing term
    const currentRecords = [
      {
        id: 'rec_existing_1',
        recordId: 'rec_existing_1',
        kw: 'KW_SECOND',
        zh_cn: '第二项',
        sort_order: 10,
        fields: {
          'KW': 'KW_SECOND',
          'CN（中文）': '第二项',
          'EN（英文）': 'Second Item'
        }
      },
      {
        id: 'rec_outside_csv',
        recordId: 'rec_outside_csv',
        kw: 'KW_OUTSIDE',
        zh_cn: '不在CSV中的项',
        sort_order: 20,
        fields: {
          'KW': 'KW_OUTSIDE',
          'CN（中文）': '不在CSV中的项'
        }
      }
    ];

    let syncPayload = null;

    mockFetch.mockImplementation((url, opts) => {
      if (String(url).includes('/records')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ records: currentRecords, total: 2 })
        });
      }
      if (String(url).includes('/sync') && opts?.method === 'POST') {
        syncPayload = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    const { container } = render(
      <ToastProvider>
        <CSVImportHandler
          selectedTableId="tbl-123"
          currentRecords={currentRecords}
          targetLanguages={['EN（英文）']}
          onImportComplete={mockOnImportComplete}
        />
      </ToastProvider>
    );

    // CSV with 3 rows:
    // Row 1: KW_FIRST (New term)
    // Row 2: KW_SECOND (Existing term, modified English)
    // Row 3: Empty KW, only Chinese (New term without KW)
    const csvContent = [
      'KW,CN（中文）,EN（英文）',
      'KW_FIRST,第一项,First Item',
      'KW_SECOND,第二项,Second Item Modified',
      ',第三项（无KW）,Third Item No KW'
    ].join('\n');

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const fileInput = container.querySelector('input[type="file"]');
    
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Wait for the preview modal to open
    await waitFor(() => {
      expect(screen.getByText('CSV 导入预览')).toBeInTheDocument();
    });

    // Click confirm import
    const confirmButton = screen.getByText(/确认导入/);
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(syncPayload).not.toBeNull();
    });

    // Verify sortOrder follows exact CSV row sequence:
    // 1. added[0] is Row 1 (KW_FIRST) -> sortOrder: 1
    const addedRow1 = syncPayload.added.find(r => r.fields['KW'] === 'KW_FIRST');
    expect(addedRow1).toBeDefined();
    expect(addedRow1.sortOrder).toBe(1);

    // 2. updated[0] is Row 2 (KW_SECOND) -> sortOrder: 2
    const updatedRow2 = syncPayload.updated.find(r => r.recordId === 'rec_existing_1');
    expect(updatedRow2).toBeDefined();
    expect(updatedRow2.sortOrder).toBe(2);

    // 3. added[1] is Row 3 (No KW) -> sortOrder: 3
    const addedRow3 = syncPayload.added.find(r => r.fields['CN（中文）'] === '第三项（无KW）');
    expect(addedRow3).toBeDefined();
    expect(addedRow3.sortOrder).toBe(3);

    // 4. reorder contains existing term outside CSV -> pushed after all CSV rows (sortOrder: 3 + 1 = 4)
    const reorderedOutside = syncPayload.reorder.find(r => r.recordId === 'rec_outside_csv');
    expect(reorderedOutside).toBeDefined();
    expect(reorderedOutside.sortOrder).toBe(4);

    expect(mockOnImportComplete).toHaveBeenCalled();
  });
});
