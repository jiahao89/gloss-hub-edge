/**
 * 统一 API 请求封装
 * 自动附带 JWT Token，**用户会话** 401 时自动跳转登录页
 * 支持通过环境变量配置 API 地址（云端部署）
 *
 * 注意: 业务级 401 (例如 Dify upstream 拒签) 由后端通过 X-Business-Error
 * header 标识, 不会触发跳转登录 — 用户可能仍然登录态正常,
 * 只是某个上游服务的 Key 失效了。
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('token');
  
  let res;
  try {
    res = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    if (err.message === 'Failed to fetch') {
      throw new Error('网络请求失败：后端服务可能正在唤醒中（约需 50 秒），请稍后刷新重试。');
    }
    throw err;
  }

  // 401: 仅当是当前用户的会话失效时才跳登录。
  // 后端用 X-Business-Error header 标识业务级错误 (例如 Dify upstream
  // 返回的 401/403), 这些不应让前端误判为登录态失效。
  if (res.status === 401 && !res.headers.get('X-Business-Error')) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
    throw new Error('登录已过期，请重新登录');
  }

  // 503: 数据库不可用或正在从休眠中唤醒
  if (res.status === 503) {
    let errMsg = '云端数据库连接失败或正在从休眠中唤醒，请稍候 30 秒刷新重试。';
    try {
      if (typeof res.clone === 'function') {
        const cloned = res.clone();
        const data = await cloned.json();
        if (data && data.error) errMsg = data.error;
      }
    } catch {}
    throw new Error(errMsg);
  }

  return res;
}

/**
 * 安全读取和解析 localStorage 中的 JSON 或普通字符串数据
 */
export function safeGetLocalStorage(key, defaultValue) {
  try {
    const item = localStorage.getItem(key);
    if (item === null || item === undefined) return defaultValue;
    try {
      return JSON.parse(item);
    } catch {
      return typeof defaultValue === 'string' ? item : defaultValue;
    }
  } catch {
    return defaultValue;
  }
}

