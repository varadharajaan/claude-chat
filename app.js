/* =====================================================
   Claude Chat — app.js
   Chat logic, streaming API, conversation management,
   log viewer, grouped model selector, projects,
   search, export, token stats, branching
   ===================================================== */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────
  const STORAGE_KEY = 'claude-chat-data';
  const THEME_KEY = 'claude-chat-theme';
  const MODEL_KEY = 'claude-chat-model';
  const PROXY_KEY = 'claude-chat-proxy';
  const PROJECT_KEY = 'claude-chat-active-project';
  const LOG_POLL_INTERVAL = 3000; // ms
  const LOG_WIDTH_KEY = 'claude-chat-log-width';

  // ─── Token cost estimates per 1M tokens (input/output) — FALLBACK only ───
  // These are used when the proxy's /model/info endpoint is unreachable.
  // Live values are fetched dynamically at startup and cached in modelInfoCache.
  const MODEL_COSTS_FALLBACK = {
    'claude': { input: 15, output: 75 },     // Opus-class
    'opus': { input: 15, output: 75 },
    'sonnet': { input: 3, output: 15 },
    'haiku': { input: 0.25, output: 1.25 },
    'gpt': { input: 5, output: 15 },
    'gemini': { input: 1.25, output: 5 },
    'default': { input: 3, output: 15 },
  };

  // ─── Context window sizes (tokens) — FALLBACK only ────────────────
  const MODEL_CONTEXT_WINDOWS_FALLBACK = {
    'opus-1m': 1000000, 'sonnet-1m': 1000000,
    'opus': 200000, 'sonnet': 200000, 'haiku': 200000,
    'claude': 200000, 'gpt-4o': 128000, 'gpt-4-turbo': 128000,
    'gpt-4': 8192, 'gpt-3.5': 16385, 'o1': 200000, 'o3': 200000,
    'gemini-2': 1048576, 'gemini-1.5': 1048576, 'gemini': 1048576,
    'gpt': 128000, 'default': 128000,
  };

  // ─── Dynamic model info cache (populated from /model/info) ─────
  // Maps model ID → { max_tokens, max_input_tokens, input_cost_per_token, output_cost_per_token }
  let modelInfoCache = {};
  const CONTEXT_WARN = 0.80;
  const CONTEXT_BLOCK = 0.95;

  function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function getContextWindowSize(modelId) {
    if (!modelId) return MODEL_CONTEXT_WINDOWS_FALLBACK['default'];

    // Try live data first
    const info = modelInfoCache[modelId];
    if (info) {
      const ctx = info.max_input_tokens || info.max_tokens;
      if (ctx) return ctx;
    }

    // Fallback to hardcoded
    const lower = modelId.toLowerCase();
    const keys = Object.keys(MODEL_CONTEXT_WINDOWS_FALLBACK).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (key !== 'default' && lower.includes(key)) {
        return MODEL_CONTEXT_WINDOWS_FALLBACK[key];
      }
    }
    return MODEL_CONTEXT_WINDOWS_FALLBACK['default'];
  }

  function calculateContextUsage() {
    const conv = state.conversations[state.activeConversationId];
    const modelId = modelSelector ? modelSelector.value : state.selectedModel;
    const windowSize = getContextWindowSize(modelId);

    // System prompt + knowledge tokens
    const { text: sysText, images: sysImages } = getActiveProjectSystemPrompt();
    const systemTokens = estimateTokens(sysText) + (sysImages.length * 1000);

    // Knowledge tokens (subset of system)
    let knowledgeTokens = 0;
    if (state.activeProjectId && state.projects[state.activeProjectId]) {
      const proj = state.projects[state.activeProjectId];
      if (proj.knowledgeFiles && proj.knowledgeFiles.length > 0) {
        proj.knowledgeFiles.forEach(f => {
          if (f.sourceType === 'image') {
            knowledgeTokens += 1000; // ~1K tokens per image estimate
          } else {
            knowledgeTokens += estimateTokens(f.content);
            knowledgeTokens += estimateTokens('--- ' + f.name + ' ---\n');
          }
        });
        knowledgeTokens += estimateTokens('\n\n--- Knowledge Files ---\n');
      }
    }

    // Conversation tokens
    let conversationTokens = 0;
    if (conv && conv.messages) {
      conv.messages.forEach(m => {
        const text = (typeof m.content === 'object' && m.content !== null)
          ? (m.content.text || '') : (m.content || '');
        conversationTokens += estimateTokens(text);
      });
    }

    // Pending input tokens (what user is currently typing)
    const pendingText = chatInput ? chatInput.value : '';
    const pendingTokens = estimateTokens(pendingText);

    const totalTokens = systemTokens + conversationTokens + pendingTokens;
    const ratio = windowSize > 0 ? totalTokens / windowSize : 0;

    return {
      systemTokens,
      knowledgeTokens,
      conversationTokens,
      pendingTokens,
      totalTokens,
      windowSize,
      ratio,
    };
  }

  // ─── State ────────────────────────────────────────
  let state = {
    conversations: {},
    activeConversationId: null,
    models: [],
    selectedModel: '',
    isStreaming: false,
    abortController: null,
    logPanelOpen: false,
    logPollTimer: null,
    logErrorCount: 0,
    // Phase 1: Projects
    projects: {},
    activeProjectId: null,
    // Phase 2: Token stats
    conversationTokens: 0,
    conversationCost: 0,
  };

  // ─── DOM refs ─────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebarOverlay');
  const sidebarToggle = $('#sidebarToggle');
  const newChatBtn = $('#newChatBtn');
  const conversationList = $('#conversationList');
  const chatContainer = $('#chatContainer');
  const chatMessages = $('#chatMessages');
  const chatInput = $('#chatInput');
  const sendBtn = $('#sendBtn');
  const stopBtn = $('#stopBtn');
  const modelSelector = $('#modelSelector');
  const themeToggle = $('#themeToggle');
  const proxyInput = $('#proxyUrl');
  const renameDialog = $('#renameDialog');
  const renameInput = $('#renameInput');
  const renameCancelBtn = $('#renameCancelBtn');
  const renameConfirmBtn = $('#renameConfirmBtn');
  const deleteDialog = $('#deleteDialog');
  const deleteCancelBtn = $('#deleteCancelBtn');
  const deleteConfirmBtn = $('#deleteConfirmBtn');

  // Log panel refs
  const logToggleBtn = $('#logToggleBtn');
  const logErrorBadge = $('#logErrorBadge');
  const logPanel = $('#logPanel');
  const logPopoutBtn = $('#logPopoutBtn');
  const logSourceSelector = $('#logSourceSelector');
  const logLevelFilter = $('#logLevelFilter');
  const logSearch = $('#logSearch');
  const logAutoScroll = $('#logAutoScroll');
  const logRefreshBtn = $('#logRefreshBtn');
  const logClearBtn = $('#logClearBtn');
  const logCloseBtn = $('#logCloseBtn');
  const logPanelBody = $('#logPanelBody');
  const logFileInfo = $('#logFileInfo');
  const logResizeHandle = $('#logResizeHandle');

  // Proxy health refs
  const proxyStatusDot = $('#proxyStatusDot');

  // Phase 1: Project refs
  const projectSelect = $('#projectSelect');
  const projectSettingsBtn = $('#projectSettingsBtn');
  const projectAddBtn = $('#projectAddBtn');
  const projectDialog = $('#projectDialog');
  const projectDialogTitle = $('#projectDialogTitle');
  const projectNameInput = $('#projectNameInput');
  const projectDescInput = $('#projectDescInput');
  const projectSystemPrompt = $('#projectSystemPrompt');
  const knowledgeFilesArea = $('#knowledgeFilesArea');
  const knowledgeAddBtn = $('#knowledgeAddBtn');
  const projectSaveBtn = $('#projectSaveBtn');
  const projectCancelBtn = $('#projectCancelBtn');
  const projectDeleteBtn = $('#projectDeleteBtn');

  // Phase 2: Search + Export refs
  const sidebarSearchInput = $('#sidebarSearch');
  const exportBtn = $('#exportBtn');
  const inputHint = $('#inputHint');

  // Context bar refs
  const contextBarWrapper = $('#contextBarWrapper');
  const contextBarFill = $('#contextBarFill');
  const contextBarLabel = $('#contextBarLabel');

  let pendingRenameId = null;
  let pendingDeleteId = null;
  let pendingImages = []; // Array of { dataUrl, mimeType } for images pasted before sending
  let editingProjectId = null; // Track which project we're editing in the dialog
  let projectKnowledgeFiles = []; // Temp storage for knowledge files in dialog

  // Image preview area ref
  const imagePreviewArea = $('#imagePreviewArea');

  // ─── Model helpers (fully dynamic) ─────────────────
  const DEAD_MODELS_KEY = 'claude-chat-dead-models';

  function getModelGroup(id) {
    if (/^(opus|claude.*opus)/i.test(id)) return 'Claude Opus';
    if (/^(sonnet|claude.*sonnet)/i.test(id)) return 'Claude Sonnet';
    if (/^(haiku|claude.*haiku)/i.test(id)) return 'Claude Haiku';
    if (/gpt.*codex/i.test(id)) return 'GPT Codex';
    if (/gpt/i.test(id)) return 'GPT';
    if (/gemini/i.test(id)) return 'Gemini';
    return 'Other';
  }

  function getModelLabel(id) {
    const cleanId = id.replace(/-\d{8}$/, '');
    if (cleanId === 'opus') return 'Opus 4.6 (default)';
    if (cleanId === 'opus-1m') return 'Opus 4.6 (1M context)';
    if (cleanId === 'sonnet') return 'Sonnet 4.6';
    if (cleanId === 'sonnet-1m') return 'Sonnet 4.6 (1M context)';
    if (cleanId === 'haiku') return 'Haiku 4.5';
    if (cleanId === 'claude-opus-4-6') return 'Opus 4.6 (default)';
    if (cleanId === 'claude-opus-4-6-1m') return 'Opus 4.6 (1M context)';
    if (cleanId === 'claude-opus-4-5') return 'Opus 4.5';
    if (cleanId === 'claude-sonnet-4-6') return 'Sonnet 4.6';
    if (cleanId === 'claude-sonnet-4-6-1m') return 'Sonnet 4.6 (1M context)';
    if (cleanId === 'claude-sonnet-4') return 'Sonnet 4';
    if (cleanId === 'claude-sonnet-4-5') return 'Sonnet 4.5';
    if (cleanId === 'claude-haiku-4') return 'Haiku 4.5';
    if (cleanId === 'claude-haiku-4-5') return 'Haiku 4.5';
    if (/^gpt/i.test(cleanId)) {
      return cleanId
        .replace(/^gpt/, 'GPT')
        .replace(/-codex/i, '-Codex')
        .replace(/-mini$/i, ' mini')
        .replace(/-max$/i, '-Max');
    }
    if (/^gemini/i.test(cleanId)) {
      let label = cleanId.split('-').map((w, i) => i === 0 ? 'Gemini' : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (/preview/i.test(cleanId)) {
        label = label.replace(/\s*Preview$/i, '').trim() + ' (Preview)';
      }
      return label;
    }
    let label = cleanId.replace(/^claude-/, '');
    label = label.replace(/-(\d+)-(\d+)/g, ' $1.$2');
    label = label.replace(/(^|[\s-])(\w)/g, (_, pre, c) => pre + c.toUpperCase());
    label = label.replace(/-/g, ' ');
    return label;
  }

  function getModelSortKey(id) {
    const cleanId = id.replace(/-\d{8}$/, '');
    if (/1m$/i.test(cleanId)) return '0_' + cleanId;
    return '1_' + cleanId;
  }

  const GROUP_ORDER = ['Claude Opus', 'Claude Sonnet', 'Claude Haiku', 'GPT Codex', 'GPT', 'Gemini', 'Other'];

  // ─── Fallback detection ──────────────────────────
  function normalizeModelId(id) {
    if (!id) return '';
    return id
      .toLowerCase()
      .replace(/^[a-z_]+\//i, '')
      .replace(/-\d{8}$/, '')
      .replace(/\./g, '-')
      .replace(/\s+/g, '-')
      .trim();
  }

  function detectFallback(requestedModel, actualBackendModel) {
    if (!actualBackendModel || !requestedModel) return { isFallback: false };
    const reqNorm = normalizeModelId(requestedModel);
    const actNorm = normalizeModelId(actualBackendModel);
    if (reqNorm === actNorm) return { isFallback: false };
    return {
      isFallback: true,
      requestedLabel: getModelLabel(requestedModel),
      actualLabel: prettifyBackendModel(actualBackendModel),
    };
  }

  function getModelFamily(id) {
    const lower = id.toLowerCase();
    if (/claude|opus|sonnet|haiku/.test(lower)) return 'claude';
    if (/gpt/.test(lower)) return 'gpt';
    if (/gemini/.test(lower)) return 'gemini';
    return null;
  }

  function prettifyBackendModel(backendModel) {
    return backendModel.replace(/^[a-z_]+\//i, '');
  }

  function getDeadModels() {
    try {
      const raw = localStorage.getItem(DEAD_MODELS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        const now = Date.now();
        const valid = {};
        Object.entries(data).forEach(([id, ts]) => {
          if (now - ts < 3600_000) valid[id] = ts;
        });
        return valid;
      }
    } catch(e) {}
    return {};
  }

  function markModelDead(id) {
    const dead = getDeadModels();
    dead[id] = Date.now();
    localStorage.setItem(DEAD_MODELS_KEY, JSON.stringify(dead));
  }

  // ─── Token cost helper ─────────────────────────────
  function getModelCostRate(modelId) {
    // Try live data first (per-token → per-1M conversion)
    const info = modelInfoCache[modelId];
    if (info && (info.input_cost_per_token || info.output_cost_per_token)) {
      return {
        input: (info.input_cost_per_token || 0) * 1_000_000,
        output: (info.output_cost_per_token || 0) * 1_000_000,
      };
    }

    // Fallback to hardcoded
    const lower = (modelId || '').toLowerCase();
    if (/opus/.test(lower)) return MODEL_COSTS_FALLBACK['opus'];
    if (/sonnet/.test(lower)) return MODEL_COSTS_FALLBACK['sonnet'];
    if (/haiku/.test(lower)) return MODEL_COSTS_FALLBACK['haiku'];
    if (/gpt/.test(lower)) return MODEL_COSTS_FALLBACK['gpt'];
    if (/gemini/.test(lower)) return MODEL_COSTS_FALLBACK['gemini'];
    return MODEL_COSTS_FALLBACK['default'];
  }

  function estimateCost(usage, modelId) {
    if (!usage) return 0;
    const rate = getModelCostRate(modelId);
    const inputCost = (usage.prompt_tokens || 0) / 1_000_000 * rate.input;
    const outputCost = (usage.completion_tokens || 0) / 1_000_000 * rate.output;
    return inputCost + outputCost;
  }

  function formatCost(cost) {
    if (cost < 0.001) return '<$0.001';
    if (cost < 0.01) return `~$${cost.toFixed(4)}`;
    return `~$${cost.toFixed(3)}`;
  }

  // ─── Init ─────────────────────────────────────────
  function init() {
    loadState();
    loadTheme();
    loadProxy();
    localStorage.removeItem(DEAD_MODELS_KEY);
    loadModels();
    loadProjects();
    renderConversationList();
    if (state.activeConversationId && state.conversations[state.activeConversationId]) {
      renderChat();
    }
    bindEvents();
    autoResize();
    checkProxyHealth(true);
    initLogResize();

    const hasLocal = Object.keys(state.conversations).length > 0;
    if (!hasLocal) {
      restoreFromServer();
    } else {
      backgroundSync();
    }

    // Update token display for active conversation
    updateConversationTokenDisplay();
    updateContextBar();
  }

  // ─── Persistence ──────────────────────────────────
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        state.conversations = data.conversations || {};
        state.activeConversationId = data.activeConversationId || null;
      }
    } catch (e) {
      console.warn('Failed to load state', e);
    }
    const savedModel = localStorage.getItem(MODEL_KEY);
    if (savedModel) state.selectedModel = savedModel;
    const savedProject = localStorage.getItem(PROJECT_KEY);
    if (savedProject) state.activeProjectId = savedProject;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
      }));
    } catch (e) {
      console.warn('Failed to save state', e);
    }
  }

  // ─── Server-side persistence (sync layer) ───────
  const SYNC_KEY = 'claude-chat-synced';

  function syncConversationToServer(conv) {
    const serverUrl = getServerUrl();
    fetch(`${serverUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(conv),
    }).catch(() => {});
  }

  function deleteConversationOnServer(convId) {
    const serverUrl = getServerUrl();
    fetch(`${serverUrl}/api/conversations/${convId}`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  function exportAllToServer() {
    const serverUrl = getServerUrl();
    fetch(`${serverUrl}/api/conversations/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: state.conversations }),
    }).then(r => r.json()).then(data => {
      if (data.ok) {
        localStorage.setItem(SYNC_KEY, 'true');
        console.log(`Synced ${data.imported} conversations to server`);
      }
    }).catch(() => {});
  }

  async function restoreFromServer() {
    try {
      const serverUrl = getServerUrl();
      const res = await fetch(`${serverUrl}/api/conversations`);
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.ok || !data.conversations || data.conversations.length === 0) return false;

      let restored = 0;
      for (const summary of data.conversations) {
        try {
          const cRes = await fetch(`${serverUrl}/api/conversations/${summary.id}`);
          const cData = await cRes.json();
          if (cData.ok && cData.conversation) {
            state.conversations[summary.id] = cData.conversation;
            restored++;
          }
        } catch (e) {}
      }

      if (restored > 0) {
        const sorted = Object.values(state.conversations)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        state.activeConversationId = sorted[0]?.id || null;
        saveState();
        renderConversationList();
        renderChat();
        showToast(`Restored ${restored} conversation${restored > 1 ? 's' : ''} from server`, 'success');
        return true;
      }
    } catch (e) {}
    return false;
  }

  function backgroundSync() {
    const alreadySynced = localStorage.getItem(SYNC_KEY);
    const hasConversations = Object.keys(state.conversations).length > 0;
    if (hasConversations && !alreadySynced) {
      exportAllToServer();
    }
    mergeFromServer();
  }

  async function mergeFromServer() {
    try {
      const serverUrl = getServerUrl();
      const res = await fetch(`${serverUrl}/api/conversations`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !data.conversations) return;

      let merged = 0;
      for (const summary of data.conversations) {
        if (state.conversations[summary.id]) continue;
        try {
          const cRes = await fetch(`${serverUrl}/api/conversations/${summary.id}`);
          const cData = await cRes.json();
          if (cData.ok && cData.conversation) {
            state.conversations[summary.id] = cData.conversation;
            merged++;
          }
        } catch (e) {}
      }

      if (merged > 0) {
        saveState();
        renderConversationList();
        showToast(`Merged ${merged} conversation${merged > 1 ? 's' : ''} from server`, 'success');
      }
    } catch (e) {}
  }

  // ─── Theme ────────────────────────────────────────
  function loadTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
  }

  // ─── Proxy ────────────────────────────────────────
  function loadProxy() {
    const saved = localStorage.getItem(PROXY_KEY);
    if (saved) proxyInput.value = saved;
  }

  function getProxyUrl() {
    return (proxyInput.value || 'http://localhost:5000').replace(/\/+$/, '');
  }

  async function checkProxyHealth(silent) {
    const url = getProxyUrl();
    if (!url) return;
    if (proxyStatusDot) {
      proxyStatusDot.className = 'proxy-status-dot checking';
      proxyStatusDot.title = 'Checking...';
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        if (proxyStatusDot) {
          proxyStatusDot.className = 'proxy-status-dot ok';
          proxyStatusDot.title = `Proxy is working (${url})`;
        }
        if (!silent) showProxyHealthToast(true, url);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      try {
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 5000);
        const res2 = await fetch(`${url}/v1/models`, { signal: controller2.signal });
        clearTimeout(timeout2);
        if (res2.ok) {
          if (proxyStatusDot) {
            proxyStatusDot.className = 'proxy-status-dot ok';
            proxyStatusDot.title = `Proxy is working (${url})`;
          }
          if (!silent) showProxyHealthToast(true, url);
          return;
        }
      } catch (e2) {}
      if (proxyStatusDot) {
        proxyStatusDot.className = 'proxy-status-dot fail';
        proxyStatusDot.title = `Proxy not reachable (${url})`;
      }
      if (!silent) showProxyHealthToast(false, url);
    }
  }

  function showProxyHealthToast(ok, url) {
    document.querySelectorAll('.proxy-health-toast').forEach(el => el.remove());
    const toast = document.createElement('div');
    toast.className = `proxy-health-toast ${ok ? 'ok' : 'fail'}`;
    toast.textContent = ok ? `Proxy is working` : `Proxy not reachable`;
    const proxyConfig = document.querySelector('.proxy-config');
    if (proxyConfig) {
      proxyConfig.parentElement.insertBefore(toast, proxyConfig);
    } else {
      document.body.appendChild(toast);
    }
    setTimeout(() => toast.remove(), 3000);
  }

  function getServerUrl() {
    return window.location.origin;
  }

  // ─── Models ───────────────────────────────────────
  async function loadModels() {
    modelSelector.innerHTML = '<option value="">Loading models...</option>';
    try {
      const res = await fetch(`${getProxyUrl()}/v1/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const allModels = (data.data || []).map(m => m.id);
      const deadModels = getDeadModels();
      state.models = allModels
        .filter(id => !id.endsWith('*'))
        .filter(id => !/-fast$/i.test(id))
        .filter(id => !deadModels[id])
        .sort();

      // Fetch live model info (context windows, pricing) from proxy
      fetchModelInfo();

      const virtualModels = [
        'claude-opus-4-6-1m',
        'claude-sonnet-4-6-1m',
        'claude-sonnet-4-5',
      ];
      const modelsSetPre = new Set(state.models);
      virtualModels.forEach(vm => {
        if (!modelsSetPre.has(vm) && !deadModels[vm]) state.models.push(vm);
      });
      state.models.sort();

      modelSelector.innerHTML = '';
      if (state.models.length === 0) {
        modelSelector.innerHTML = '<option value="">No models found</option>';
        return;
      }

      const aliasToLong = {
        'opus': 'claude-opus-4-6',
        'opus-1m': 'claude-opus-4-6-1m',
        'sonnet': 'claude-sonnet-4-6',
        'sonnet-1m': 'claude-sonnet-4-6-1m',
        'haiku': 'claude-haiku-4',
      };
      const modelsSet = new Set(state.models);
      const hiddenAliases = new Set();
      Object.entries(aliasToLong).forEach(([alias, long]) => {
        if (modelsSet.has(alias) && modelsSet.has(long)) hiddenAliases.add(alias);
      });

      state.models.forEach(id => {
        const dateStripped = id.replace(/-\d{8}$/, '');
        if (dateStripped !== id && modelsSet.has(dateStripped)) {
          hiddenAliases.add(id);
        }
      });

      const sameBackend = { 'claude-haiku-4-5': 'claude-haiku-4' };
      Object.entries(sameBackend).forEach(([dup, keep]) => {
        if (modelsSet.has(dup) && modelsSet.has(keep)) hiddenAliases.add(dup);
      });

      const groups = {};
      state.models.forEach(id => {
        if (hiddenAliases.has(id)) return;
        const group = getModelGroup(id);
        if (!groups[group]) groups[group] = [];
        groups[group].push(id);
      });

      Object.keys(groups).forEach(g => {
        groups[g].sort((a, b) => {
          const ka = getModelSortKey(a);
          const kb = getModelSortKey(b);
          if (ka[0] !== kb[0]) return ka.localeCompare(kb);
          return kb.localeCompare(ka);
        });
      });

      GROUP_ORDER.forEach(groupName => {
        if (!groups[groupName] || groups[groupName].length === 0) return;
        const optgroup = document.createElement('optgroup');
        optgroup.label = groupName;
        groups[groupName].forEach(id => {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = getModelLabel(id);
          optgroup.appendChild(opt);
        });
        modelSelector.appendChild(optgroup);
        delete groups[groupName];
      });

      Object.entries(groups).forEach(([groupName, ids]) => {
        if (ids.length === 0) return;
        const optgroup = document.createElement('optgroup');
        optgroup.label = groupName;
        ids.forEach(id => {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = getModelLabel(id);
          optgroup.appendChild(opt);
        });
        modelSelector.appendChild(optgroup);
      });

      if (state.selectedModel && state.models.includes(state.selectedModel)) {
        modelSelector.value = state.selectedModel;
      } else {
        const defaultPref = ['claude-opus-4-6', 'opus'];
        state.selectedModel = defaultPref.find(m => state.models.includes(m)) || state.models[0];
        modelSelector.value = state.selectedModel;
      }
    } catch (e) {
      console.warn('Failed to load models', e);
      modelSelector.innerHTML = '<option value="">Cannot reach proxy</option>';
    }
  }

  // ─── Fetch live model info (context windows, pricing) ────
  async function fetchModelInfo() {
    try {
      const res = await fetch(`${getProxyUrl()}/model/info`);
      if (!res.ok) return;
      const data = await res.json();
      // data.data is an array of { model_name, model_info: { ... } }
      const models = data.data || data.model_info || [];
      if (Array.isArray(models)) {
        models.forEach(entry => {
          const id = entry.model_name || entry.id;
          const info = entry.model_info || entry;
          if (id && info) {
            modelInfoCache[id] = {
              max_tokens: info.max_tokens || null,
              max_input_tokens: info.max_input_tokens || null,
              max_output_tokens: info.max_output_tokens || null,
              input_cost_per_token: info.input_cost_per_token || null,
              output_cost_per_token: info.output_cost_per_token || null,
            };
          }
        });
      }
      console.log(`Loaded live model info for ${Object.keys(modelInfoCache).length} models`);
      // Refresh context bar now that we have real data
      updateContextBar();
    } catch (e) {
      console.warn('Could not fetch /model/info — using fallback values', e);
    }
  }

  // ═══════════════════════════════════════════════════
  // PHASE 1: Projects + System Prompts
  // ═══════════════════════════════════════════════════

  async function loadProjects() {
    try {
      const serverUrl = getServerUrl();
      const res = await fetch(`${serverUrl}/api/projects`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;

      state.projects = {};
      for (const summary of data.projects) {
        try {
          const pRes = await fetch(`${serverUrl}/api/projects/${summary.id}`);
          const pData = await pRes.json();
          if (pData.ok && pData.project) {
            state.projects[summary.id] = pData.project;
          }
        } catch (e) {}
      }
      renderProjectSelect();
    } catch (e) {
      console.warn('Failed to load projects', e);
    }
  }

  function renderProjectSelect() {
    if (!projectSelect) return;
    const currentVal = state.activeProjectId || '';
    projectSelect.innerHTML = '<option value="">All Chats</option>';
    const sorted = Object.values(state.projects)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    sorted.forEach(proj => {
      const opt = document.createElement('option');
      opt.value = proj.id;
      opt.textContent = proj.name || 'Untitled Project';
      projectSelect.appendChild(opt);
    });
    projectSelect.value = currentVal;
  }

  function switchProject(projectId) {
    state.activeProjectId = projectId || null;
    localStorage.setItem(PROJECT_KEY, state.activeProjectId || '');
    renderConversationList();
    // If current conversation doesn't belong to this project, deselect
    if (state.activeProjectId && state.activeConversationId) {
      const conv = state.conversations[state.activeConversationId];
      if (conv && conv.projectId !== state.activeProjectId) {
        // Switch to first conversation in this project, or deselect
        const projectConvs = Object.values(state.conversations)
          .filter(c => c.projectId === state.activeProjectId)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        if (projectConvs.length > 0) {
          switchConversation(projectConvs[0].id);
        } else {
          state.activeConversationId = null;
          saveState();
          renderChat();
        }
      }
    }
    updateContextBar();
  }

  function showProjectDialog(projectId) {
    if (projectId && state.projects[projectId]) {
      // Edit existing project
      editingProjectId = projectId;
      const proj = state.projects[projectId];
      projectDialogTitle.textContent = 'Edit Project';
      projectNameInput.value = proj.name || '';
      projectDescInput.value = proj.description || '';
      projectSystemPrompt.value = proj.systemPrompt || '';
      projectKnowledgeFiles = [...(proj.knowledgeFiles || [])];
      projectDeleteBtn.style.display = '';
    } else {
      // New project
      editingProjectId = null;
      projectDialogTitle.textContent = 'New Project';
      projectNameInput.value = '';
      projectDescInput.value = '';
      projectSystemPrompt.value = '';
      projectKnowledgeFiles = [];
      projectDeleteBtn.style.display = 'none';
    }
    renderKnowledgeFiles();
    projectDialog.classList.remove('hidden');
    projectNameInput.focus();
  }

  function hideProjectDialog() {
    projectDialog.classList.add('hidden');
    editingProjectId = null;
    projectKnowledgeFiles = [];
  }

  function renderKnowledgeFiles() {
    if (!knowledgeFilesArea) return;
    knowledgeFilesArea.innerHTML = '';
    if (projectKnowledgeFiles.length === 0) {
      knowledgeFilesArea.innerHTML = '<div class="knowledge-empty">No knowledge files added yet.</div>';
      return;
    }

    let totalTokens = 0;
    projectKnowledgeFiles.forEach((file, i) => {
      const div = document.createElement('div');
      div.className = 'knowledge-file-item';

      const isImage = file.sourceType === 'image';
      const isPdf = file.sourceType === 'pdf';
      const isDocx = file.sourceType === 'docx';

      if (isImage) {
        // Image knowledge file — show thumbnail + IMG badge
        div.innerHTML = `
          <div class="knowledge-file-info">
            <div style="display:flex;align-items:center;gap:6px">
              <img src="${escapeHtml(file.content)}" class="knowledge-image-thumb" alt="${escapeHtml(file.name)}">
              <span class="knowledge-file-name">${escapeHtml(file.name)}</span>
              <span class="knowledge-file-badge knowledge-badge-img">IMG</span>
            </div>
          </div>
          <button class="knowledge-file-remove" title="Remove" data-index="${i}">&times;</button>
        `;
      } else {
        const size = file.content ? `${(file.content.length / 1024).toFixed(1)}KB` : '0KB';
        const tokens = estimateTokens(file.content);
        totalTokens += tokens;
        let badgeHtml = '';
        if (isPdf) badgeHtml = '<span class="knowledge-file-badge knowledge-badge-pdf">PDF</span>';
        else if (isDocx) badgeHtml = '<span class="knowledge-file-badge knowledge-badge-docx">DOCX</span>';
        div.innerHTML = `
          <div class="knowledge-file-info">
            <div style="display:flex;align-items:center;gap:6px">
              <span class="knowledge-file-name">${escapeHtml(file.name)}</span>
              ${badgeHtml}
            </div>
            <span class="knowledge-file-size">${size} &middot; <span class="knowledge-file-tokens">${formatTokenCount(tokens)} tokens</span></span>
          </div>
          <button class="knowledge-file-remove" title="Remove" data-index="${i}">&times;</button>
        `;
      }
      div.querySelector('.knowledge-file-remove').addEventListener('click', () => {
        projectKnowledgeFiles.splice(i, 1);
        renderKnowledgeFiles();
      });
      knowledgeFilesArea.appendChild(div);
    });

    // Context summary row
    const modelId = modelSelector ? modelSelector.value : state.selectedModel;
    const windowSize = getContextWindowSize(modelId);
    const pct = windowSize > 0 ? ((totalTokens / windowSize) * 100).toFixed(1) : 0;
    const isHeavy = (totalTokens / windowSize) > 0.50;
    const summary = document.createElement('div');
    summary.className = 'knowledge-context-summary' + (isHeavy ? ' context-heavy' : '');
    summary.innerHTML = `<span>Total: ${formatTokenCount(totalTokens)} tokens from ${projectKnowledgeFiles.length} file(s)</span><span>${pct}% of ${formatTokenCount(windowSize)} context</span>`;
    knowledgeFilesArea.appendChild(summary);
  }

  // ─── PDF extraction ──────────────────────────────
  async function extractPdfText(file, onProgress) {
    if (!window.pdfjsLib) {
      throw new Error('PDF.js not loaded. PDF support requires an internet connection.');
    }
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    let fullText = '';

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += `[Page ${i}]\n${pageText}\n\n`;
      if (onProgress) onProgress(i, totalPages);
    }

    return fullText.trim();
  }

  function showKnowledgeProgress(fileName) {
    if (!knowledgeFilesArea) return;
    const div = document.createElement('div');
    div.className = 'knowledge-file-loading';
    div.id = 'knowledgeProgress';
    div.innerHTML = `
      <div style="flex:1;min-width:0">
        <span class="knowledge-file-name">Extracting: ${escapeHtml(fileName)}</span>
        <div class="knowledge-progress-bar">
          <div class="knowledge-progress-fill" id="knowledgeProgressFill"></div>
        </div>
      </div>
    `;
    knowledgeFilesArea.appendChild(div);
  }

  function updateKnowledgeProgress(current, total) {
    const fill = document.getElementById('knowledgeProgressFill');
    if (fill) {
      fill.style.width = ((current / total) * 100).toFixed(1) + '%';
    }
  }

  function removeKnowledgeProgress() {
    const el = document.getElementById('knowledgeProgress');
    if (el) el.remove();
  }

  function addKnowledgeFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.json,.csv,.xml,.html,.py,.js,.ts,.java,.c,.cpp,.h,.css,.yaml,.yml,.toml,.ini,.cfg,.log,.pdf,.docx,.png,.jpg,.jpeg,.gif,.webp';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;

      const isPdf = file.name.toLowerCase().endsWith('.pdf');
      const isDocx = file.name.toLowerCase().endsWith('.docx');
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
      const isImage = imageExtensions.some(ext => file.name.toLowerCase().endsWith(ext));

      if (isImage) {
        // Image knowledge file — store as data URL
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target.result;
          projectKnowledgeFiles.push({
            name: file.name,
            content: dataUrl,
            sourceType: 'image',
            mimeType: file.type || 'image/png',
          });
          renderKnowledgeFiles();
          showToast(`Image "${file.name}" added as knowledge file.`, 'success');
        };
        reader.readAsDataURL(file);
      } else if (isDocx) {
        // DOCX extraction with mammoth.js
        if (!window.mammoth) {
          showToast('DOCX support requires an internet connection to load mammoth.js.');
          return;
        }
        showKnowledgeProgress(file.name);
        try {
          const arrayBuffer = await file.arrayBuffer();
          const result = await mammoth.extractRawText({ arrayBuffer });
          removeKnowledgeProgress();

          if (!result.value || result.value.trim().length === 0) {
            showToast('This DOCX file has no extractable text.');
            return;
          }

          projectKnowledgeFiles.push({
            name: file.name,
            content: result.value,
            sourceType: 'docx',
          });
          renderKnowledgeFiles();
          showToast(`DOCX "${file.name}" extracted successfully.`, 'success');
        } catch (err) {
          removeKnowledgeProgress();
          showToast(`Failed to extract DOCX: ${err.message}`);
        }
      } else if (isPdf) {
        // PDF extraction with progress
        if (!window.pdfjsLib) {
          showToast('PDF support requires an internet connection to load pdf.js.');
          return;
        }
        showKnowledgeProgress(file.name);
        try {
          const text = await extractPdfText(file, (current, total) => {
            updateKnowledgeProgress(current, total);
          });
          removeKnowledgeProgress();

          if (!text || text.replace(/\[Page \d+\]\s*/g, '').trim().length === 0) {
            showToast('This PDF has no extractable text (may be a scanned/image-only document).');
            return;
          }

          projectKnowledgeFiles.push({
            name: file.name,
            content: text,
            sourceType: 'pdf',
          });
          renderKnowledgeFiles();
          showToast(`PDF "${file.name}" extracted successfully.`, 'success');
        } catch (err) {
          removeKnowledgeProgress();
          showToast(`Failed to extract PDF: ${err.message}`);
        }
      } else {
        // Plain text files
        const reader = new FileReader();
        reader.onload = (ev) => {
          projectKnowledgeFiles.push({
            name: file.name,
            content: ev.target.result,
          });
          renderKnowledgeFiles();
        };
        reader.readAsText(file);
      }
    });
    input.click();
  }

  async function saveProject() {
    const name = projectNameInput.value.trim();
    if (!name) {
      showToast('Project name is required.');
      return;
    }

    const projId = editingProjectId || ('proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const projData = {
      id: projId,
      name,
      description: projectDescInput.value.trim(),
      systemPrompt: projectSystemPrompt.value.trim(),
      knowledgeFiles: projectKnowledgeFiles,
      createdAt: (state.projects[projId]?.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };

    try {
      const serverUrl = getServerUrl();
      const res = await fetch(`${serverUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projData),
      });
      const data = await res.json();
      if (data.ok) {
        state.projects[projId] = projData;
        renderProjectSelect();
        if (!editingProjectId) {
          // Auto-switch to the new project
          state.activeProjectId = projId;
          localStorage.setItem(PROJECT_KEY, projId);
          projectSelect.value = projId;
          renderConversationList();
        }
        hideProjectDialog();
        showToast(`Project "${name}" saved.`, 'success');
      } else {
        showToast('Failed to save project.');
      }
    } catch (e) {
      showToast('Failed to save project.');
    }
  }

  async function deleteProject() {
    if (!editingProjectId) return;
    if (!confirm('Delete this project? Conversations will be kept but unlinked.')) return;

    try {
      const serverUrl = getServerUrl();
      await fetch(`${serverUrl}/api/projects/${editingProjectId}`, { method: 'DELETE' });
      // Unlink conversations
      Object.values(state.conversations).forEach(conv => {
        if (conv.projectId === editingProjectId) {
          delete conv.projectId;
          syncConversationToServer(conv);
        }
      });
      delete state.projects[editingProjectId];
      if (state.activeProjectId === editingProjectId) {
        state.activeProjectId = null;
        localStorage.setItem(PROJECT_KEY, '');
      }
      saveState();
      renderProjectSelect();
      renderConversationList();
      hideProjectDialog();
      showToast('Project deleted.', 'success');
    } catch (e) {
      showToast('Failed to delete project.');
    }
  }

  function getActiveProjectSystemPrompt() {
    if (!state.activeProjectId) return { text: null, images: [] };
    const proj = state.projects[state.activeProjectId];
    if (!proj) return { text: null, images: [] };

    let prompt = '';
    if (proj.systemPrompt) {
      prompt = proj.systemPrompt;
    }

    const images = [];

    // Append knowledge file contents (split text vs image)
    if (proj.knowledgeFiles && proj.knowledgeFiles.length > 0) {
      const textFiles = proj.knowledgeFiles.filter(f => f.sourceType !== 'image');
      const imageFiles = proj.knowledgeFiles.filter(f => f.sourceType === 'image');

      if (textFiles.length > 0) {
        const knowledgeContext = textFiles
          .map(f => `--- ${f.name} ---\n${f.content}`)
          .join('\n\n');
        if (prompt) {
          prompt += '\n\n--- Knowledge Files ---\n' + knowledgeContext;
        } else {
          prompt = knowledgeContext;
        }
      }

      // Image knowledge files — add text markers + image parts
      imageFiles.forEach(f => {
        prompt += (prompt ? '\n\n' : '') + `[Knowledge Image: ${f.name}]`;
        images.push({ type: 'image_url', image_url: { url: f.content } });
      });
    }
    return { text: prompt || null, images };
  }

  // ─── Conversations ────────────────────────────────
  function createConversation() {
    const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const conv = {
      id,
      title: 'New chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Associate with active project
    if (state.activeProjectId) {
      conv.projectId = state.activeProjectId;
    }
    state.conversations[id] = conv;
    state.activeConversationId = id;
    saveState();
    syncConversationToServer(conv);
    renderConversationList();
    renderChat();
    chatInput.focus();
    updateConversationTokenDisplay();
    return id;
  }

  function switchConversation(id) {
    if (!state.conversations[id]) return;
    state.activeConversationId = id;
    saveState();
    renderConversationList();
    renderChat();
    closeSidebar();
    updateConversationTokenDisplay();
  }

  function deleteConversation(id) {
    delete state.conversations[id];
    if (state.activeConversationId === id) {
      const ids = Object.keys(state.conversations);
      state.activeConversationId = ids.length > 0 ? ids[ids.length - 1] : null;
    }
    saveState();
    deleteConversationOnServer(id);
    renderConversationList();
    renderChat();
    updateConversationTokenDisplay();
  }

  function renameConversation(id, newTitle) {
    if (state.conversations[id]) {
      state.conversations[id].title = newTitle.trim() || 'Untitled';
      saveState();
      syncConversationToServer(state.conversations[id]);
      renderConversationList();
    }
  }

  function autoTitle(convId, userMessage) {
    const conv = state.conversations[convId];
    if (!conv || conv.title !== 'New chat') return;
    let title = userMessage.trim().replace(/\n/g, ' ');
    if (title.length > 45) title = title.slice(0, 42) + '...';
    conv.title = title || 'New chat';
    saveState();
    syncConversationToServer(conv);
    renderConversationList();
  }

  // ─── Render conversation list ─────────────────────
  function renderConversationList() {
    conversationList.innerHTML = '';
    let sorted = Object.values(state.conversations)
      .sort((a, b) => {
        // Starred conversations first, then by recency within each group
        const aStarred = a.starred ? 1 : 0;
        const bStarred = b.starred ? 1 : 0;
        if (bStarred !== aStarred) return bStarred - aStarred;
        return b.updatedAt - a.updatedAt;
      });

    // Filter by active project
    if (state.activeProjectId) {
      sorted = sorted.filter(conv => conv.projectId === state.activeProjectId);
    }

    // Filter by search query
    const searchQuery = sidebarSearchInput ? sidebarSearchInput.value.trim().toLowerCase() : '';
    if (searchQuery) {
      sorted = sorted.filter(conv => {
        if (conv.title.toLowerCase().includes(searchQuery)) return true;
        // Search in message contents
        return conv.messages.some(m => {
          const text = typeof m.content === 'object' ? (m.content?.text || '') : (m.content || '');
          return text.toLowerCase().includes(searchQuery);
        });
      });
    }

    if (sorted.length === 0 && (searchQuery || state.activeProjectId)) {
      conversationList.innerHTML = '<div class="sidebar-empty">No conversations found.</div>';
      return;
    }

    let lastWasStarred = false;
    sorted.forEach((conv, idx) => {
      // Insert divider between starred and unstarred groups
      if (lastWasStarred && !conv.starred) {
        const divider = document.createElement('div');
        divider.className = 'conversation-divider';
        conversationList.appendChild(divider);
      }
      lastWasStarred = !!conv.starred;

      const div = document.createElement('div');
      div.className = 'conversation-item' + (conv.id === state.activeConversationId ? ' active' : '');
      div.innerHTML = `
        <button class="conv-star-btn${conv.starred ? ' active' : ''}" title="${conv.starred ? 'Unstar' : 'Star'}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="${conv.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
        <span class="conversation-title">${escapeHtml(conv.title)}</span>
        <div class="conversation-actions">
          <button class="conv-action-btn rename-btn" title="Rename" data-id="${conv.id}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="conv-action-btn danger delete-btn" title="Delete" data-id="${conv.id}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      `;
      div.addEventListener('click', (e) => {
        if (e.target.closest('.conv-action-btn') || e.target.closest('.conv-star-btn')) return;
        switchConversation(conv.id);
      });
      // Star button handler
      div.querySelector('.conv-star-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        conv.starred = !conv.starred;
        saveState();
        syncConversationToServer(conv);
        renderConversationList();
      });
      div.querySelector('.rename-btn').addEventListener('click', () => showRenameDialog(conv.id));
      div.querySelector('.delete-btn').addEventListener('click', () => showDeleteDialog(conv.id));
      conversationList.appendChild(div);
    });
  }

  // ─── Image paste handling ──────────────────────────
  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        readImageFile(file);
      }
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        readImageFile(file);
      }
    }
  }

  function readImageFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const mimeType = file.type || 'image/png';
      pendingImages.push({ dataUrl, mimeType });
      renderImagePreviews();
      updateSendButton();
    };
    reader.readAsDataURL(file);
  }

  function removeImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreviews();
    updateSendButton();
  }

  function renderImagePreviews() {
    imagePreviewArea.innerHTML = '';
    if (pendingImages.length === 0) {
      imagePreviewArea.classList.add('hidden');
      return;
    }
    imagePreviewArea.classList.remove('hidden');
    pendingImages.forEach((img, i) => {
      const div = document.createElement('div');
      div.className = 'image-preview-item';
      div.innerHTML = `
        <img src="${img.dataUrl}" alt="Pasted image">
        <button class="image-preview-remove" title="Remove image" data-index="${i}">&times;</button>
      `;
      div.querySelector('.image-preview-remove').addEventListener('click', () => removeImage(i));
      imagePreviewArea.appendChild(div);
    });
  }

  function buildMessageContent(text, images) {
    if (!images || images.length === 0) return text;
    const parts = [];
    images.forEach(img => {
      parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    });
    if (text) parts.push({ type: 'text', text });
    return parts;
  }

  function buildStorageMessage(text, images) {
    return {
      text: text || '',
      images: images.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType })),
    };
  }

  // ─── Render chat ──────────────────────────────────
  function renderChat() {
    chatMessages.innerHTML = '';
    const conv = state.conversations[state.activeConversationId];

    if (!conv || conv.messages.length === 0) {
      chatMessages.appendChild(createWelcomeScreen());
      return;
    }

    conv.messages.forEach((msg, idx) => {
      chatMessages.appendChild(createMessageElement(msg.role, msg.content, idx, msg));
    });

    scrollToBottom();
    updateContextBar();
  }

  function createWelcomeScreen() {
    const div = document.createElement('div');
    div.className = 'welcome';
    div.id = 'welcomeScreen';
    div.innerHTML = `
      <div class="welcome-icon">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <h1 class="welcome-title">What can I help you with?</h1>
      <p class="welcome-subtitle">Chat with Claude, GPT, Gemini and more through your local proxy.</p>
      <div class="welcome-suggestions">
        <button class="suggestion-chip" data-prompt="Explain quantum computing in simple terms">Explain quantum computing</button>
        <button class="suggestion-chip" data-prompt="Write a Python function to find prime numbers">Write a prime number function</button>
        <button class="suggestion-chip" data-prompt="What are the best practices for REST API design?">REST API best practices</button>
        <button class="suggestion-chip" data-prompt="Help me debug my code">Help me debug code</button>
      </div>
    `;
    div.querySelectorAll('.suggestion-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        chatInput.value = btn.dataset.prompt;
        autoResize();
        sendMessage();
      });
    });
    return div;
  }

  function createMessageElement(role, content, messageIndex, msgData) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.dataset.messageIndex = messageIndex;
    const avatar = role === 'user' ? 'Y' : 'A';

    let textContent = '';
    let images = [];
    if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
      textContent = content.text || '';
      images = content.images || [];
    } else {
      textContent = content || '';
    }

    let imagesHtml = '';
    if (images.length > 0) {
      imagesHtml = '<div class="message-images">' +
        images.map(img => `<div class="message-image" onclick="window.__openLightbox(this)"><img src="${img.dataUrl}" alt="Image"></div>`).join('') +
        '</div>';
    }

    const renderedContent = role === 'user' ? escapeHtml(textContent) : renderMarkdown(textContent);

    // Token usage display for assistant messages — clickable pill
    let tokenHtml = '';
    if (role === 'assistant' && msgData && msgData.usage) {
      const u = msgData.usage;
      const prompt = u.prompt_tokens || 0;
      const completion = u.completion_tokens || 0;
      const cost = estimateCost(u, state.selectedModel);

      // Find previous assistant message's prompt_tokens to compute incremental context
      let prevPrompt = 0;
      const conv = state.conversations[state.activeConversationId];
      if (conv && conv.messages) {
        for (let i = messageIndex - 1; i >= 0; i--) {
          if (conv.messages[i].role === 'assistant' && conv.messages[i].usage) {
            prevPrompt = conv.messages[i].usage.prompt_tokens || 0;
            break;
          }
        }
      }
      const incrementalContext = prompt - prevPrompt;
      const turnTotal = incrementalContext + completion;

      tokenHtml = `
        <span class="token-pill" title="Click to see token breakdown">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          ${turnTotal.toLocaleString()} tokens &middot; ${formatCost(cost)}
        </span>
        <div class="token-pill-detail">
          <div class="token-pill-row"><span>New context</span><span>${incrementalContext.toLocaleString()}</span></div>
          <div class="token-pill-row"><span>Generated</span><span>${completion.toLocaleString()}</span></div>
          <div class="token-pill-row"><span>Turn total</span><span>${turnTotal.toLocaleString()}</span></div>
          <div class="token-pill-row"><span>Cumulative ctx</span><span>${prompt.toLocaleString()}</span></div>
          <div class="token-pill-row"><span>Cost</span><span>${formatCost(cost)}</span></div>
        </div>
      `;
    }

    // Branch navigation (Phase 3)
    let branchNav = '';
    if (msgData && msgData.branches && msgData.branches.length > 0) {
      const currentIdx = msgData.activeBranch !== undefined && msgData.activeBranch !== null ? msgData.activeBranch + 1 : 0;
      const total = msgData.branches.length + 1;
      branchNav = `
        <div class="branch-nav" data-msg-index="${messageIndex}">
          <button class="branch-arrow branch-prev" title="Previous version">&lsaquo;</button>
          <span class="branch-label">${currentIdx + 1} / ${total}</span>
          <button class="branch-arrow branch-next" title="Next version">&rsaquo;</button>
        </div>
      `;
    }

    // Action buttons for messages
    let actionsHtml = '';
    if (role === 'user') {
      actionsHtml = `
        <div class="message-actions">
          <button class="msg-action-btn edit-msg-btn" title="Edit message" data-msg-index="${messageIndex}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          ${branchNav}
        </div>
      `;
    } else if (role === 'assistant') {
      // Check if this is the last assistant message
      const conv = state.conversations[state.activeConversationId];
      const isLast = conv && messageIndex === conv.messages.length - 1;
      actionsHtml = `
        <div class="message-actions">
          ${isLast ? `<button class="msg-action-btn regen-btn" title="Regenerate response" data-msg-index="${messageIndex}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>` : ''}
          ${branchNav}
          ${tokenHtml}
        </div>
      `;
    }

    div.innerHTML = `
      <div class="message-wrapper">
        <div class="message-avatar">${avatar}</div>
        <div class="message-body">
          <div class="message-content">${imagesHtml}${renderedContent}</div>
          ${actionsHtml}
        </div>
      </div>
    `;

    // Bind action events
    const editBtn = div.querySelector('.edit-msg-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => editMessage(messageIndex));
    }

    const regenBtn = div.querySelector('.regen-btn');
    if (regenBtn) {
      regenBtn.addEventListener('click', () => regenerateResponse(messageIndex));
    }

    // Branch navigation
    const prevBtn = div.querySelector('.branch-prev');
    const nextBtn = div.querySelector('.branch-next');
    if (prevBtn) prevBtn.addEventListener('click', () => switchBranch(messageIndex, -1));
    if (nextBtn) nextBtn.addEventListener('click', () => switchBranch(messageIndex, 1));

    // Token pill toggle
    const pill = div.querySelector('.token-pill');
    const pillDetail = div.querySelector('.token-pill-detail');
    if (pill && pillDetail) {
      pill.addEventListener('click', () => {
        pillDetail.classList.toggle('open');
      });
    }

    return div;
  }

  // Lightbox for viewing images full-size
  window.__openLightbox = function(el) {
    const imgSrc = el.querySelector('img').src;
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${imgSrc}">`;
    lb.addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  };

  // ═══════════════════════════════════════════════════
  // PHASE 3: Conversation Branching + Message Editing
  // ═══════════════════════════════════════════════════

  function editMessage(messageIndex) {
    const conv = state.conversations[state.activeConversationId];
    if (!conv) return;
    const msg = conv.messages[messageIndex];
    if (!msg || msg.role !== 'user') return;

    const textContent = typeof msg.content === 'object' ? (msg.content.text || '') : (msg.content || '');

    // Find the message element and replace content with textarea
    const msgEl = chatMessages.querySelector(`[data-message-index="${messageIndex}"]`);
    if (!msgEl) return;
    const contentEl = msgEl.querySelector('.message-content');

    contentEl.innerHTML = `
      <div class="edit-mode">
        <textarea class="edit-textarea">${escapeHtml(textContent)}</textarea>
        <div class="edit-actions">
          <button class="edit-cancel-btn">Cancel</button>
          <button class="edit-confirm-btn">Send</button>
        </div>
      </div>
    `;

    const textarea = contentEl.querySelector('.edit-textarea');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    // Auto-resize
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';

    contentEl.querySelector('.edit-cancel-btn').addEventListener('click', () => {
      renderChat(); // Re-render to cancel
    });

    contentEl.querySelector('.edit-confirm-btn').addEventListener('click', () => {
      const newText = textarea.value.trim();
      if (!newText) return;
      confirmEdit(messageIndex, newText);
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newText = textarea.value.trim();
        if (newText) confirmEdit(messageIndex, newText);
      }
      if (e.key === 'Escape') renderChat();
    });
  }

  function confirmEdit(messageIndex, newContent) {
    const conv = state.conversations[state.activeConversationId];
    if (!conv) return;
    const msg = conv.messages[messageIndex];

    const oldContent = msg.content;
    const oldFollowUp = conv.messages.slice(messageIndex + 1);

    // Store original as a branch
    if (!msg.branches) msg.branches = [];
    msg.branches.push({
      content: oldContent,
      followUp: oldFollowUp,
    });
    msg.activeBranch = null; // null = current (edited) version

    // Update content
    msg.content = newContent;

    // Truncate messages after this point
    conv.messages = conv.messages.slice(0, messageIndex + 1);
    conv.updatedAt = Date.now();
    saveState();
    syncConversationToServer(conv);

    // Re-render and re-send
    renderChat();
    sendMessage(true); // true = re-send mode (don't add new user message)
  }

  function regenerateResponse(messageIndex) {
    const conv = state.conversations[state.activeConversationId];
    if (!conv || state.isStreaming) return;
    const msg = conv.messages[messageIndex];
    if (!msg || msg.role !== 'assistant') return;

    // Store current response as a branch
    if (!msg.branches) msg.branches = [];
    msg.branches.push({
      content: msg.content,
      usage: msg.usage || null,
    });
    msg.activeBranch = null;

    // Remove this and any following messages
    conv.messages = conv.messages.slice(0, messageIndex);
    conv.updatedAt = Date.now();
    saveState();
    syncConversationToServer(conv);

    // Re-render and re-send
    renderChat();
    sendMessage(true);
  }

  function switchBranch(messageIndex, direction) {
    const conv = state.conversations[state.activeConversationId];
    if (!conv) return;
    const msg = conv.messages[messageIndex];
    if (!msg || !msg.branches || msg.branches.length === 0) return;

    const totalVersions = msg.branches.length + 1; // branches + current
    let currentIdx = msg.activeBranch !== undefined && msg.activeBranch !== null ? msg.activeBranch + 1 : 0;
    let newIdx = currentIdx + direction;
    if (newIdx < 0) newIdx = totalVersions - 1;
    if (newIdx >= totalVersions) newIdx = 0;

    if (newIdx === 0) {
      // Switch to current (non-branch) version — already the default
      if (msg.activeBranch !== null && msg.activeBranch !== undefined) {
        // Swap: current content goes to the branch that was active, branch[0] becomes current
        // Actually, simpler: index 0 = current content, 1..N = branches[0..N-1]
        msg.activeBranch = null;
      }
    } else {
      const branchIdx = newIdx - 1;
      const branch = msg.branches[branchIdx];

      // Swap content
      const currentContent = msg.content;
      const currentFollowUp = conv.messages.slice(messageIndex + 1);
      const currentUsage = msg.usage;

      msg.content = branch.content;
      msg.usage = branch.usage || null;
      msg.activeBranch = branchIdx;

      // Update the branch with what was current
      branch.content = currentContent;
      branch.usage = currentUsage;
      if (msg.role === 'user' && branch.followUp) {
        // Restore follow-up messages from the branch
        conv.messages = conv.messages.slice(0, messageIndex + 1).concat(branch.followUp);
        branch.followUp = currentFollowUp;
      }
    }

    conv.updatedAt = Date.now();
    saveState();
    syncConversationToServer(conv);
    renderChat();
  }

  // ═══════════════════════════════════════════════════
  // PHASE 2: Export + Token Stats
  // ═══════════════════════════════════════════════════

  function exportConversation() {
    const conv = state.conversations[state.activeConversationId];
    if (!conv) {
      showToast('No active conversation to export.');
      return;
    }

    const date = new Date().toLocaleDateString();
    let md = `# ${conv.title}\n`;
    md += `*Exported from Claude Chat on ${date}*\n`;
    md += `*Model: ${state.selectedModel || 'unknown'}*\n\n---\n\n`;

    conv.messages.forEach(msg => {
      const textContent = typeof msg.content === 'object' ? (msg.content.text || '') : (msg.content || '');
      if (msg.role === 'user') {
        md += `**You:** ${textContent}\n\n`;
      } else {
        md += `**Assistant:** ${textContent}\n\n---\n\n`;
      }
    });

    // Download as .md file
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${conv.title.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'chat'}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Conversation exported as Markdown.', 'success');
  }

  function updateConversationTokenDisplay() {
    if (!inputHint) return;
    const conv = state.conversations[state.activeConversationId];
    if (!conv) {
      inputHint.innerHTML = `<kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line, <kbd>Ctrl+V</kbd> to paste images`;
      return;
    }

    // Find the last assistant message with usage data — that represents
    // the most recent API call. prompt_tokens already includes the full
    // conversation history, so summing across turns would double/triple-count.
    let lastTurnUsage = null;
    let totalOutputTokens = 0;
    let totalCost = 0;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const msg = conv.messages[i];
      if (msg.usage) {
        if (!lastTurnUsage) lastTurnUsage = msg.usage;
        totalOutputTokens += (msg.usage.completion_tokens || 0);
        totalCost += estimateCost(msg.usage, state.selectedModel);
      }
    }

    // Last turn tokens = prompt (context sent) + completion (generated)
    const lastTurnTokens = lastTurnUsage
      ? (lastTurnUsage.prompt_tokens || 0) + (lastTurnUsage.completion_tokens || 0)
      : 0;

    state.conversationTokens = lastTurnTokens;
    state.conversationCost = totalCost;

    if (lastTurnTokens > 0) {
      const promptPart = (lastTurnUsage.prompt_tokens || 0).toLocaleString();
      const outputPart = totalOutputTokens.toLocaleString();
      inputHint.innerHTML = `<kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line &nbsp;|&nbsp; <span class="token-stats">${promptPart} ctx + ${outputPart} out (${formatCost(totalCost)})</span>`;
    } else {
      inputHint.innerHTML = `<kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line, <kbd>Ctrl+V</kbd> to paste images`;
    }
  }

  function updateContextBar() {
    if (!contextBarWrapper || !contextBarFill || !contextBarLabel) return;
    const usage = calculateContextUsage();

    // Show context bar only when there's meaningful usage
    if (usage.totalTokens === 0) {
      contextBarWrapper.classList.add('hidden');
      return;
    }
    contextBarWrapper.classList.remove('hidden');

    const pct = Math.min(usage.ratio * 100, 100);
    contextBarFill.style.width = pct.toFixed(1) + '%';

    // Color states
    contextBarFill.classList.remove('context-warning', 'context-danger');
    contextBarLabel.classList.remove('context-warning', 'context-danger');
    if (usage.ratio >= CONTEXT_BLOCK) {
      contextBarFill.classList.add('context-danger');
      contextBarLabel.classList.add('context-danger');
    } else if (usage.ratio >= CONTEXT_WARN) {
      contextBarFill.classList.add('context-warning');
      contextBarLabel.classList.add('context-warning');
    }

    contextBarLabel.textContent = `${formatTokenCount(usage.totalTokens)} / ${formatTokenCount(usage.windowSize)} (${pct.toFixed(0)}%)`;
  }

  // Debounce helper for context bar updates on input
  let _contextBarTimer = null;
  function debouncedUpdateContextBar() {
    clearTimeout(_contextBarTimer);
    _contextBarTimer = setTimeout(updateContextBar, 300);
  }

  // ─── Auto-truncation for context limits ──────────
  function truncateConversationForContext(apiMessages, windowSize) {
    // Helper: estimate tokens from a message's content, ignoring image data URLs
    function msgTokens(m) {
      const c = m.content;
      if (typeof c === 'string') return estimateTokens(c);
      if (Array.isArray(c)) {
        // Multi-part content (text + images) — only count text parts
        let t = 0;
        c.forEach(part => {
          if (part.type === 'text') t += estimateTokens(part.text);
          else t += 85; // ~fixed overhead per image in API
        });
        return t;
      }
      if (c && typeof c === 'object' && c.text) return estimateTokens(c.text);
      return 0;
    }

    // Calculate total tokens
    let total = 0;
    apiMessages.forEach(m => { total += msgTokens(m); });

    if (total <= windowSize * CONTEXT_BLOCK) return apiMessages;

    // Find system messages (always keep) and conversation messages
    const systemMsgs = [];
    const convMsgs = [];
    apiMessages.forEach(m => {
      if (m.role === 'system') systemMsgs.push(m);
      else convMsgs.push(m);
    });

    let systemTokens = 0;
    systemMsgs.forEach(m => { systemTokens += msgTokens(m); });

    const targetTokens = Math.floor(windowSize * CONTEXT_WARN); // Aim for 80% after truncation
    const availableForConv = targetTokens - systemTokens;

    if (availableForConv <= 0) return apiMessages; // Can't truncate enough

    // Keep messages from the end (newest), drop from beginning (oldest)
    const kept = [];
    let keptTokens = 0;
    for (let i = convMsgs.length - 1; i >= 0; i--) {
      const mt = msgTokens(convMsgs[i]);
      if (keptTokens + mt > availableForConv && kept.length > 0) break;
      kept.unshift(convMsgs[i]);
      keptTokens += mt;
    }

    const trimmedCount = convMsgs.length - kept.length;
    if (trimmedCount > 0) {
      showToast(`${trimmedCount} older message(s) trimmed to fit context window.`, 'info');
      const note = { role: 'system', content: `[Note: ${trimmedCount} older messages were trimmed to fit the context window.]` };
      return [...systemMsgs, note, ...kept];
    }

    return apiMessages;
  }

  // ─── Send message ─────────────────────────────────
  async function sendMessage(resendMode) {
    const text = resendMode ? '' : chatInput.value.trim();
    const images = resendMode ? [] : [...pendingImages];

    if (!resendMode && !text && images.length === 0) return;
    if (state.isStreaming) return;

    const model = modelSelector.value;
    if (!model) {
      showToast('Please select a model first.');
      return;
    }

    // Pre-send context validation
    const preUsage = calculateContextUsage();
    if (preUsage.ratio >= CONTEXT_BLOCK) {
      showToast(`Context window is ${(preUsage.ratio * 100).toFixed(0)}% full (${formatTokenCount(preUsage.totalTokens)} / ${formatTokenCount(preUsage.windowSize)}). Please start a new conversation or remove knowledge files.`);
      return;
    }
    if (preUsage.ratio >= CONTEXT_WARN) {
      const proceed = confirm(
        `Context window is ${(preUsage.ratio * 100).toFixed(0)}% full.\n\n` +
        `System/Knowledge: ${formatTokenCount(preUsage.systemTokens)}\n` +
        `Conversation: ${formatTokenCount(preUsage.conversationTokens)}\n` +
        `Pending input: ${formatTokenCount(preUsage.pendingTokens)}\n` +
        `Total: ${formatTokenCount(preUsage.totalTokens)} / ${formatTokenCount(preUsage.windowSize)}\n\n` +
        `Continue sending?`
      );
      if (!proceed) return;
    }

    if (!state.activeConversationId || !state.conversations[state.activeConversationId]) {
      createConversation();
    }

    const conv = state.conversations[state.activeConversationId];

    // If not resend mode, add the user message
    if (!resendMode) {
      const ws = chatMessages.querySelector('.welcome');
      if (ws) ws.remove();

      const storageContent = (images.length > 0)
        ? { text, images: images.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType })) }
        : text;

      conv.messages.push({ role: 'user', content: storageContent });
      conv.updatedAt = Date.now();
      autoTitle(conv.id, text || 'Image');
      saveState();
      syncConversationToServer(conv);

      chatMessages.appendChild(createMessageElement('user', storageContent, conv.messages.length - 1, conv.messages[conv.messages.length - 1]));
      chatInput.value = '';
      pendingImages = [];
      renderImagePreviews();
      autoResize();
      scrollToBottom();
    }

    const assistantDiv = document.createElement('div');
    assistantDiv.className = 'message assistant';
    assistantDiv.innerHTML = `
      <div class="message-wrapper">
        <div class="message-avatar">A</div>
        <div class="message-body">
          <div class="message-content streaming-cursor">
            <div class="typing-indicator"><span></span><span></span><span></span></div>
          </div>
          <div class="streaming-tokens" id="streamingTokenCounter">
            <span class="streaming-dot"></span>
            <span class="streaming-token-count">0 tokens</span>
          </div>
          </div>
        </div>
      </div>
    `;
    chatMessages.appendChild(assistantDiv);
    scrollToBottom();

    setStreaming(true);
    let fullResponse = '';
    let fallbackChecked = false;
    let lastUsage = null;

    try {
      const abortController = new AbortController();
      state.abortController = abortController;

      // Build API messages
      const apiMessages = [];

      // Inject system prompt from active project
      const { text: sysText, images: sysImages } = getActiveProjectSystemPrompt();
      if (sysText || sysImages.length > 0) {
        if (sysImages.length > 0) {
          // Build array-of-parts content for system message with images
          const systemContent = [];
          if (sysText) systemContent.push({ type: 'text', text: sysText });
          sysImages.forEach(img => systemContent.push(img));
          apiMessages.push({ role: 'system', content: systemContent });
        } else {
          apiMessages.push({ role: 'system', content: sysText });
        }
      }

      conv.messages.forEach(m => {
        if (m.role === 'assistant') {
          const t = (typeof m.content === 'object' && m.content !== null) ? m.content.text : m.content;
          apiMessages.push({ role: 'assistant', content: t || '' });
        } else {
          if (typeof m.content === 'object' && m.content !== null && !Array.isArray(m.content) && m.content.images?.length > 0) {
            apiMessages.push({ role: 'user', content: buildMessageContent(m.content.text, m.content.images) });
          } else {
            const t = (typeof m.content === 'object' && m.content !== null) ? m.content.text : m.content;
            apiMessages.push({ role: 'user', content: t || '' });
          }
        }
      });

      // Auto-truncate if approaching context limit
      const windowSize = getContextWindowSize(model);
      const truncatedMessages = truncateConversationForContext(apiMessages, windowSize);

      const res = await fetch(`${getProxyUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: truncatedMessages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        if (res.status === 400 && /not supported|not available|does not exist/i.test(errBody)) {
          markModelDead(model);
          showToast(`Model "${model}" is no longer available. Removing from list.`);
          loadModels();
        }
        throw new Error(`API error ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const contentEl = assistantDiv.querySelector('.message-content');
      const streamingCountEl = assistantDiv.querySelector('.streaming-token-count');

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            // Fallback detection (first chunk only)
            if (!fallbackChecked && parsed.model) {
              fallbackChecked = true;
              const fb = detectFallback(model, parsed.model);
              if (fb.isFallback) {
                showFallbackNotice(assistantDiv, model, fb.requestedLabel, fb.actualLabel);
              }
            }

            // Extract usage from final chunk
            if (parsed.usage) {
              lastUsage = parsed.usage;
            }

            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              contentEl.innerHTML = renderMarkdown(fullResponse);
              contentEl.classList.add('streaming-cursor');
              // Update live token counter
              if (streamingCountEl) {
                const est = estimateTokens(fullResponse);
                streamingCountEl.textContent = `~${est.toLocaleString()} tokens`;
              }
              scrollToBottom();
            }
          } catch (parseErr) {}
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!fullResponse) fullResponse = '*(Generation stopped)*';
      } else {
        console.error('Stream error:', err);
        showToast(`Error: ${err.message}`);
        if (!fullResponse) fullResponse = `*Error: ${err.message}*`;
      }
    }

    const contentEl = assistantDiv.querySelector('.message-content');
    contentEl.classList.remove('streaming-cursor');
    contentEl.innerHTML = renderMarkdown(fullResponse);

    // Remove the live streaming counter (the re-render below adds the final token pill)
    const streamCounter = assistantDiv.querySelector('.streaming-tokens');
    if (streamCounter) streamCounter.remove();

    const assistantMsg = { role: 'assistant', content: fullResponse };
    if (lastUsage) {
      assistantMsg.usage = lastUsage;
    }
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    saveState();
    syncConversationToServer(conv);
    setStreaming(false);

    // Re-render to show action buttons, token info, etc.
    renderChat();
    scrollToBottom();
    updateConversationTokenDisplay();
    updateContextBar();

    if (state.logPanelOpen) {
      setTimeout(fetchLogs, 500);
    }
  }

  // ─── Streaming control ────────────────────────────
  function setStreaming(active) {
    state.isStreaming = active;
    sendBtn.classList.toggle('hidden', active);
    stopBtn.classList.toggle('hidden', !active);
    chatInput.disabled = active;
    if (!active) {
      chatInput.focus();
      updateSendButton();
    }
  }

  function stopStreaming() {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
  }

  // ─── Markdown renderer ────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';

    const codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || 'text', code: code.replace(/\n$/, '') });
      return `%%CODEBLOCK_${idx}%%`;
    });

    text = escapeHtml(text);

    text = text.replace(/%%CODEBLOCK_(\d+)%%/g, (_, idx) => {
      const block = codeBlocks[parseInt(idx)];
      const escapedCode = escapeHtml(block.code);
      return `<div class="code-block">
        <div class="code-block-header">
          <span class="code-block-lang">${escapeHtml(block.lang)}</span>
          <button class="code-copy-btn" onclick="window.__copyCode(this)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy
          </button>
        </div>
        <div class="code-block-body"><code class="code-block-code">${escapedCode}</code></div>
      </div>`;
    });

    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    text = text.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    text = text.replace(/_(.+?)_/g, '<em>$1</em>');
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    text = text.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');
    text = text.replace(/^---$/gm, '<hr>');
    text = text.replace(/^\*\*\*$/gm, '<hr>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/^[\s]*[-*]\s+(.+)$/gm, '<li>$1</li>');
    text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    text = text.replace(/^[\s]*\d+\.\s+(.+)$/gm, '<li>$1</li>');

    text = text.replace(/^(\|.+\|)\n(\|[-|\s:]+\|)\n((?:\|.+\|\n?)+)/gm, (match, header, sep, body) => {
      const headers = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
      const rows = body.trim().split('\n').map(row => {
        const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    });

    text = text.replace(/\n{2,}/g, '</p><p>');
    text = text.replace(/(?<!\>)\n(?!\<)/g, '<br>');

    if (!/^\s*<(h[1-6]|ul|ol|table|div|blockquote|hr|p)/.test(text)) {
      text = '<p>' + text + '</p>';
    }

    text = text.replace(/<p>\s*<\/p>/g, '');

    return text;
  }

  // ─── Code copy ────────────────────────────────────
  window.__copyCode = function (btn) {
    const codeEl = btn.closest('.code-block').querySelector('.code-block-code');
    const text = codeEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Copied!
      `;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy
        `;
      }, 2000);
    });
  };

  // ─── Log Panel ────────────────────────────────────
  function toggleLogPanel() {
    state.logPanelOpen = !state.logPanelOpen;
    logPanel.classList.toggle('hidden', !state.logPanelOpen);
    logResizeHandle.classList.toggle('hidden', !state.logPanelOpen);
    logToggleBtn.classList.toggle('active', state.logPanelOpen);

    if (state.logPanelOpen) {
      const savedWidth = localStorage.getItem(LOG_WIDTH_KEY);
      if (savedWidth) logPanel.style.width = savedWidth + 'px';
      fetchLogs();
      startLogPolling();
    } else {
      stopLogPolling();
    }
  }

  function closeLogPanel() {
    state.logPanelOpen = false;
    logPanel.classList.add('hidden');
    logResizeHandle.classList.add('hidden');
    logToggleBtn.classList.remove('active');
    stopLogPolling();
  }

  function initLogResize() {
    const MIN_WIDTH = 280;
    const MAX_RATIO = 0.7;
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    logResizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDragging = true;
      startX = e.clientX;
      startWidth = logPanel.offsetWidth;
      logResizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const delta = startX - e.clientX;
      const maxWidth = window.innerWidth * MAX_RATIO;
      const newWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + delta));
      logPanel.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      logResizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(LOG_WIDTH_KEY, logPanel.offsetWidth);
    });

    logResizeHandle.addEventListener('dblclick', () => {
      logPanel.style.width = '480px';
      localStorage.removeItem(LOG_WIDTH_KEY);
    });
  }

  function popoutLogs() {
    window.open(`${getServerUrl()}/logs.html`, 'claude-chat-logs', 'width=900,height=650,menubar=no,toolbar=no');
    closeLogPanel();
  }

  function startLogPolling() {
    stopLogPolling();
    state.logPollTimer = setInterval(fetchLogs, LOG_POLL_INTERVAL);
  }

  function stopLogPolling() {
    if (state.logPollTimer) {
      clearInterval(state.logPollTimer);
      state.logPollTimer = null;
    }
  }

  let logSelectionStartTime = 0;
  const LOG_SELECTION_GRACE_MS = 10000;

  function isLogSelectionActive() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const selNode = sel.anchorNode?.parentElement;
      if (selNode && logPanelBody.contains(selNode)) {
        const now = Date.now();
        if (!logSelectionStartTime) logSelectionStartTime = now;
        if (now - logSelectionStartTime < LOG_SELECTION_GRACE_MS) return true;
        sel.removeAllRanges();
        logSelectionStartTime = 0;
        return false;
      }
    }
    logSelectionStartTime = 0;
    return false;
  }

  async function fetchLogs() {
    try {
      if (isLogSelectionActive()) return;
      const level = logLevelFilter.value || 'all';
      const filter = logSearch.value || '';
      const source = logSourceSelector ? logSourceSelector.value : 'proxy';
      const params = new URLSearchParams({ lines: '500', level, filter, source });
      const res = await fetch(`${getServerUrl()}/api/logs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.ok) {
        logPanelBody.innerHTML = `<div class="log-empty">${escapeHtml(data.error || 'Unknown error')}</div>`;
        logFileInfo.textContent = `Error: ${data.error || 'Unknown'}`;
        return;
      }

      logFileInfo.textContent = `${data.file}  |  ${data.total} total lines  |  ${data.filtered} shown`;

      const errorCount = data.lines.filter(l => l.level === 'error').length;
      state.logErrorCount = errorCount;
      if (errorCount > 0) {
        logErrorBadge.textContent = errorCount > 99 ? '99+' : errorCount;
        logErrorBadge.classList.remove('hidden');
      } else {
        logErrorBadge.classList.add('hidden');
      }

      if (isLogSelectionActive()) return;

      const shouldScroll = logAutoScroll.checked;
      const wasAtBottom = logPanelBody.scrollTop + logPanelBody.clientHeight >= logPanelBody.scrollHeight - 20;

      logPanelBody.innerHTML = '';
      if (data.lines.length === 0) {
        logPanelBody.innerHTML = '<div class="log-empty">No matching log entries.</div>';
        return;
      }

      const fragment = document.createDocumentFragment();
      data.lines.forEach(entry => {
        const div = document.createElement('div');
        div.className = `log-line ${entry.level}`;
        div.textContent = entry.text;
        fragment.appendChild(div);
      });
      logPanelBody.appendChild(fragment);

      if (shouldScroll || wasAtBottom) {
        logPanelBody.scrollTop = logPanelBody.scrollHeight;
      }
    } catch (e) {
      console.warn('Failed to fetch logs:', e);
      logPanelBody.innerHTML = `<div class="log-empty">Cannot fetch logs. Make sure you're running server.py<br><br><code>python server.py</code></div>`;
    }
  }

  async function clearLogs() {
    const source = logSourceSelector ? logSourceSelector.value : 'proxy';
    const label = source === 'chat' ? 'chat server' : 'LiteLLM proxy';
    if (!confirm(`Clear the ${label} log file? This cannot be undone.`)) return;
    try {
      const params = new URLSearchParams({ source });
      const res = await fetch(`${getServerUrl()}/api/logs/clear?${params}`);
      if (res.ok) {
        fetchLogs();
        showToast(`${label} logs cleared.`, 'success');
      }
    } catch (e) {
      showToast('Failed to clear logs.');
    }
  }

  // ─── UI Helpers ───────────────────────────────────
  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  function autoResize() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
  }

  function updateSendButton() {
    sendBtn.disabled = !chatInput.value.trim() && pendingImages.length === 0;
  }

  function escapeHtml(str) {
    const el = document.createElement('div');
    el.textContent = str;
    return el.innerHTML;
  }

  function showToast(message, type = 'error') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  function showFallbackNotice(assistantDiv, requestedId, requestedLabel, actualLabel) {
    clearFallbackNotice();
    const notice = document.createElement('div');
    notice.className = 'fallback-notice';
    notice.id = 'fallbackNotice';
    notice.innerHTML = `
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>Fallback: <strong>${requestedLabel}</strong> → <strong>${actualLabel}</strong></span>
      <button class="fallback-dismiss" title="Dismiss">&times;</button>
    `;
    notice.querySelector('.fallback-dismiss').addEventListener('click', () => clearFallbackNotice());
    const wrapper = document.querySelector('.model-selector-wrapper');
    if (wrapper) wrapper.parentNode.insertBefore(notice, wrapper.nextSibling);
  }

  function clearFallbackNotice() {
    const existing = document.getElementById('fallbackNotice');
    if (existing) existing.remove();
  }

  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('visible');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
  }

  // ─── Dialogs ──────────────────────────────────────
  function showRenameDialog(id) {
    pendingRenameId = id;
    renameInput.value = state.conversations[id]?.title || '';
    renameDialog.classList.remove('hidden');
    renameInput.focus();
    renameInput.select();
  }

  function hideRenameDialog() {
    renameDialog.classList.add('hidden');
    pendingRenameId = null;
  }

  function showDeleteDialog(id) {
    pendingDeleteId = id;
    deleteDialog.classList.remove('hidden');
  }

  function hideDeleteDialog() {
    deleteDialog.classList.add('hidden');
    pendingDeleteId = null;
  }

  // ─── Event binding ────────────────────────────────
  function bindEvents() {
    newChatBtn.addEventListener('click', () => createConversation());
    sendBtn.addEventListener('click', () => sendMessage());
    stopBtn.addEventListener('click', stopStreaming);

    chatInput.addEventListener('input', () => {
      autoResize();
      updateSendButton();
      debouncedUpdateContextBar();
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    chatInput.addEventListener('paste', handlePaste);

    document.addEventListener('paste', (e) => {
      if (e.target === chatInput) return;
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== chatInput && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      handlePaste(e);
    });

    const inputContainer = chatInput.closest('.input-container');
    inputContainer.addEventListener('dragover', (e) => { e.preventDefault(); inputContainer.style.borderColor = 'var(--accent)'; });
    inputContainer.addEventListener('dragleave', () => { inputContainer.style.borderColor = ''; });
    inputContainer.addEventListener('drop', (e) => { inputContainer.style.borderColor = ''; handleDrop(e); });

    modelSelector.addEventListener('change', () => {
      state.selectedModel = modelSelector.value;
      localStorage.setItem(MODEL_KEY, state.selectedModel);
      clearFallbackNotice();
      updateContextBar();
    });

    themeToggle.addEventListener('click', toggleTheme);

    proxyInput.addEventListener('change', () => {
      localStorage.setItem(PROXY_KEY, proxyInput.value);
      loadModels();
      checkProxyHealth();
    });

    sidebarToggle.addEventListener('click', () => {
      if (sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
    });
    sidebarOverlay.addEventListener('click', closeSidebar);

    // Rename dialog
    renameCancelBtn.addEventListener('click', hideRenameDialog);
    renameConfirmBtn.addEventListener('click', () => {
      if (pendingRenameId) renameConversation(pendingRenameId, renameInput.value);
      hideRenameDialog();
    });
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); renameConfirmBtn.click(); }
      if (e.key === 'Escape') hideRenameDialog();
    });

    // Delete dialog
    deleteCancelBtn.addEventListener('click', hideDeleteDialog);
    deleteConfirmBtn.addEventListener('click', () => {
      if (pendingDeleteId) deleteConversation(pendingDeleteId);
      hideDeleteDialog();
    });

    renameDialog.addEventListener('click', (e) => { if (e.target === renameDialog) hideRenameDialog(); });
    deleteDialog.addEventListener('click', (e) => { if (e.target === deleteDialog) hideDeleteDialog(); });

    // Project events
    if (projectSelect) {
      projectSelect.addEventListener('change', () => {
        switchProject(projectSelect.value);
      });
    }
    if (projectSettingsBtn) {
      projectSettingsBtn.addEventListener('click', () => {
        if (state.activeProjectId) {
          showProjectDialog(state.activeProjectId);
        }
      });
    }
    if (projectAddBtn) {
      projectAddBtn.addEventListener('click', () => showProjectDialog(null));
    }
    if (projectSaveBtn) {
      projectSaveBtn.addEventListener('click', saveProject);
    }
    if (projectCancelBtn) {
      projectCancelBtn.addEventListener('click', hideProjectDialog);
    }
    if (projectDeleteBtn) {
      projectDeleteBtn.addEventListener('click', deleteProject);
    }
    if (knowledgeAddBtn) {
      knowledgeAddBtn.addEventListener('click', addKnowledgeFile);
    }
    if (projectDialog) {
      projectDialog.addEventListener('click', (e) => { if (e.target === projectDialog) hideProjectDialog(); });
    }

    // Sidebar search
    if (sidebarSearchInput) {
      let searchTimeout;
      sidebarSearchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(renderConversationList, 200);
      });
    }

    // Export button
    if (exportBtn) {
      exportBtn.addEventListener('click', exportConversation);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!renameDialog.classList.contains('hidden')) hideRenameDialog();
        if (!deleteDialog.classList.contains('hidden')) hideDeleteDialog();
        if (projectDialog && !projectDialog.classList.contains('hidden')) hideProjectDialog();
        if (state.logPanelOpen) closeLogPanel();
      }
    });

    document.querySelectorAll('.suggestion-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        chatInput.value = btn.dataset.prompt;
        autoResize();
        sendMessage();
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        createConversation();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        toggleLogPanel();
      }
      // Ctrl+Shift+E to export
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        exportConversation();
      }
    });

    // Log panel events
    logToggleBtn.addEventListener('click', toggleLogPanel);
    logCloseBtn.addEventListener('click', closeLogPanel);
    logPopoutBtn.addEventListener('click', popoutLogs);
    logRefreshBtn.addEventListener('click', fetchLogs);
    logClearBtn.addEventListener('click', clearLogs);

    let logSearchTimeout;
    logSearch.addEventListener('input', () => {
      clearTimeout(logSearchTimeout);
      logSearchTimeout = setTimeout(fetchLogs, 400);
    });
    logLevelFilter.addEventListener('change', fetchLogs);
    if (logSourceSelector) {
      logSourceSelector.addEventListener('change', fetchLogs);
    }
  }

  // ─── Start ────────────────────────────────────────
  init();
})();
