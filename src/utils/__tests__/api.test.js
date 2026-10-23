import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from '../api';

// ============================================================
// Mock 全局 fetch 和 localStorage
// ============================================================
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// 简易内存 localStorage mock
function createLocalStorageMock() {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, val) => { store[key] = String(val); }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    _getStore: () => store,
  };
}

describe('apiFetch', () => {
  let localStorageMock;

  beforeEach(() => {
    localStorageMock = createLocalStorageMock();
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('当 localStorage 中存在 token 时，附带 Authorization 头', async () => {
    localStorageMock.getItem.mockReturnValue('my-jwt-token');
    mockFetch.mockResolvedValue({ status: 200 });

    await apiFetch('/api/data');

    expect(mockFetch).toHaveBeenCalledWith('/api/data', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer my-jwt-token',
      },
    });
  });

  it('当 localStorage 中无 token 时，不附带 Authorization 头', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    mockFetch.mockResolvedValue({ status: 200 });

    await apiFetch('/api/data');

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders).not.toHaveProperty('Authorization');
    expect(callHeaders['Content-Type']).toBe('application/json');
  });

  it('401 响应且无 X-Business-Error: 清除 localStorage 并重定向 (用户会话失效)', async () => {
    localStorageMock.getItem.mockReturnValue('expired-token');
    mockFetch.mockResolvedValue({
      status: 401,
      headers: { get: (k) => (k.toLowerCase() === 'x-business-error' ? null : '') },
    });

    // Mock window.location.href
    const originalLocation = window.location;
    delete window.location;
    window.location = { href: '' };

    await expect(apiFetch('/api/data')).rejects.toThrow('登录已过期，请重新登录');

    expect(localStorageMock.removeItem).toHaveBeenCalledWith('token');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('user');
    expect(window.location.href).toBe('/');

    // 恢复 window.location
    window.location = originalLocation;
  });

  it('401 响应且带 X-Business-Error: 不清除 token, 不跳登录 (业务级 401, 例如 Dify upstream 拒签)', async () => {
    localStorageMock.getItem.mockReturnValue('valid-token');
    mockFetch.mockResolvedValue({
      status: 401,
      headers: { get: (k) => (k.toLowerCase() === 'x-business-error' ? 'dify-upstream-rejected' : '') },
    });

    const originalLocation = window.location;
    delete window.location;
    window.location = { href: '' };

    // 不应 throw, 应返回 response 让调用方处理
    const res = await apiFetch('/api/projects/proj-default/dify-test', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(localStorageMock.removeItem).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');

    window.location = originalLocation;
  });

  it('透传 options 中的自定义 headers', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    mockFetch.mockResolvedValue({ status: 200 });

    await apiFetch('/api/data', {
      headers: { 'X-Custom': 'value' },
    });

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['X-Custom']).toBe('value');
  });

  it('正确合并 Content-Type 头', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    mockFetch.mockResolvedValue({ status: 200 });

    await apiFetch('/api/upload', {
      headers: { 'Content-Type': 'multipart/form-data' },
    });

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    // options.headers 会覆盖默认的 Content-Type
    expect(callHeaders['Content-Type']).toBe('multipart/form-data');
  });

  it('网络异常时抛出错误', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiFetch('/api/data')).rejects.toThrow('网络请求失败');
  });

  it('503 响应时抛出包含服务器提示的友好错误 (数据库休眠或不可用)', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      status: 503,
      clone: () => ({
        json: async () => ({ error: '云端数据库正在从休眠中唤醒，请稍候 30 秒刷新重试。' })
      })
    });

    await expect(apiFetch('/api/terms')).rejects.toThrow('云端数据库正在从休眠中唤醒，请稍候 30 秒刷新重试。');
  });

  it('透传其他 options 参数（如 method, body）', async () => {
    localStorageMock.getItem.mockReturnValue('tok');
    mockFetch.mockResolvedValue({ status: 200 });

    const body = JSON.stringify({ key: 'val' });
    await apiFetch('/api/data', { method: 'POST', body });

    const callOpts = mockFetch.mock.calls[0][1];
    expect(callOpts.method).toBe('POST');
    expect(callOpts.body).toBe(body);
  });
});
