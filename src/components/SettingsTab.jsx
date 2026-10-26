import React, { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { Trash2, RotateCcw, AlertCircle, Loader2, Rocket } from 'lucide-react';
import { useToast } from './Toast';
import { formatLocaleDateTime } from '../utils/dateTime';

// 内置密钥占位文案 —— 前端不再持有真实密钥明文，实际 key 由后端解析注入。
// 提交配置时若仍为该占位值，则不传 apiKey，由服务端按 baseUrl 托管解析
const BUILTIN_KEY_PLACEHOLDER = '内置 Key（由服务端托管）';

export default function SettingsTab({ 
  onConnectionStatusChange,
  projectRole = 'viewer'
}) {
  const toast = useToast();
  const [activeSubTab, setActiveSubTab] = useState('engine'); // 'engine' | 'recycle'

  // Dify Configuration states
  const [difyUrl, setDifyUrl] = useState('https://api.dify.ai/v1');
  const [difyKey, setDifyKey] = useState('');
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [isCustom, setIsCustom] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState('magene_night'); // 'magene_night' | 'dify_cloud' | 'custom'

  const handleApplyPreset = (presetType) => {
    setSelectedPreset(presetType);
    if (presetType === 'magene_night') {
      setDifyUrl('https://night.magene.cn/v1');
      // 显示占位符提示用户这是内置 key, 实际 key 由后端解析（前端不持有明文）
      setDifyKey(BUILTIN_KEY_PLACEHOLDER);
      toast.info('已加载 [迈金 Night 专用引擎] 内置预设');
    } else if (presetType === 'dify_cloud') {
      setDifyUrl('https://api.dify.ai/v1');
      // 不再强制清空 — 后端会按 baseUrl 自动解析内置 key,
      // 用户留空 = “使用内置 Dify App key” 的语义, 而非”未配置”
      setDifyKey('');
      toast.info('已加载 [Dify 官方云服务] 内置预设 (Key 由服务端自动解析)');
    } else if (presetType === 'custom') {
      toast.info('请在下方手动输入自定义 API 服务器与 API Key');
    }
  };

  // Recycle Bin states
  const [recycleItems, setRecycleItems] = useState([]);
  const [loadingRecycle, setLoadingRecycle] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState(null);

  // Load Dify configuration status
  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await apiFetch('/api/projects/proj-default/dify');
        if (res.ok) {
          const data = await res.json();
          if (data.baseUrl) {
            setDifyUrl(data.baseUrl);
            if (data.baseUrl.includes('night.magene.cn')) {
              setSelectedPreset('magene_night');
              // 内置 key 仅作 UI 占位符显示（前端不回显明文）, 真实校验由后端做
              setDifyKey(BUILTIN_KEY_PLACEHOLDER);
            } else if (data.baseUrl.includes('api.dify.ai')) {
              setSelectedPreset('dify_cloud');
              // 不填 key — 后端会按 baseUrl 自动解析内置 Dify App key
              setDifyKey('');
            } else {
              setSelectedPreset('custom');
            }
          }
          setKeyConfigured(data.apiKeyConfigured);
          setIsCustom(!!data.isCustom);
          setShowOverride(!!data.isCustom);
        }
      } catch (err) {
        console.error('加载 Dify 配置状态失败:', err);
      }
    }
    loadConfig();
  }, []);

  const dififyUrlClean = (url) => {
    return (url || '').replace(/\/$/, '').trim();
  };

  const handleSave = async () => {
    if (!difyUrl) {
      toast.error('接口地址不能为空！');
      return;
    }
    setSaving(true);

    try {
      const res = await apiFetch('/api/projects/proj-default/dify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        // 占位符不提交 —— 由服务端按 baseUrl 解析托管的内置 Key
        body: JSON.stringify({ baseUrl: dififyUrlClean(difyUrl), apiKey: (difyKey && difyKey !== BUILTIN_KEY_PLACEHOLDER) ? difyKey : undefined })
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('配置已成功保存！已为您接入所选 Dify 引擎。');
        setKeyConfigured(true);
        setIsCustom(true);
        onConnectionStatusChange(true);
      } else {
        toast.error(`保存失败: ${data.error}`);
      }
    } catch (err) {
      toast.error(`保存异常: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!difyUrl) {
      toast.error('请填写接口地址！');
      return;
    }

    setTesting(true);

    try {
      const res = await apiFetch('/api/projects/proj-default/dify-test?debug=1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ baseUrl: dififyUrlClean(difyUrl), apiKey: difyKey && difyKey !== BUILTIN_KEY_PLACEHOLDER ? difyKey : undefined }),
      timeoutMs: 100000,
      });
      const data = await res.json();
      setTesting(false);

      if (res.ok) {
        toast.success('连接测试成功！Dify 工作流对接正常。');
        onConnectionStatusChange(true);
      } else {
        console.error('🔍 [dify-test] error:', data);
        const debugInfo = data.debug
          ? ` | [debug] status=${data.debug.difyStatus} url=${data.debug.targetUrl} key=${data.debug.keySuffix} | raw=${data.debug.difyRaw?.slice(0, 200)}`
          : '';
        toast.error((data.error || '连接测试失败') + debugInfo, { duration: 10000 });
        onConnectionStatusChange(false);
      }
    } catch (err) {
      setTesting(false);
      toast.error(`请求异常: ${err.message}`);
      onConnectionStatusChange(false);
    }
  };

  // Recycle Bin handlers
  const fetchRecycleItems = async () => {
    setLoadingRecycle(true);
    try {
      const res = await apiFetch('/api/projects/proj-default/recycle-bin');
      if (res.ok) {
        const data = await res.json();
        setRecycleItems(data);
      }
    } catch (err) {
      console.error('加载回收站数据失败:', err);
    } finally {
      setLoadingRecycle(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'recycle') {
      fetchRecycleItems();
    }
  }, [activeSubTab]);

  const handleRestore = async (id, name, type) => {
    const typeCn = type === 'version' ? '数据表' : type === 'language' ? '语种' : '词汇表';
    if (!window.confirm(`确定要恢复已删除的 ${typeCn} [${name}] 吗？恢复后所有关联数据及翻译将完整还原。`)) {
      return;
    }

    setActionLoadingId(id);
    try {
      const res = await apiFetch(`/api/recycle-bin/${id}/restore`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message || '恢复数据成功！');
        fetchRecycleItems();
      } else {
        toast.error(data.error || '恢复数据失败');
      }
    } catch (err) {
      toast.error('网络请求异常: ' + err.message);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handlePurge = async (id, name, type) => {
    const typeCn = type === 'version' ? '数据表' : type === 'language' ? '语种' : '词汇表';
    if (!window.confirm(`⚠️ 警示：彻底删除是毁灭性动作，将无法二次找回！\n您确定要彻底销毁被删除的 ${typeCn} [${name}] 吗？`)) {
      return;
    }

    setActionLoadingId(id);
    try {
      const res = await apiFetch(`/api/recycle-bin/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message || '数据已彻底销毁。');
        fetchRecycleItems();
      } else {
        toast.error(data.error || '彻底删除失败');
      }
    } catch (err) {
      toast.error('网络请求异常: ' + err.message);
    } finally {
      setActionLoadingId(null);
    }
  };

  // 日期时间格式化已统一收敛到 src/utils/dateTime.js（formatLocaleDateTime）

  return (
    <div style={{ padding: '1.5rem', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      
      {/* Header */}
      <div className="tab-header" style={{ marginBottom: '1.5rem', flexShrink: 0 }}>
        <h2 style={{ margin: '0 0 0.25rem 0', fontSize: '1.75rem', fontWeight: '800', letterSpacing: '-0.02em' }}>系统管理与设置</h2>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>配置外部 AI 智能翻译连接，或在数据回收站中找回误删的历史字典数据。</p>
      </div>

      {/* Sub-tabs Selection */}
      {projectRole === 'owner' && (
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', flexShrink: 0 }}>
          <button 
            onClick={() => setActiveSubTab('engine')}
            className={`btn ${activeSubTab === 'engine' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '0.82rem', height: '32px', padding: '0 1rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
          >
            ⚙️ 翻译引擎设置
          </button>
          <button 
            onClick={() => setActiveSubTab('recycle')}
            className={`btn ${activeSubTab === 'recycle' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '0.82rem', height: '32px', padding: '0 1rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
          >
            🗑️ 数据回收站
          </button>
        </div>
      )}

      {/* SUBTAB 1: Dify Translation Engine */}
      {activeSubTab === 'engine' && (
        <div className="settings-container" style={{ maxWidth: '650px' }}>
          <h3 className="settings-title">Dify 翻译工作流配置</h3>
          
          {/* Connection Status Card */}
          <div style={{
            padding: '1rem 1.25rem',
            borderRadius: '0.6rem',
            border: `1px solid var(--border-color)`,
            backgroundColor: 'var(--bg-secondary)',
            marginBottom: '1rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
              <div className={`status-dot ${keyConfigured ? 'active' : 'inactive'}`} />
              <strong style={{ fontSize: '0.95rem' }}>
                {keyConfigured ? '翻译引擎已就绪' : '翻译引擎未配置'}
              </strong>
            </div>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              {keyConfigured
                ? (isCustom
                    ? '当前已配置自定义覆盖接口。如需恢复系统内置默认引擎，请在高级配置中更新。'
                    : '当前使用系统预装的迈金内置 Dify 默认工作流引擎，开箱即用，无需配置。')
                : '系统尚未配置翻译引擎，调用 AI 翻译可能会失败，请在高级配置中填写参数。'}
            </p>
            <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              接口地址: <code>{difyUrl}</code>
            </div>
          </div>

          {/* Quick Engine Presets Bar */}
          <div style={{
            padding: '1rem 1.25rem',
            borderRadius: '0.6rem',
            border: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-secondary)',
            marginBottom: '1rem'
          }}>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <Rocket size={15} aria-hidden="true" style={{ color: 'var(--accent)' }} />
                快速切换 Dify 引擎预设
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>点击下方预设可快速填入参数</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.6rem' }}>
              <div 
                onClick={() => handleApplyPreset('magene_night')}
                style={{
                  padding: '0.6rem 0.8rem',
                  borderRadius: '6px',
                  border: `1.5px solid ${selectedPreset === 'magene_night' ? 'var(--accent)' : 'var(--border-color)'}`,
                  backgroundColor: selectedPreset === 'magene_night' ? 'rgba(99, 102, 241, 0.08)' : 'var(--bg-primary)',
                  cursor: 'pointer',
                  transition: 'all 0.15s'
                }}
              >
                <div style={{ fontSize: '0.82rem', fontWeight: '600', color: 'var(--text-primary)' }}>⚡ 迈金 Night 专用引擎</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>night.magene.cn</div>
              </div>

              <div 
                onClick={() => handleApplyPreset('dify_cloud')}
                style={{
                  padding: '0.6rem 0.8rem',
                  borderRadius: '6px',
                  border: `1.5px solid ${selectedPreset === 'dify_cloud' ? 'var(--accent)' : 'var(--border-color)'}`,
                  backgroundColor: selectedPreset === 'dify_cloud' ? 'rgba(99, 102, 241, 0.08)' : 'var(--bg-primary)',
                  cursor: 'pointer',
                  transition: 'all 0.15s'
                }}
              >
                <div style={{ fontSize: '0.82rem', fontWeight: '600', color: 'var(--text-primary)' }}>🌐 Dify 官方云服务</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>api.dify.ai</div>
              </div>

              <div 
                onClick={() => handleApplyPreset('custom')}
                style={{
                  padding: '0.6rem 0.8rem',
                  borderRadius: '6px',
                  border: `1.5px solid ${selectedPreset === 'custom' ? 'var(--accent)' : 'var(--border-color)'}`,
                  backgroundColor: selectedPreset === 'custom' ? 'rgba(99, 102, 241, 0.08)' : 'var(--bg-primary)',
                  cursor: 'pointer',
                  transition: 'all 0.15s'
                }}
              >
                <div style={{ fontSize: '0.82rem', fontWeight: '600', color: 'var(--text-primary)' }}>⚙️ 手动自定义引擎</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>自建服务器/其他地址</div>
              </div>
            </div>
          </div>

          {/* Toggle advanced override */}
          {projectRole === 'owner' ? (
            <button
              onClick={() => setShowOverride(v => !v)}
              className="btn btn-secondary"
              style={{ marginBottom: '1rem', fontSize: '0.82rem', padding: '0.45rem 0.8rem' }}
            >
              {showOverride ? '收起 API 配置' : (isCustom ? '修改 API 服务器及 Key 参数' : '查看/编辑 API 参数细节')}
            </button>
          ) : (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', fontStyle: 'italic' }}>
              * 提示：仅项目所有者 (Owner) 可更改翻译引擎的 API 配置。
            </div>
          )}

          {showOverride && projectRole === 'owner' && (
            <>
              <div className="form-group">
                <label>引擎预设选择</label>
                <select
                  value={selectedPreset}
                  onChange={(e) => handleApplyPreset(e.target.value)}
                  className="select-input"
                  style={{ width: '100%', marginBottom: '0.5rem' }}
                >
                  <option value="magene_night">⚡ 迈金 Night 专用引擎 (night.magene.cn)</option>
                  <option value="dify_cloud">🌐 Dify 官方云服务 (api.dify.ai)</option>
                  <option value="custom">⚙️ 手动自定义服务器 & API Key</option>
                </select>
              </div>

              <div className="form-group">
                <label>Dify API 服务器地址 (Base URL)</label>
                <input 
                  type="text" 
                  value={difyUrl} 
                  onChange={(e) => {
                    setDifyUrl(e.target.value);
                    setSelectedPreset('custom');
                  }} 
                  placeholder="例如: https://night.magene.cn/v1"
                  className="text-input"
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Dify 平台提供的工作流 API 基础路径
                </span>
              </div>

              <div className="form-group">
                <label>
                  Dify API 密钥 (API Key) 
                  {keyConfigured && (
                    <span style={{ marginLeft: '0.5rem', color: 'var(--accent)', fontSize: '0.75rem', fontWeight: 'bold' }}>
                      ● {isCustom ? '当前已配置密钥' : '使用系统默认密钥'}
                    </span>
                  )}
                </label>
                <input
                  type="password"
                  value={difyKey}
                  onChange={(e) => {
                    setDifyKey(e.target.value);
                    setSelectedPreset('custom');
                  }}
                  placeholder={
                    keyConfigured
                      ? '留空保持当前配置，输入新密钥覆盖更新'
                      : (selectedPreset === 'magene_night'
                          ? '使用内置迈金 Night 引擎 Key (留空即可)'
                          : selectedPreset === 'dify_cloud'
                          ? '使用内置 Dify 官方云 Key (留空即可)'
                          : 'app-xxxxxxxxxxxxxxxxxxxxxxxx')
                  }
                  className="text-input"
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {selectedPreset === 'magene_night' || selectedPreset === 'dify_cloud'
                    ? '内置预设：留空由服务端自动填入运维预配置的 Key；如需用自己的 Key 覆盖，直接填入即可。'
                    : '工作流“API 访问”页面中生成的 Key (以 app- 开头)'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                <button 
                  onClick={handleTest} 
                  disabled={testing}
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                >
                  {testing ? '正在测试连接...' : '测试 API 连接'}
                </button>
                
                <button 
                  onClick={handleSave}
                  disabled={saving}
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                >
                  {saving ? '正在保存...' : '保存并应用此配置'}
                </button>
              </div>
            </>
          )}

          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem', marginTop: '1.5rem' }}>
            <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>配置安全提示</h4>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              * 平台默认开箱即用，一般无需在此处手动调整参数配置。<br />
              * 所有 API 凭证及请求由后端 Node.js 密闭代理，前端永不接触明文密钥，确保云密钥资产安全。<br />
              * 接口更改后会影响整个项目成员在进行翻译时的翻译请求来源。
            </p>
          </div>
        </div>
      )}

      {/* SUBTAB 2: Recycle Bin */}
      {activeSubTab === 'recycle' && projectRole === 'owner' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          
          <div className="alert-box alert-box-warning" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.2rem', padding: '0.75rem 1rem', background: 'var(--yellow-bg)', color: 'var(--yellow)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: '4px' }}>
            <AlertCircle size={18} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: '0.8rem', lineHeight: '1.4' }}>
              数据回收站为防止误删的安全阀。删除的大表（版本）、语种或专业词汇表会临时保存在回收站中。<strong>30 天后到期条目将被系统自动彻底清理</strong>，期间支持一键无损还原。
            </span>
          </div>

          <div style={{ flex: 1, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {loadingRecycle ? (
              <div className="flex-center" style={{ flex: 1, gap: '0.5rem', color: 'var(--text-muted)' }}>
                <Loader2 className="animate-spin" size={18} />
                <span style={{ fontSize: '0.85rem' }}>正在检索回收站历史数据...</span>
              </div>
            ) : recycleItems.length === 0 ? (
              <div className="flex-center" style={{ flex: 1, flexDirection: 'column', gap: '0.5rem', color: 'var(--text-muted)', padding: '4rem 0' }}>
                <span style={{ fontSize: '2.5rem' }}>🗑️</span>
                <span style={{ fontSize: '0.85rem' }}>回收站内空空如也，无任何待清理数据。</span>
              </div>
            ) : (
              <div style={{ overflow: 'auto', flex: 1 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border-color)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)' }}>
                      <th style={{ padding: '0.75rem 1rem' }}>类型</th>
                      <th style={{ padding: '0.75rem 1rem' }}>名称</th>
                      <th style={{ padding: '0.75rem 1rem' }}>删除操作人</th>
                      <th style={{ padding: '0.75rem 1rem' }}>删除时间</th>
                      <th style={{ padding: '0.75rem 1rem' }}>过期自动清除</th>
                      <th style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>操作选项</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recycleItems.map(item => {
                      const typeCn = item.entity_type === 'version' ? '固件大表' : item.entity_type === 'language' ? '翻译语种' : '词汇大表';
                      const badgeColor = item.entity_type === 'version' ? 'var(--accent)' : item.entity_type === 'language' ? 'var(--purple)' : 'var(--yellow)';
                      const isActionLoading = actionLoadingId === item.id;
                      
                      return (
                        <tr key={item.id} style={{ borderBottom: '1px solid var(--border-color)', transition: 'background-color 0.2s' }}>
                          <td style={{ padding: '0.75rem 1rem' }}>
                            <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', border: `1px solid ${badgeColor}`, color: badgeColor, borderRadius: '3px' }}>{typeCn}</span>
                          </td>
                          <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: 'var(--text-primary)' }}>{item.entity_name}</td>
                          <td style={{ padding: '0.75rem 1rem' }}>{item.deleted_by_name || '系统管理员'}</td>
                          <td style={{ padding: '0.75rem 1rem', color: 'var(--text-secondary)' }}>{formatLocaleDateTime(item.deleted_at)}</td>
                          <td style={{ padding: '0.75rem 1rem', color: 'var(--red)', fontWeight: 500 }}>{formatLocaleDateTime(item.expires_at)}</td>
                          <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                              <button 
                                onClick={() => handleRestore(item.id, item.entity_name, item.entity_type)}
                                disabled={isActionLoading}
                                className="btn btn-secondary"
                                style={{ height: '24px', padding: '0 0.5rem', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.2rem', borderColor: 'rgba(var(--accent-rgb), 0.3)', color: 'var(--accent)' }}
                              >
                                {isActionLoading ? <Loader2 className="animate-spin" size={10} /> : <RotateCcw size={10} />}
                                <span>一键恢复</span>
                              </button>
                              
                              <button 
                                onClick={() => handlePurge(item.id, item.entity_name, item.entity_type)}
                                disabled={isActionLoading}
                                className="btn btn-secondary"
                                style={{ height: '24px', padding: '0 0.5rem', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.2rem', borderColor: 'rgba(239, 68, 68, 0.2)', color: 'var(--red)' }}
                              >
                                {isActionLoading ? <Loader2 className="animate-spin" size={10} /> : <Trash2 size={10} />}
                                <span>彻底删除</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
