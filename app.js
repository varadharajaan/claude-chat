/* =====================================================
   Claude Chat — app.js
   Chat logic, streaming API, conversation management,
   log viewer, grouped model selector
   ===================================================== */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────
  const STORAGE_KEY = 'claude-chat-data';
  const THEME_KEY = 'claude-chat-theme';
  const MODEL_KEY = 'claude-chat-model';
  const PROXY_KEY = 'claude-chat-proxy';
  const LOG_POLL_INTERVAL = 3000; // ms

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

  // Proxy health refs
  const proxyStatusDot = $('#proxyStatusDot');

  let pendingRenameId = null;
  let pendingDeleteId = null;
  let pendingImages = []; // Array of { dataUrl, mimeType } for images pasted before sending

  // Image preview area ref
  const imagePreviewArea = $('#imagePreviewArea');

  // ─── Model helpers (fully dynamic) ─────────────────
  // No hardcoded model lists — everything derived from /v1/models response
  // and validated against the actual backend

  const DEAD_MODELS_KEY = 'claude-chat-dead-models';

  // Auto-categorize a model ID into a group
  function getModelGroup(id) {
    if (/^(opus|claude.*opus)/i.test(id)) return 'Claude Opus';
    if (/^(sonnet|claude.*sonnet)/i.test(id)) return 'Claude Sonnet';
    if (/^(haiku|claude.*haiku)/i.test(id)) return 'Claude Haiku';
    if (/gpt.*codex/i.test(id)) return 'GPT Codex';
    if (/gpt/i.test(id)) return 'GPT';
    if (/gemini/i.test(id)) return 'Gemini';
    return 'Other';
  }

  // Auto-generate a friendly label from a model ID
  // Labels match what GitHub Copilot CLI shows
  function getModelLabel(id) {
    // Strip date suffixes like -20251001 for display purposes
    const cleanId = id.replace(/-\d{8}$/, '');

    // ── Claude models: explicit mapping matching Copilot CLI ──
    // Short aliases
    if (cleanId === 'opus') return 'Opus 4.6 (default)';
    if (cleanId === 'opus-1m') return 'Opus 4.6 (1M context)';
    if (cleanId === 'sonnet') return 'Sonnet 4.6';
    if (cleanId === 'sonnet-1m') return 'Sonnet 4.6 (1M context)';
    if (cleanId === 'haiku') return 'Haiku 4.5';

    // Long names
    if (cleanId === 'claude-opus-4-6') return 'Opus 4.6 (default)';
    if (cleanId === 'claude-opus-4-6-1m') return 'Opus 4.6 (1M context)';
    if (cleanId === 'claude-opus-4-5') return 'Opus 4.5';
    if (cleanId === 'claude-sonnet-4-6') return 'Sonnet 4.6';
    if (cleanId === 'claude-sonnet-4-6-1m') return 'Sonnet 4.6 (1M context)';
    if (cleanId === 'claude-sonnet-4') return 'Sonnet 4';
    if (cleanId === 'claude-sonnet-4-5') return 'Sonnet 4.5';
    if (cleanId === 'claude-haiku-4') return 'Haiku 4.5';
    if (cleanId === 'claude-haiku-4-5') return 'Haiku 4.5';

    // GPT — match Copilot CLI casing: "GPT-5.1-Codex", "GPT-5 mini"
    if (/^gpt/i.test(cleanId)) {
      return cleanId
        .replace(/^gpt/, 'GPT')
        .replace(/-codex/i, '-Codex')
        .replace(/-mini$/i, ' mini')
        .replace(/-max$/i, '-Max');
    }

    // Gemini — "Gemini 2.5 Pro", "Gemini 3 Pro (Preview)"
    if (/^gemini/i.test(cleanId)) {
      let label = cleanId.split('-').map((w, i) => i === 0 ? 'Gemini' : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (/preview/i.test(cleanId)) {
        label = label.replace(/\s*Preview$/i, '').trim() + ' (Preview)';
      }
      return label;
    }

    // Fallback for any unknown Claude model: strip "claude-" and prettify
    let label = cleanId.replace(/^claude-/, '');
    label = label.replace(/-(\d+)-(\d+)/g, ' $1.$2');
    label = label.replace(/(^|[\s-])(\w)/g, (_, pre, c) => pre + c.toUpperCase());
    label = label.replace(/-/g, ' ');

    return label;
  }

  // Sort priority within a group
  // 1M context models first, then newer versions first (descending)
  function getModelSortKey(id) {
    const cleanId = id.replace(/-\d{8}$/, '');
    // 1M context models come first (prefix 0)
    if (/1m$/i.test(cleanId)) return '0_' + cleanId;
    // For all others, invert the string so higher versions sort first
    // This makes 4-6 appear before 4-5, 5.3 before 5.2, etc.
    return '1_' + cleanId;
  }

  // Group ordering preference
  const GROUP_ORDER = ['Claude Opus', 'Claude Sonnet', 'Claude Haiku', 'GPT Codex', 'GPT', 'Gemini', 'Other'];

  // ─── Fallback detection ──────────────────────────
  // Compares the model you REQUESTED with the model the API ACTUALLY USED.
  // No hardcoded routing map — we trust the API response's `model` field.
  // If the backend silently routes to a different model, we detect it here.

  /**
   * Normalize a model identifier for comparison.
   * Strips provider prefixes (github_copilot/), lowercases, removes date suffixes,
   * and normalizes separators so "claude-opus-4-6" ≈ "claude-opus-4.6".
   */
  function normalizeModelId(id) {
    if (!id) return '';
    return id
      .toLowerCase()
      .replace(/^github_copilot\//i, '')        // strip provider prefix
      .replace(/-\d{8}$/, '')                    // strip date suffix (e.g., -20250929)
      .replace(/\./g, '-')                       // dots → dashes (4.6 → 4-6)
      .replace(/\s+/g, '-')                      // spaces → dashes
      .trim();
  }

  /**
   * Check if the backend model matches what we requested.
   * Returns { isFallback: bool, requestedLabel: string, actualLabel: string }
   *
   * Pure API-driven: compares the model ID you sent with the model field
   * in the API response. No hardcoded routing map.
   */
  function detectFallback(requestedModel, actualBackendModel) {
    if (!actualBackendModel || !requestedModel) return { isFallback: false };

    const reqNorm = normalizeModelId(requestedModel);
    const actNorm = normalizeModelId(actualBackendModel);

    // Exact match after normalization — no fallback
    if (reqNorm === actNorm) return { isFallback: false };

    // Different → fallback detected
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
    // "github_copilot/claude-opus-4.6-1m" → "claude-opus-4.6-1m"
    // "github_copilot/Claude Sonnet 4.5"  → "Claude Sonnet 4.5"
    return backendModel.replace(/^github_copilot\//i, '');
  }

  // Load dead models from localStorage
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

  // ─── Init ─────────────────────────────────────────
  function init() {
    loadState();
    loadTheme();
    loadProxy();
    // Clear dead models cache on fresh page load — re-validate from scratch
    localStorage.removeItem(DEAD_MODELS_KEY);
    loadModels();
    renderConversationList();
    if (state.activeConversationId && state.conversations[state.activeConversationId]) {
      renderChat();
    }
    bindEvents();
    autoResize();

    // Check proxy health on startup (non-blocking, no toast on first load)
    checkProxyHealth(true);

    // Server-side persistence: restore from server if localStorage is empty,
    // otherwise push local data to server in background
    const hasLocal = Object.keys(state.conversations).length > 0;
    if (!hasLocal) {
      restoreFromServer();
    } else {
      backgroundSync();
    }
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
  // localStorage = fast cache, server = durable backup
  // Writes are fire-and-forget; reads only on init if localStorage is empty

  const SYNC_KEY = 'claude-chat-synced';

  /** Save a single conversation to the server (non-blocking). */
  function syncConversationToServer(conv) {
    const serverUrl = getServerUrl();
    fetch(`${serverUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(conv),
    }).catch(() => {}); // silent — server may not be running
  }

  /** Delete a conversation on the server (non-blocking). */
  function deleteConversationOnServer(convId) {
    const serverUrl = getServerUrl();
    fetch(`${serverUrl}/api/conversations/${convId}`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  /** Push ALL conversations to server (for initial migration). */
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

  /** Load conversations from server (only if localStorage is empty). */
  async function restoreFromServer() {
    try {
      const serverUrl = getServerUrl();
      const res = await fetch(`${serverUrl}/api/conversations`);
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.ok || !data.conversations || data.conversations.length === 0) return false;

      // Fetch full data for each conversation
      let restored = 0;
      for (const summary of data.conversations) {
        try {
          const cRes = await fetch(`${serverUrl}/api/conversations/${summary.id}`);
          const cData = await cRes.json();
          if (cData.ok && cData.conversation) {
            state.conversations[summary.id] = cData.conversation;
            restored++;
          }
        } catch (e) { /* skip this one */ }
      }

      if (restored > 0) {
        // Set active to most recent
        const sorted = Object.values(state.conversations)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        state.activeConversationId = sorted[0]?.id || null;
        saveState(); // persist to localStorage
        renderConversationList();
        renderChat();
        showToast(`Restored ${restored} conversation${restored > 1 ? 's' : ''} from server`);
        return true;
      }
    } catch (e) {
      // Server not running or unreachable — that's fine
    }
    return false;
  }

  /** Background sync: push local to server + pull any missing from server. */
  function backgroundSync() {
    const alreadySynced = localStorage.getItem(SYNC_KEY);
    const hasConversations = Object.keys(state.conversations).length > 0;

    if (hasConversations && !alreadySynced) {
      // First time: bulk export all existing localStorage conversations to server
      exportAllToServer();
    }

    // Also pull any conversations from server that aren't in localStorage
    // (e.g., created from a different browser)
    mergeFromServer();
  }

  /** Merge server-side conversations that are missing from localStorage. */
  async function mergeFromServer() {
    try {
      const serverUrl = getServerUrl();
      const res = await fetch(`${serverUrl}/api/conversations`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !data.conversations) return;

      let merged = 0;
      for (const summary of data.conversations) {
        // Skip if we already have it locally
        if (state.conversations[summary.id]) continue;

        try {
          const cRes = await fetch(`${serverUrl}/api/conversations/${summary.id}`);
          const cData = await cRes.json();
          if (cData.ok && cData.conversation) {
            state.conversations[summary.id] = cData.conversation;
            merged++;
          }
        } catch (e) { /* skip */ }
      }

      if (merged > 0) {
        saveState();
        renderConversationList();
        showToast(`Merged ${merged} conversation${merged > 1 ? 's' : ''} from server`);
      }
    } catch (e) {
      // Server not reachable — that's fine
    }
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

  /** Check if the proxy URL is reachable and show green/red indicator + popup.
   *  @param {boolean} silent — if true, only update the dot indicator (no toast). Used on page load. */
  async function checkProxyHealth(silent) {
    const url = getProxyUrl();
    if (!url) return;

    // Set checking state
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
        // Working
        if (proxyStatusDot) {
          proxyStatusDot.className = 'proxy-status-dot ok';
          proxyStatusDot.title = `Proxy is working (${url})`;
        }
        if (!silent) showProxyHealthToast(true, url);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      // Try /v1/models as fallback (some proxies don't have /health)
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
      } catch (e2) { /* fall through */ }

      // Not working
      if (proxyStatusDot) {
        proxyStatusDot.className = 'proxy-status-dot fail';
        proxyStatusDot.title = `Proxy not reachable (${url})`;
      }
      if (!silent) showProxyHealthToast(false, url);
    }
  }

  function showProxyHealthToast(ok, url) {
    // Remove any existing health toast
    document.querySelectorAll('.proxy-health-toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = `proxy-health-toast ${ok ? 'ok' : 'fail'}`;
    toast.textContent = ok
      ? `Proxy is working`
      : `Proxy not reachable`;

    // Insert above the proxy config row in sidebar
    const proxyConfig = document.querySelector('.proxy-config');
    if (proxyConfig) {
      proxyConfig.parentElement.insertBefore(toast, proxyConfig);
    } else {
      document.body.appendChild(toast);
    }

    // Auto-remove after animation
    setTimeout(() => toast.remove(), 3000);
  }

  // ─── Server URL (for log API) ─────────────────────
  function getServerUrl() {
    // The log server runs on the same origin when using server.py
    return window.location.origin;
  }

  // ─── Models ───────────────────────────────────────
  async function loadModels() {
    modelSelector.innerHTML = '<option value="">Loading models...</option>';
    try {
      const res = await fetch(`${getProxyUrl()}/v1/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Get all model IDs, filter out wildcard duplicates (ending with *)
      // Also filter out "fast" variants — fast mode is a speed tier, not a separate model
      const allModels = (data.data || []).map(m => m.id);
      const deadModels = getDeadModels();
      state.models = allModels
        .filter(id => !id.endsWith('*'))
        .filter(id => !/-fast$/i.test(id))
        .filter(id => !deadModels[id])
        .sort();

      // Inject virtual models: the proxy supports these but doesn't list them in /v1/models
      // 1M context variants and missing version aliases that route to valid backends.
      // These are also subject to dead-model filtering — if a virtual model returns 400
      // "not supported", it gets marked dead and won't appear for 1 hour.
      const virtualModels = [
        'claude-opus-4-6-1m',     // routes to github_copilot/claude-opus-4.6-1m
        'claude-sonnet-4-6-1m',   // routes to github_copilot/Claude Sonnet 4.6
        'claude-sonnet-4-5',      // routes to github_copilot/Claude Sonnet 4.5
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

      // Figure out duplicates: short aliases that route to the same backend as a long name
      // Hide the short alias if the long name exists (keep the descriptive long name)
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

      // Also hide date-suffixed duplicates: e.g. claude-haiku-4-5-20251001 when claude-haiku-4-5 exists
      state.models.forEach(id => {
        const dateStripped = id.replace(/-\d{8}$/, '');
        if (dateStripped !== id && modelsSet.has(dateStripped)) {
          hiddenAliases.add(id);
        }
      });

      // Hide models that would produce duplicate labels (same backend, same display name)
      const sameBackend = {
        'claude-haiku-4-5': 'claude-haiku-4',
      };
      Object.entries(sameBackend).forEach(([dup, keep]) => {
        if (modelsSet.has(dup) && modelsSet.has(keep)) hiddenAliases.add(dup);
      });

      // Dynamically group models
      const groups = {};
      state.models.forEach(id => {
        if (hiddenAliases.has(id)) return;
        const group = getModelGroup(id);
        if (!groups[group]) groups[group] = [];
        groups[group].push(id);
      });

      // Sort models within each group: 1M first, then by version descending (newer first)
      Object.keys(groups).forEach(g => {
        groups[g].sort((a, b) => {
          const ka = getModelSortKey(a);
          const kb = getModelSortKey(b);
          // 1M models (prefix '0_') come first, then within same prefix sort descending
          if (ka[0] !== kb[0]) return ka.localeCompare(kb);
          return kb.localeCompare(ka); // descending for newer versions first
        });
      });

      // Render in preferred order
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

      // Any remaining ungrouped
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

      // Restore saved model
      if (state.selectedModel && state.models.includes(state.selectedModel)) {
        modelSelector.value = state.selectedModel;
      } else {
        // Default preference order: claude-opus-4-6 > opus > first available
        const defaultPref = ['claude-opus-4-6', 'opus'];
        state.selectedModel = defaultPref.find(m => state.models.includes(m)) || state.models[0];
        modelSelector.value = state.selectedModel;
      }
    } catch (e) {
      console.warn('Failed to load models', e);
      modelSelector.innerHTML = '<option value="">Cannot reach proxy</option>';
    }
  }

  // ─── Conversations ────────────────────────────────
  function createConversation() {
    const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    state.conversations[id] = {
      id,
      title: 'New chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.activeConversationId = id;
    saveState();
    syncConversationToServer(state.conversations[id]);
    renderConversationList();
    renderChat();
    chatInput.focus();
    return id;
  }

  function switchConversation(id) {
    if (!state.conversations[id]) return;
    state.activeConversationId = id;
    saveState();
    renderConversationList();
    renderChat();
    closeSidebar();
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
    const sorted = Object.values(state.conversations)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    sorted.forEach(conv => {
      const div = document.createElement('div');
      div.className = 'conversation-item' + (conv.id === state.activeConversationId ? ' active' : '');
      div.innerHTML = `
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
        if (e.target.closest('.conv-action-btn')) return;
        switchConversation(conv.id);
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

  // Build the message content for API — either a string or multimodal array
  function buildMessageContent(text, images) {
    if (!images || images.length === 0) {
      return text;
    }
    // OpenAI vision format: array of content parts
    const parts = [];
    images.forEach(img => {
      parts.push({
        type: 'image_url',
        image_url: { url: img.dataUrl },
      });
    });
    if (text) {
      parts.push({ type: 'text', text });
    }
    return parts;
  }

  // Build content for storage (we store images inline as data URLs for localStorage persistence)
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

    conv.messages.forEach(msg => {
      chatMessages.appendChild(createMessageElement(msg.role, msg.content));
    });

    scrollToBottom();
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

  function createMessageElement(role, content) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const avatar = role === 'user' ? 'Y' : 'A';

    // Support both old string format and new {text, images} format
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

    div.innerHTML = `
      <div class="message-wrapper">
        <div class="message-avatar">${avatar}</div>
        <div class="message-content">${imagesHtml}${renderedContent}</div>
      </div>
    `;
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

  // ─── Send message ─────────────────────────────────
  async function sendMessage() {
    const text = chatInput.value.trim();
    const images = [...pendingImages];

    if ((!text && images.length === 0) || state.isStreaming) return;

    const model = modelSelector.value;
    if (!model) {
      showToast('Please select a model first.');
      return;
    }

    if (!state.activeConversationId || !state.conversations[state.activeConversationId]) {
      createConversation();
    }

    const conv = state.conversations[state.activeConversationId];

    const ws = chatMessages.querySelector('.welcome');
    if (ws) ws.remove();

    // Store message with images for display
    const storageContent = (images.length > 0)
      ? { text, images: images.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType })) }
      : text;

    conv.messages.push({ role: 'user', content: storageContent });
    conv.updatedAt = Date.now();
    autoTitle(conv.id, text || 'Image');
    saveState();
    syncConversationToServer(conv);

    chatMessages.appendChild(createMessageElement('user', storageContent));
    chatInput.value = '';
    pendingImages = [];
    renderImagePreviews();
    autoResize();
    scrollToBottom();

    const assistantDiv = document.createElement('div');
    assistantDiv.className = 'message assistant';
    assistantDiv.innerHTML = `
      <div class="message-wrapper">
        <div class="message-avatar">A</div>
        <div class="message-content streaming-cursor">
          <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;
    chatMessages.appendChild(assistantDiv);
    scrollToBottom();

    setStreaming(true);
    let fullResponse = '';
    let fallbackChecked = false;  // Only check first chunk for fallback

    try {
      const abortController = new AbortController();
      state.abortController = abortController;

      // Build API messages — convert stored format to OpenAI API format
      const apiMessages = conv.messages.map(m => {
        if (m.role === 'assistant') {
          // Assistant messages are always plain text
          const t = (typeof m.content === 'object' && m.content !== null) ? m.content.text : m.content;
          return { role: 'assistant', content: t || '' };
        }
        // User messages may have images
        if (typeof m.content === 'object' && m.content !== null && !Array.isArray(m.content) && m.content.images?.length > 0) {
          return {
            role: 'user',
            content: buildMessageContent(m.content.text, m.content.images),
          };
        }
        const t = (typeof m.content === 'object' && m.content !== null) ? m.content.text : m.content;
        return { role: 'user', content: t || '' };
      });

      const res = await fetch(`${getProxyUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: apiMessages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        // Detect dead/unsupported models and remove them from the list
        if (res.status === 400 && /not supported|not available|does not exist/i.test(errBody)) {
          markModelDead(model);
          showToast(`Model "${model}" is no longer available. Removing from list.`);
          loadModels(); // refresh the dropdown
        }
        throw new Error(`API error ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const contentEl = assistantDiv.querySelector('.message-content');

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

            // ─── Fallback detection (first chunk only) ───
            if (!fallbackChecked && parsed.model) {
              fallbackChecked = true;
              console.log('[Fallback] requested:', model, '| actual:', parsed.model,
                '| reqNorm:', normalizeModelId(model), '| actNorm:', normalizeModelId(parsed.model));
              const fb = detectFallback(model, parsed.model);
              console.log('[Fallback] result:', fb);
              if (fb.isFallback) {
                showFallbackNotice(assistantDiv, model, fb.requestedLabel, fb.actualLabel);
              }
            }

            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              contentEl.innerHTML = renderMarkdown(fullResponse);
              contentEl.classList.add('streaming-cursor');
              scrollToBottom();
            }
          } catch (parseErr) {
            // skip malformed chunks
          }
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

    conv.messages.push({ role: 'assistant', content: fullResponse });
    conv.updatedAt = Date.now();
    saveState();
    syncConversationToServer(conv);
    setStreaming(false);
    scrollToBottom();

    // Refresh logs after a response to show the new request in the log panel
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
    logToggleBtn.classList.toggle('active', state.logPanelOpen);

    if (state.logPanelOpen) {
      fetchLogs();
      startLogPolling();
    } else {
      stopLogPolling();
    }
  }

  function closeLogPanel() {
    state.logPanelOpen = false;
    logPanel.classList.add('hidden');
    logToggleBtn.classList.remove('active');
    stopLogPolling();
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

  let logSelectionStartTime = 0;  // Timestamp when user first selected text in logs
  const LOG_SELECTION_GRACE_MS = 10000; // 10 seconds to copy before logs resume

  /**
   * Check if user has an active text selection in the log panel
   * that should block DOM updates. Returns true if we should skip.
   */
  function isLogSelectionActive() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const selNode = sel.anchorNode?.parentElement;
      if (selNode && logPanelBody.contains(selNode)) {
        const now = Date.now();
        if (!logSelectionStartTime) logSelectionStartTime = now;
        if (now - logSelectionStartTime < LOG_SELECTION_GRACE_MS) {
          return true; // Within grace period — don't touch the DOM
        }
        // Grace period expired — clear selection and resume
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
      // Early check — skip entire fetch if selection is active
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

      // Update file info
      logFileInfo.textContent = `${data.file}  |  ${data.total} total lines  |  ${data.filtered} shown`;

      // Count errors for badge
      const errorCount = data.lines.filter(l => l.level === 'error').length;
      state.logErrorCount = errorCount;
      if (errorCount > 0) {
        logErrorBadge.textContent = errorCount > 99 ? '99+' : errorCount;
        logErrorBadge.classList.remove('hidden');
      } else {
        logErrorBadge.classList.add('hidden');
      }

      // Render log lines — re-check selection after async fetch (race condition guard)
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

      // Auto-scroll to bottom
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
        showToast(`${label} logs cleared.`);
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

  function showToast(message) {
    const existing = document.querySelector('.error-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  /**
   * Show a fallback notice inline next to the model dropdown.
   * Stays visible until dismissed or model is changed.
   */
  function showFallbackNotice(assistantDiv, requestedId, requestedLabel, actualLabel) {
    // Remove any existing fallback notice
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

    // Insert right after the model selector wrapper in the topbar
    const wrapper = document.querySelector('.model-selector-wrapper');
    if (wrapper) {
      wrapper.parentNode.insertBefore(notice, wrapper.nextSibling);
    }
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
    sendBtn.addEventListener('click', sendMessage);
    stopBtn.addEventListener('click', stopStreaming);

    chatInput.addEventListener('input', () => {
      autoResize();
      updateSendButton();
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Image paste support
    chatInput.addEventListener('paste', handlePaste);

    // Also support paste anywhere in the main area (e.g., user clicks outside textarea)
    document.addEventListener('paste', (e) => {
      // Skip if the event already came from the chatInput (avoid double-paste)
      if (e.target === chatInput) return;
      // Only handle if no dialog is open and not focused on another input
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== chatInput && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      handlePaste(e);
    });

    // Drag and drop images
    const inputContainer = chatInput.closest('.input-container');
    inputContainer.addEventListener('dragover', (e) => { e.preventDefault(); inputContainer.style.borderColor = 'var(--accent)'; });
    inputContainer.addEventListener('dragleave', () => { inputContainer.style.borderColor = ''; });
    inputContainer.addEventListener('drop', (e) => { inputContainer.style.borderColor = ''; handleDrop(e); });

    modelSelector.addEventListener('change', () => {
      state.selectedModel = modelSelector.value;
      localStorage.setItem(MODEL_KEY, state.selectedModel);
      clearFallbackNotice();
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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!renameDialog.classList.contains('hidden')) hideRenameDialog();
        if (!deleteDialog.classList.contains('hidden')) hideDeleteDialog();
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

    // Ctrl+Shift+N for new chat
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        createConversation();
      }
      // Ctrl+L to toggle log panel
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        toggleLogPanel();
      }
    });

    // ── Log panel events ──
    logToggleBtn.addEventListener('click', toggleLogPanel);
    logCloseBtn.addEventListener('click', closeLogPanel);
    logPopoutBtn.addEventListener('click', popoutLogs);
    logRefreshBtn.addEventListener('click', fetchLogs);
    logClearBtn.addEventListener('click', clearLogs);

    // Re-fetch logs when filter/level/source changes
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
