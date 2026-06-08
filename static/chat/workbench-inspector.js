"use strict";

(function attachWorkbenchInspector(root) {
  const INSPECTOR_OPEN_STORAGE_KEY = "remotelab.workbenchInspectorOpen";
  const INSPECTOR_TAB_STORAGE_KEY = "remotelab.workbenchInspectorTab";
  const DESKTOP_QUERY = "(min-width: 1181px)";
  const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
  const MAX_ACTIVITY_ITEMS = 10;
  const MAX_DIFF_PREVIEW_LINES = 80;

  const state = {
    sessionId: "",
    session: null,
    events: [],
    activeTab: readStoredTab(),
    loading: false,
    error: "",
    fetchTimer: null,
    requestSeq: 0,
  };

  const dom = {
    button: null,
    closeButton: null,
    panel: null,
    body: null,
    tabs: [],
  };

  function tr(key, vars) {
    return root.remotelabT ? root.remotelabT(key, vars) : key;
  }

  function escapeHtml(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function readStoredTab() {
    try {
      const value = localStorage.getItem(INSPECTOR_TAB_STORAGE_KEY);
      return value === "review" ? "review" : "summary";
    } catch {
      return "summary";
    }
  }

  function writeStoredTab(tab) {
    try {
      localStorage.setItem(INSPECTOR_TAB_STORAGE_KEY, tab);
    } catch {}
  }

  function readStoredOpen() {
    try {
      const value = localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
      if (value === "true") return true;
      if (value === "false") return false;
    } catch {}
    return root.matchMedia?.(DESKTOP_QUERY)?.matches === true;
  }

  function hasStoredOpenPreference() {
    try {
      return localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  function writeStoredOpen(open) {
    try {
      localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, open ? "true" : "false");
    } catch {}
  }

  function getCurrentSessionSafe() {
    if (typeof getCurrentSession === "function") {
      return getCurrentSession();
    }
    const sessionId = typeof currentSessionId !== "undefined" ? currentSessionId : "";
    if (typeof getChatStoreSession === "function") {
      return getChatStoreSession(sessionId);
    }
    if (typeof sessions !== "undefined" && Array.isArray(sessions)) {
      return sessions.find((session) => session?.id === sessionId) || null;
    }
    return null;
  }

  function getShortPath(path) {
    const value = String(path || "");
    return value.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  }

  function getSessionTitle(session) {
    if (typeof root.getSessionDisplayName === "function") {
      return root.getSessionDisplayName(session);
    }
    return session?.name || getShortPath(session?.folder || "") || tr("session.defaultName");
  }

  function normalizeEvents(events) {
    return (Array.isArray(events) ? events : [])
      .filter((event) => event && typeof event === "object")
      .map((event, index) => ({
        ...event,
        seq: Number.isInteger(event.seq) && event.seq > 0 ? event.seq : index + 1,
      }));
  }

  function eventKey(event) {
    if (typeof event?.id === "string" && event.id) return `id:${event.id}`;
    if (Number.isInteger(event?.seq) && event.seq > 0) return `seq:${event.seq}`;
    return `${event?.type || "event"}:${event?.timestamp || ""}:${JSON.stringify(event).slice(0, 120)}`;
  }

  function mergeEvents(existing, incoming) {
    const next = [];
    const seen = new Set();
    for (const event of normalizeEvents(existing)) {
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(event);
    }
    for (const event of normalizeEvents(incoming)) {
      if (event.type === "text_delta") continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(event);
    }
    next.sort((a, b) => {
      const aSeq = Number.isInteger(a.seq) ? a.seq : 0;
      const bSeq = Number.isInteger(b.seq) ? b.seq : 0;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
    return next;
  }

  function parseToolInput(toolInput) {
    if (!toolInput) return {};
    if (typeof toolInput === "object") return toolInput;
    if (typeof toolInput !== "string") return {};
    try {
      const parsed = JSON.parse(toolInput);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function parseFileEdit(event) {
    const toolName = event?.toolName || "";
    if (!FILE_EDIT_TOOLS.has(toolName)) return null;
    const input = parseToolInput(event.toolInput);
    const filePath = input.file_path || input.path || "";
    if (!filePath) return null;
    if (toolName === "Write") {
      return {
        filePath,
        changeType: "add",
        source: toolName,
        edits: [{ oldText: "", newText: input.content || "" }],
      };
    }
    if (toolName === "Edit") {
      return {
        filePath,
        changeType: "edit",
        source: toolName,
        edits: [{
          oldText: input.old_string || "",
          newText: input.new_string || "",
        }],
      };
    }
    const edits = Array.isArray(input.edits)
      ? input.edits.map((edit) => ({
          oldText: edit?.old_string || "",
          newText: edit?.new_string || "",
        }))
      : [];
    return {
      filePath,
      changeType: "edit",
      source: toolName,
      edits,
    };
  }

  function computeLineDiff(oldText, newText) {
    const oldLines = String(oldText || "").split("\n");
    const newLines = String(newText || "").split("\n");
    const m = oldLines.length;
    const n = newLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i += 1) {
      for (let j = 1; j <= n; j += 1) {
        dp[i][j] = oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const diff = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        diff.unshift({ type: "equal", text: oldLines[i - 1] });
        i -= 1;
        j -= 1;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        diff.unshift({ type: "add", text: newLines[j - 1] });
        j -= 1;
      } else {
        diff.unshift({ type: "remove", text: oldLines[i - 1] });
        i -= 1;
      }
    }
    return diff;
  }

  function summarizeEditDiff(edits) {
    let added = 0;
    let removed = 0;
    const preview = [];
    for (const edit of Array.isArray(edits) ? edits : []) {
      const diff = computeLineDiff(edit.oldText, edit.newText);
      for (const line of diff) {
        if (line.type === "add") added += 1;
        if (line.type === "remove") removed += 1;
        if (line.type !== "equal" && preview.length < MAX_DIFF_PREVIEW_LINES) {
          preview.push(line);
        }
      }
    }
    return { added, removed, preview };
  }

  function getChangeLabel(kind) {
    const normalized = String(kind || "update").toLowerCase();
    if (normalized === "add" || normalized === "added" || normalized === "create") {
      return tr("workbench.change.add");
    }
    if (normalized === "delete" || normalized === "deleted" || normalized === "remove") {
      return tr("workbench.change.delete");
    }
    if (normalized === "edit" || normalized === "modified") {
      return tr("workbench.change.edit");
    }
    return tr("workbench.change.update");
  }

  function collectArtifacts(events) {
    const artifacts = [];
    const seen = new Set();
    for (const event of events) {
      const attachments = Array.isArray(event.attachments)
        ? event.attachments
        : (Array.isArray(event.images) ? event.images : []);
      for (const attachment of attachments) {
        if (!(attachment && typeof attachment === "object")) continue;
        const name = attachment.originalName || attachment.filename || attachment.name || "artifact";
        const url = attachment.downloadUrl || attachment.objectUrl || "";
        const key = attachment.assetId || url || `${name}:${attachment.sizeBytes || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        artifacts.push({
          name,
          url,
          mimeType: attachment.mimeType || "",
          sizeBytes: Number.isFinite(attachment.sizeBytes) ? attachment.sizeBytes : null,
        });
      }
    }
    return artifacts;
  }

  function buildInspectorModel() {
    const events = normalizeEvents(state.events);
    const session = state.session || getCurrentSessionSafe();
    const tools = new Map();
    const files = new Map();
    const activity = [];
    let userTurns = 0;
    let assistantMessages = 0;

    for (const event of events) {
      if (event.type === "message" && event.role === "user") userTurns += 1;
      if (event.type === "message" && event.role === "assistant") assistantMessages += 1;

      if (event.type === "tool_use") {
        const toolName = event.toolName || "tool";
        const count = (tools.get(toolName)?.count || 0) + 1;
        tools.set(toolName, { name: toolName, count, latestSeq: event.seq || 0 });
        activity.push({
          type: "tool",
          title: toolName,
          subtitle: summarizeToolInput(event.toolInput),
          seq: event.seq || 0,
        });
        const edit = parseFileEdit(event);
        if (edit) {
          const diff = summarizeEditDiff(edit.edits);
          const previous = files.get(edit.filePath) || {
            filePath: edit.filePath,
            changeType: edit.changeType,
            added: 0,
            removed: 0,
            preview: [],
            source: edit.source,
            latestSeq: 0,
          };
          previous.changeType = edit.changeType || previous.changeType;
          previous.added += diff.added;
          previous.removed += diff.removed;
          previous.preview.push(...diff.preview);
          previous.preview = previous.preview.slice(0, MAX_DIFF_PREVIEW_LINES);
          previous.source = edit.source || previous.source;
          previous.latestSeq = Math.max(previous.latestSeq || 0, event.seq || 0);
          files.set(edit.filePath, previous);
        }
      }

      if (event.type === "file_change") {
        const filePath = event.filePath || "";
        if (!filePath) continue;
        const previous = files.get(filePath) || {
          filePath,
          changeType: event.changeType || "update",
          added: 0,
          removed: 0,
          preview: [],
          source: "",
          latestSeq: 0,
        };
        previous.changeType = event.changeType || previous.changeType;
        previous.latestSeq = Math.max(previous.latestSeq || 0, event.seq || 0);
        files.set(filePath, previous);
        activity.push({
          type: "file",
          title: filePath,
          subtitle: getChangeLabel(event.changeType),
          seq: event.seq || 0,
        });
      }

      if (event.type === "status" && event.content && !["thinking", "completed"].includes(String(event.content).toLowerCase())) {
        activity.push({
          type: "status",
          title: String(event.content),
          subtitle: "",
          seq: event.seq || 0,
        });
      }
    }

    const artifacts = collectArtifacts(events);
    activity.sort((a, b) => (b.seq || 0) - (a.seq || 0));

    return {
      session,
      events,
      userTurns,
      assistantMessages,
      tools: Array.from(tools.values()).sort((a, b) => b.latestSeq - a.latestSeq),
      files: Array.from(files.values()).sort((a, b) => b.latestSeq - a.latestSeq),
      activity: activity.slice(0, MAX_ACTIVITY_ITEMS),
      artifacts,
    };
  }

  function summarizeToolInput(toolInput) {
    if (!toolInput) return "";
    if (typeof toolInput === "string") {
      return toolInput.replace(/\s+/g, " ").trim().slice(0, 140);
    }
    try {
      return JSON.stringify(toolInput).replace(/\s+/g, " ").slice(0, 140);
    } catch {
      return "";
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderStatusCard(model) {
    const session = model.session || {};
    const activity = typeof getSessionActivity === "function"
      ? getSessionActivity(session)
      : (session.activity || {});
    const runState = activity?.run?.state || "idle";
    const statusClass = session.archived ? "archived" : (runState === "running" ? "running" : "");
    const statusText = session.archived ? tr("status.archived") : tr(`status.${runState}`) || runState;
    const rows = [
      [tr("workbench.meta.agent"), session.tool || ""],
      [tr("workbench.meta.model"), session.model || session.effort || ""],
      [tr("workbench.meta.folder"), getShortPath(session.folder || "")],
      [tr("workbench.meta.messages"), String(model.userTurns + model.assistantMessages)],
    ].filter((row) => row[1]);

    return `
      <div class="workbench-status-card">
        <div class="workbench-status-line">
          <div class="workbench-status-title" title="${escapeHtml(getSessionTitle(session))}">${escapeHtml(getSessionTitle(session))}</div>
          <span class="workbench-pill ${escapeHtml(statusClass)}">${escapeHtml(statusText)}</span>
        </div>
        <div class="workbench-meta">
          ${rows.map(([label, value]) => `
            <div class="workbench-meta-row">
              <span class="workbench-meta-label">${escapeHtml(label)}</span>
              <span class="workbench-meta-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
            </div>
          `).join("")}
        </div>
      </div>`;
  }

  function renderStats(model) {
    return `
      <div class="workbench-stats-grid">
        <div class="workbench-stat">
          <div class="workbench-stat-value">${model.userTurns}</div>
          <div class="workbench-stat-label">${escapeHtml(tr("workbench.stat.turns"))}</div>
        </div>
        <div class="workbench-stat">
          <div class="workbench-stat-value">${model.tools.length}</div>
          <div class="workbench-stat-label">${escapeHtml(tr("workbench.stat.tools"))}</div>
        </div>
        <div class="workbench-stat">
          <div class="workbench-stat-value">${model.files.length}</div>
          <div class="workbench-stat-label">${escapeHtml(tr("workbench.stat.files"))}</div>
        </div>
      </div>`;
  }

  function renderActivity(model) {
    if (model.activity.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noActivity"))}</div>`;
    }
    return `<div class="workbench-activity-list">
      ${model.activity.map((item) => `
        <div class="workbench-activity-item">
          <span class="workbench-activity-dot ${escapeHtml(item.type)}"></span>
          <div>
            <div class="workbench-activity-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            ${item.subtitle ? `<div class="workbench-activity-subtitle" title="${escapeHtml(item.subtitle)}">${escapeHtml(item.subtitle)}</div>` : ""}
          </div>
        </div>
      `).join("")}
    </div>`;
  }

  function renderArtifacts(model) {
    if (model.artifacts.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noArtifacts"))}</div>`;
    }
    return `<div class="workbench-artifact-list">
      ${model.artifacts.map((artifact) => {
        const meta = [artifact.mimeType, formatBytes(artifact.sizeBytes)].filter(Boolean).join(" / ");
        const content = `
          <div>${escapeHtml(artifact.name)}</div>
          ${meta ? `<div class="workbench-artifact-meta">${escapeHtml(meta)}</div>` : ""}
        `;
        if (artifact.url) {
          return `<a class="workbench-artifact-item" href="${escapeHtml(artifact.url)}" target="_blank" rel="noreferrer noopener">${content}</a>`;
        }
        return `<div class="workbench-artifact-item">${content}</div>`;
      }).join("")}
    </div>`;
  }

  function renderSummary(model) {
    return `
      <section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.status"))}</div>
        ${renderStatusCard(model)}
      </section>
      <section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.stats"))}</div>
        ${renderStats(model)}
      </section>
      <section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.activity"))}</div>
        ${renderActivity(model)}
      </section>
      <section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.artifacts"))}</div>
        ${renderArtifacts(model)}
      </section>`;
  }

  function renderDiffPreview(file) {
    if (!Array.isArray(file.preview) || file.preview.length === 0) return "";
    return `<div class="workbench-diff-preview">
      ${file.preview.slice(0, MAX_DIFF_PREVIEW_LINES).map((line) => `
        <div class="workbench-diff-line ${escapeHtml(line.type)}">
          <span>${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
          <span class="workbench-diff-text">${escapeHtml(line.text)}</span>
        </div>
      `).join("")}
    </div>`;
  }

  function renderReview(model) {
    if (model.files.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noFiles"))}</div>`;
    }
    return `<section class="workbench-section">
      <div class="workbench-section-title">${escapeHtml(tr("workbench.filesChanged"))}</div>
      <div class="workbench-review-list">
        ${model.files.map((file) => `
          <article class="workbench-review-file">
            <div class="workbench-review-file-header">
              <div class="workbench-review-path" title="${escapeHtml(file.filePath)}">${escapeHtml(getShortPath(file.filePath))}</div>
              <div class="workbench-review-kind">${escapeHtml(getChangeLabel(file.changeType))}</div>
            </div>
            <div class="workbench-review-stats">
              ${file.source ? `<span>${escapeHtml(file.source)}</span>` : ""}
              <span class="workbench-review-add">+${file.added || 0}</span>
              <span class="workbench-review-del">-${file.removed || 0}</span>
            </div>
            ${renderDiffPreview(file)}
          </article>
        `).join("")}
      </div>
    </section>`;
  }

  function render() {
    if (!dom.body) return;
    syncButtonVisibility();
    syncTabs();
    if (!state.sessionId) {
      dom.body.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.empty"))}</div>`;
      return;
    }
    if (state.loading && state.events.length === 0) {
      dom.body.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.loading"))}</div>`;
      return;
    }
    if (state.error && state.events.length === 0) {
      dom.body.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.error"))}</div>`;
      return;
    }
    const model = buildInspectorModel();
    dom.body.innerHTML = state.activeTab === "review"
      ? renderReview(model)
      : renderSummary(model);
  }

  function syncTabs() {
    for (const tab of dom.tabs) {
      const active = tab.dataset.inspectorTab === state.activeTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function syncButtonVisibility() {
    const hasSession = !!state.sessionId || (typeof currentSessionId !== "undefined" && !!currentSessionId);
    if (dom.button) {
      dom.button.hidden = !hasSession;
    }
    if (!hasSession) {
      setOpen(false, { persist: false });
    }
  }

  function setOpen(open, { persist = true } = {}) {
    document.body.classList.toggle("workbench-inspector-open", open);
    document.body.classList.toggle("workbench-inspector-collapsed", !open);
    if (dom.button) {
      dom.button.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (persist) writeStoredOpen(open);
    if (typeof syncMobileDisclosureState === "function") {
      syncMobileDisclosureState();
    }
  }

  function toggleOpen() {
    const isOpen = document.body.classList.contains("workbench-inspector-open")
      && !document.body.classList.contains("workbench-inspector-collapsed");
    setOpen(!isOpen);
  }

  async function fetchAllSessionEvents(sessionId, { forceFresh = false } = {}) {
    if (!sessionId) return [];
    if (typeof isShareSnapshotReadOnlyMode === "function" && isShareSnapshotReadOnlyMode()) {
      return typeof getShareSnapshotDisplayEvents === "function"
        ? getShareSnapshotDisplayEvents()
        : [];
    }
    const data = await fetchJsonOrRedirect(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?filter=all`,
      forceFresh ? { revalidate: false, cache: "no-store" } : {},
    );
    return normalizeEvents(data?.events || []);
  }

  function scheduleRefresh(sessionId, { forceFresh = false, delay = 160 } = {}) {
    const liveSessionId = typeof currentSessionId !== "undefined" ? currentSessionId : "";
    if (!sessionId) sessionId = liveSessionId;
    const targetSessionId = sessionId || state.sessionId || "";
    if (!targetSessionId) {
      state.sessionId = "";
      state.session = null;
      state.events = [];
      render();
      return;
    }
    state.sessionId = targetSessionId;
    if (!state.session || state.session.id !== targetSessionId) {
      state.session = getCurrentSessionSafe();
    }
    state.loading = true;
    state.error = "";
    render();
    if (state.fetchTimer) clearTimeout(state.fetchTimer);
    state.fetchTimer = setTimeout(() => {
      state.fetchTimer = null;
      const requestSeq = state.requestSeq + 1;
      state.requestSeq = requestSeq;
      fetchAllSessionEvents(targetSessionId, { forceFresh })
        .then((events) => {
          if (state.requestSeq !== requestSeq || state.sessionId !== targetSessionId) return;
          state.events = events;
          state.loading = false;
          state.error = "";
          render();
        })
        .catch((error) => {
          if (state.requestSeq !== requestSeq || state.sessionId !== targetSessionId) return;
          state.loading = false;
          state.error = error?.message || "failed";
          render();
        });
    }, delay);
  }

  function applyEventDelta(sessionId, events) {
    if (!sessionId || sessionId !== state.sessionId) return;
    state.events = mergeEvents(state.events, events);
    state.loading = false;
    render();
  }

  function syncSession(session) {
    const nextSession = session || getCurrentSessionSafe();
    state.session = nextSession || null;
    const liveSessionId = typeof currentSessionId !== "undefined" ? currentSessionId : "";
    state.sessionId = nextSession?.id || liveSessionId || "";
    if (!state.sessionId) {
      state.events = [];
      render();
      return;
    }
    if (!hasStoredOpenPreference() && root.matchMedia?.(DESKTOP_QUERY)?.matches === true) {
      setOpen(true, { persist: false });
    }
    render();
    scheduleRefresh(state.sessionId);
  }

  function init() {
    dom.button = document.getElementById("workbenchInspectorBtn");
    dom.closeButton = document.getElementById("workbenchInspectorCloseBtn");
    dom.panel = document.getElementById("workbenchInspector");
    dom.body = document.getElementById("workbenchInspectorBody");
    dom.tabs = Array.from(document.querySelectorAll("[data-inspector-tab]"));
    if (!dom.panel || !dom.body) return;

    setOpen(readStoredOpen(), { persist: false });
    dom.button?.addEventListener("click", toggleOpen);
    dom.closeButton?.addEventListener("click", () => setOpen(false));
    for (const tab of dom.tabs) {
      tab.addEventListener("click", () => {
        const nextTab = tab.dataset.inspectorTab === "review" ? "review" : "summary";
        state.activeTab = nextTab;
        writeStoredTab(nextTab);
        render();
      });
    }
    root.matchMedia?.(DESKTOP_QUERY)?.addEventListener?.("change", () => {
      if (!localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY)) {
        setOpen(readStoredOpen(), { persist: false });
      }
    });
    syncSession(getCurrentSessionSafe());
    render();
  }

  root.syncWorkbenchInspectorSession = syncSession;
  root.scheduleWorkbenchInspectorRefresh = scheduleRefresh;
  root.applyWorkbenchInspectorEventDelta = applyEventDelta;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(window);
