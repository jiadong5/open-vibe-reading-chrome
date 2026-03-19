const MAX_PAGE_TEXT_LENGTH = 120000;
const HIGHLIGHT_CLASS = "ovr-annotation-highlight";
const NOTE_POPUP_ID = "ovr-note-popup";
const HOVER_TOOLTIP_ID = "ovr-hover-tooltip";
const ARXIV_SIDEBAR_ID = "ovr-arxiv-sidebar";
const ARXIV_INFO_POPUP_ID = "ovr-arxiv-info-popup";
const ARXIV_INFO_POPUP_CLASS = "ovr-arxiv-info-popup";
const ARXIV_STATUS_TOAST_ID = "ovr-status-toast";
const RETURN_TO_NOTE_BTN_ID = "ovr-return-to-note-btn";
const RETURN_TO_NOTE_BAR_ID = "ovr-return-to-note-bar";
const RETURN_TO_NOTE_HIDE_BTN_ID = "ovr-return-to-note-hide-btn";
const ARXIV_SUMMARY_CACHE_VERSION = "v8_formula_section_context_no_fallback";
const ARXIV_SIDEBAR_COLLAPSED_KEY = "ovr_arxiv_sidebar_collapsed_v1";
const OVR_SIDEBAR_POS_PREFIX = "ovr_sidebar_pos_v1::";

let lastSelectionText = "";
let pendingSelectionText = "";
let pendingPopupPos = { x: 0, y: 0 };
let pendingSelectionRange = null;
let selectionPopupTimer = null;
const sectionSummaryInFlight = new Map();
const formulaSummaryInFlight = new Map();
const sectionSummaryPopupMap = new Map();
const formulaSummaryPopupMap = new Map();
let runtimeContextInvalid = false;

function summaryErrorKey(prefix, idx) {
  return `err_${prefix}_${idx}`;
}

function currentUrlKey() {
  const url = new URL(window.location.href);
  url.hash = "";
  return `annotations::${url.toString()}`;
}

function arxivSummaryKey() {
  const url = new URL(window.location.href);
  url.hash = "";
  return `arxiv_summaries::${ARXIV_SUMMARY_CACHE_VERSION}::${url.toString()}`;
}

function getBaseUrl(url) {
  return (url || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function getCompletionEndpoints(baseUrl) {
  const cleaned = getBaseUrl(baseUrl);
  if (cleaned.endsWith("/chat/completions")) return [{ mode: "chat", url: cleaned }];
  if (cleaned.endsWith("/responses")) return [{ mode: "responses", url: cleaned }];
  return [
    { mode: "responses", url: `${cleaned}/responses` },
    { mode: "chat", url: `${cleaned}/chat/completions` }
  ];
}

async function getOpenAIConfig() {
  const data = await chrome.storage.local.get("openai_config");
  const cfg = data.openai_config || {};
  const modelName = cfg.model || "gpt-4o-mini";
  return {
    apiKey: cfg.apiKey || "",
    baseUrl: cfg.baseUrl || "https://api.openai.com/v1",
    model: modelName,
    summaryModel: cfg.summaryModel || modelName,
    chatbotName: cfg.chatbotName || "Assistant",
    sectionSummaryLength: Number(cfg.sectionSummaryLength) || 220,
    preloadSectionSummaries: cfg.preloadSectionSummaries === true,
    preloadFormulaExplanations: cfg.preloadFormulaExplanations !== false
  };
}

async function getAnnotations() {
  const key = currentUrlKey();
  const data = await chrome.storage.local.get(key);
  return Array.isArray(data[key]) ? data[key] : [];
}

async function saveAnnotations(annotations) {
  const key = currentUrlKey();
  await chrome.storage.local.set({ [key]: annotations });
}

async function getArxivSummaries() {
  const key = arxivSummaryKey();
  const data = await chrome.storage.local.get(key);
  return data[key] && typeof data[key] === "object" ? data[key] : {};
}

async function saveArxivSummaries(summaries) {
  const key = arxivSummaryKey();
  await chrome.storage.local.set({ [key]: summaries });
}

function getSelectionText() {
  return (window.getSelection()?.toString() || "").trim();
}

function updateLatestSelection() {
  const text = getSelectionText();
  if (text) lastSelectionText = text.slice(0, 4000);
}

function applyHighlightRange(range, item) {
  if (!range) return false;
  const span = document.createElement("span");
  span.className = HIGHLIGHT_CLASS;
  span.title = item.note ? `笔记: ${item.note}` : "网页标注";
  span.dataset.annotationId = item.id;
  span.dataset.annotationNote = item.note || "";
  span.dataset.annotationQuote = item.quote || "";

  try {
    range.surroundContents(span);
    return true;
  } catch (_) {
    try {
      const extracted = range.extractContents();
      span.appendChild(extracted);
      range.insertNode(span);
      return true;
    } catch (_) {
      return false;
    }
  }
}

async function addAnnotation(quote, noteText = "", sourceRange = null) {
  const selectedText = (quote || "").trim();
  if (!selectedText) return { ok: false, message: "请先选中网页文本" };

  const annotations = await getAnnotations();
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    quote: selectedText.slice(0, 1000),
    note: (noteText || "").trim(),
    createdAt: new Date().toISOString()
  };
  annotations.push(item);

  await saveAnnotations(annotations);
  if (!applyHighlightRange(sourceRange, item)) {
    await renderAnnotationHighlights();
  }
  return { ok: true, message: "标注已保存" };
}

function clearExistingHighlights() {
  const highlights = document.querySelectorAll(`span.${HIGHLIGHT_CLASS}`);
  highlights.forEach((node) => {
    const parent = node.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(node.textContent || ""), node);
    parent.normalize();
  });
}

function findTextNodeContainingQuote(quote) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.classList.contains(HIGHLIGHT_CLASS)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const lower = quote.toLowerCase();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue || "";
    const idx = text.toLowerCase().indexOf(lower);
    if (idx !== -1) return { node, start: idx, end: idx + quote.length };
  }

  return null;
}

async function renderAnnotationHighlights() {
  if (!document.body) return;

  clearExistingHighlights();
  const annotations = await getAnnotations();

  for (const item of annotations) {
    if (!item.quote || item.quote.length < 2) continue;
    const found = findTextNodeContainingQuote(item.quote);
    if (!found) continue;

    const range = document.createRange();
    range.setStart(found.node, found.start);
    range.setEnd(found.node, found.end);

    const span = document.createElement("span");
    span.className = HIGHLIGHT_CLASS;
    span.title = item.note ? `笔记: ${item.note}` : "网页标注";
    span.dataset.annotationId = item.id;
    span.dataset.annotationNote = item.note || "";
    span.dataset.annotationQuote = item.quote || "";

    try {
      range.surroundContents(span);
    } catch (_) {
      // Ignore invalid ranges.
    }
  }
}

function getHighlightByAnnotationId(id) {
  if (!id) return null;
  return document.querySelector(`span.${HIGHLIGHT_CLASS}[data-annotation-id="${CSS.escape(String(id))}"]`);
}

async function locateAnnotationById(id) {
  let span = getHighlightByAnnotationId(id);
  if (!(span instanceof HTMLElement)) {
    await renderAnnotationHighlights();
    span = getHighlightByAnnotationId(id);
  }
  if (!(span instanceof HTMLElement)) return { ok: false, error: "未找到对应标注高亮" };
  focusReferenceTarget(span);
  return { ok: true };
}

async function updateAnnotationNoteById(id, note) {
  const annotations = await getAnnotations();
  const idx = annotations.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: false, error: "未找到对应标注" };
  annotations[idx].note = String(note || "").trim();
  annotations[idx].updatedAt = new Date().toISOString();
  await saveAnnotations(annotations);
  const span = getHighlightByAnnotationId(id);
  if (span instanceof HTMLElement) {
    span.dataset.annotationNote = annotations[idx].note || "";
    span.title = annotations[idx].note ? `笔记: ${annotations[idx].note}` : "网页标注";
  }
  return { ok: true, data: { annotation: annotations[idx] } };
}

async function deleteAnnotationById(id) {
  const annotations = await getAnnotations();
  const next = annotations.filter((x) => x.id !== id);
  if (next.length === annotations.length) return { ok: false, error: "未找到对应标注" };
  await saveAnnotations(next);
  await renderAnnotationHighlights();
  return { ok: true };
}

async function clearAllAnnotations() {
  await saveAnnotations([]);
  await renderAnnotationHighlights();
  return { ok: true };
}

function injectStyle() {
  const id = "ovr-annotation-style";
  if (document.getElementById(id)) return;

  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background: rgba(255, 222, 89, 0.5);
      border-bottom: 1px dashed #d8a100;
      cursor: pointer;
    }

    #${NOTE_POPUP_ID} {
      position: absolute;
      z-index: 2147483647;
      display: none;
      width: 280px;
      min-width: 240px;
      min-height: 150px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #d8deea;
      background: #ffffff;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      color: #0f172a;
    }

    #${NOTE_POPUP_ID} .ovr-popup-title {
      margin: 0 0 6px;
      font-size: 12px;
      color: #334155;
    }

    #${NOTE_POPUP_ID} .ovr-popup-quote {
      margin: 0 0 8px;
      font-size: 12px;
      max-height: 58px;
      overflow: auto;
      color: #0f172a;
      background: #f8fbff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 6px;
    }

    #${NOTE_POPUP_ID} textarea {
      width: 100%;
      min-height: 64px;
      border: 1px solid #d8deea;
      border-radius: 6px;
      padding: 6px;
      resize: vertical;
      font-size: 12px;
      box-sizing: border-box;
      margin-bottom: 8px;
    }

    #${NOTE_POPUP_ID} .ovr-popup-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }

    #${NOTE_POPUP_ID} .ovr-popup-actions button {
      border: 0;
      border-radius: 6px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 12px;
    }

    #${NOTE_POPUP_ID} .ovr-cancel { background: #e2e8f0; color: #1e293b; }
    #${NOTE_POPUP_ID} .ovr-save { background: #1f6feb; color: #fff; }

    #${HOVER_TOOLTIP_ID} {
      position: fixed;
      z-index: 2147483647;
      display: none;
      max-width: 320px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid #d8deea;
      background: rgba(15, 23, 42, 0.96);
      color: #f8fafc;
      font-size: 12px;
      line-height: 1.4;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      pointer-events: none;
      white-space: pre-wrap;
    }

    #${ARXIV_SIDEBAR_ID} {
      position: fixed;
      left: 12px;
      top: 72px;
      width: 250px;
      max-height: calc(100vh - 84px);
      overflow: auto;
      z-index: 2147483000;
      background: rgba(15, 23, 42, 0.96);
      border: 1px solid #334155;
      border-radius: 12px;
      color: #e2e8f0;
      padding: 10px;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
      opacity: 0.92;
      transition: width 180ms ease, padding 180ms ease, opacity 140ms ease, box-shadow 140ms ease;
    }

    #${ARXIV_SIDEBAR_ID}:hover {
      opacity: 1;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.3);
    }

    #${ARXIV_SIDEBAR_ID}.collapsed {
      width: 46px;
      padding: 8px 6px;
    }

    #${ARXIV_SIDEBAR_ID} h3 {
      margin: 0 0 8px;
      font-size: 13px;
      color: #93c5fd;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-side-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin: 0 0 8px;
      cursor: move;
      user-select: none;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-side-head h3 {
      margin: 0;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-side-body {
      display: block;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-side-toggle {
      border: 1px solid #60a5fa;
      background: linear-gradient(180deg, #1d4ed8 0%, #1e3a8a 100%);
      color: #eff6ff;
      border-radius: 8px;
      width: 30px;
      height: 28px;
      line-height: 24px;
      padding: 0;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      flex: 0 0 auto;
      box-shadow: 0 4px 12px rgba(29, 78, 216, 0.35);
    }

    #${ARXIV_SIDEBAR_ID}.collapsed .ovr-side-body {
      display: none;
    }

    #${ARXIV_SIDEBAR_ID}.collapsed .ovr-side-head {
      justify-content: center;
      margin-bottom: 0;
    }

    #${ARXIV_SIDEBAR_ID}.collapsed .ovr-side-head h3 {
      display: none;
    }

    #${ARXIV_SIDEBAR_ID}.collapsed .ovr-side-toggle {
      width: 34px;
      margin: 0 auto;
      display: block;
    }

    #${ARXIV_SIDEBAR_ID}.dragging {
      opacity: 1;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.38);
    }

    @media (max-width: 1200px) {
      #${ARXIV_SIDEBAR_ID} {
        position: fixed;
        left: 8px;
        top: 64px;
        width: 100%;
        max-width: min(340px, calc(100vw - 16px));
        max-height: 58vh;
      }
    }

    #${ARXIV_SIDEBAR_ID} .ovr-outline {
      margin: 0 0 10px;
      padding: 0;
      list-style: none;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-outline li {
      margin: 0 0 6px;
      font-size: 12px;
      line-height: 1.35;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-outline a {
      color: #e2e8f0;
      text-decoration: none;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-outline a:hover { color: #93c5fd; }

    #${ARXIV_SIDEBAR_ID} .ovr-search {
      border-top: 1px solid #334155;
      padding-top: 10px;
    }

    #${ARXIV_SIDEBAR_ID} input {
      width: 100%;
      border-radius: 8px;
      border: 1px solid #334155;
      background: #0b1220;
      color: #e2e8f0;
      padding: 6px 8px;
      font-size: 12px;
      margin-bottom: 6px;
      box-sizing: border-box;
    }

    #${ARXIV_SIDEBAR_ID} .ovr-search-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    #${ARXIV_SIDEBAR_ID} button {
      border: 0;
      border-radius: 8px;
      background: #1d4ed8;
      color: #fff;
      padding: 6px 8px;
      font-size: 12px;
      cursor: pointer;
    }

    .ovr-formula-icon,
    .ovr-section-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 1px solid #93c5fd;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      user-select: none;
      margin-right: 6px;
      vertical-align: middle;
    }

    .ovr-formula-icon {
      border-color: #f59e0b;
      background: #fffbeb;
      color: #b45309;
      margin-left: 6px;
      margin-right: 0;
    }

    .ovr-section-icon {
      border-color: #10b981;
      background: #ecfdf5;
      color: #047857;
    }

    #${ARXIV_INFO_POPUP_ID},
    .${ARXIV_INFO_POPUP_CLASS} {
      position: absolute;
      z-index: 2147483647;
      display: none;
      width: min(380px, 70vw);
      max-height: min(60vh, 520px);
      overflow: auto;
      background: #ffffff;
      color: #0f172a;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.26);
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
    }

    #${ARXIV_INFO_POPUP_ID} .popup-head,
    .${ARXIV_INFO_POPUP_CLASS} .popup-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 6px;
      cursor: move;
      user-select: none;
    }

    #${ARXIV_INFO_POPUP_ID} .popup-head-right,
    .${ARXIV_INFO_POPUP_CLASS} .popup-head-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
    }

    #${ARXIV_INFO_POPUP_ID} .action-btn,
    .${ARXIV_INFO_POPUP_CLASS} .action-btn {
      border: 1px solid #93c5fd;
      background: #eff6ff;
      color: #1e3a8a;
      border-radius: 999px;
      height: 24px;
      line-height: 20px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      padding: 0 10px;
      flex: 0 0 auto;
    }

    #${ARXIV_INFO_POPUP_ID} .action-btn.danger,
    .${ARXIV_INFO_POPUP_CLASS} .action-btn.danger {
      border-color: #ef4444;
      background: #fee2e2;
      color: #b91c1c;
    }

    .ovr-action-popover {
      position: fixed;
      z-index: 2147483647;
      min-width: 260px;
      min-height: 120px;
      max-width: min(420px, 80vw);
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #0f172a;
      border-radius: 10px;
      box-shadow: 0 14px 30px rgba(15, 23, 42, 0.28);
      padding: 10px;
      font-size: 12px;
    }

    .ovr-action-popover.editor-large {
      left: 50% !important;
      top: 50% !important;
      transform: translate(-50%, -50%);
      width: min(860px, 92vw);
      min-width: min(560px, 92vw);
      min-height: min(280px, 78vh);
      max-width: min(860px, 92vw);
      max-height: 80vh;
      overflow: auto;
    }

    .ovr-action-popover .title {
      font-weight: 700;
      color: #1e3a8a;
      margin: 0 0 8px;
    }

    .ovr-action-popover textarea {
      width: 100%;
      min-height: 90px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 8px;
      resize: vertical;
      font-size: 12px;
      color: #0f172a;
      background: #f8fbff;
      box-sizing: border-box;
      margin-bottom: 8px;
    }

    .ovr-action-popover.editor-large textarea {
      min-height: min(48vh, 420px);
      font-size: 13px;
      line-height: 1.45;
    }

    .ovr-action-popover .row {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .ovr-action-popover .row button {
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 6px 10px;
      background: #f8fafc;
      color: #334155;
      cursor: pointer;
      font-size: 12px;
      width: auto !important;
      min-width: 68px;
      flex: 0 0 auto;
    }

    .ovr-action-popover .row .primary {
      border-color: #2563eb;
      background: #2563eb;
      color: #fff;
    }

    .ovr-action-popover .row .danger {
      border-color: #dc2626;
      background: #dc2626;
      color: #fff;
    }

    #${ARXIV_INFO_POPUP_ID} .jump-btn,
    .${ARXIV_INFO_POPUP_CLASS} .jump-btn {
      border: 1px solid #cbd5e1;
      background: #eff6ff;
      color: #1d4ed8;
      border-radius: 6px;
      height: 22px;
      line-height: 18px;
      font-size: 11px;
      cursor: pointer;
      padding: 0 8px;
      flex: 0 0 auto;
    }

    #${ARXIV_INFO_POPUP_ID} .close-btn,
    .${ARXIV_INFO_POPUP_CLASS} .close-btn {
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      color: #475569;
      border-radius: 6px;
      width: 22px;
      height: 22px;
      line-height: 18px;
      font-size: 14px;
      cursor: pointer;
      padding: 0;
      flex: 0 0 auto;
    }

    #${ARXIV_INFO_POPUP_ID} .title,
    .${ARXIV_INFO_POPUP_CLASS} .title {
      font-weight: 700;
      color: #1e3a8a;
    }

    .ovr-ref-focus {
      outline: 2px solid #60a5fa !important;
      outline-offset: 3px;
      border-radius: 6px;
      transition: outline-color 180ms ease;
    }

    .ovr-locate-btn {
      margin-left: 6px;
      border: 1px solid #93c5fd;
      background: #eff6ff;
      color: #1d4ed8;
      border-radius: 999px;
      font-size: 11px;
      line-height: 1.2;
      padding: 1px 7px;
      cursor: pointer;
      vertical-align: baseline;
    }

    #${ARXIV_INFO_POPUP_ID} .body,
    .${ARXIV_INFO_POPUP_CLASS} .body {
      color: #334155;
    }

    #${ARXIV_INFO_POPUP_ID} .md p,
    .${ARXIV_INFO_POPUP_CLASS} .md p {
      margin: 0 0 8px;
    }

    #${ARXIV_INFO_POPUP_ID} .md hr,
    .${ARXIV_INFO_POPUP_CLASS} .md hr {
      border: 0;
      border-top: 1px solid #cbd5e1;
      margin: 10px 0;
    }

    #${ARXIV_INFO_POPUP_ID} .md blockquote,
    .${ARXIV_INFO_POPUP_CLASS} .md blockquote {
      margin: 0 0 8px;
      padding: 6px 10px;
      border-left: 3px solid #3b82f6;
      background: #eff6ff;
      color: #1e3a8a;
    }

    #${ARXIV_INFO_POPUP_ID} .md ul,
    .${ARXIV_INFO_POPUP_CLASS} .md ul {
      margin: 0 0 8px 16px;
      padding: 0;
    }

    #${ARXIV_INFO_POPUP_ID} .md li,
    .${ARXIV_INFO_POPUP_CLASS} .md li {
      margin: 0 0 4px;
    }

    #${ARXIV_INFO_POPUP_ID} .md code,
    .${ARXIV_INFO_POPUP_CLASS} .md code {
      background: #eff6ff;
      border: 1px solid #dbeafe;
      border-radius: 5px;
      padding: 0 4px;
      font-size: 11px;
    }

    #${ARXIV_INFO_POPUP_ID} .md pre,
    .${ARXIV_INFO_POPUP_CLASS} .md pre {
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 8px;
      padding: 8px;
      overflow: auto;
      margin: 0 0 8px;
    }

    #${ARXIV_INFO_POPUP_ID} .math-inline,
    .${ARXIV_INFO_POPUP_CLASS} .math-inline {
      color: #7c2d12;
      font-family: "Times New Roman", Georgia, serif;
    }

    #${ARXIV_INFO_POPUP_ID} .math-block,
    .${ARXIV_INFO_POPUP_CLASS} .math-block {
      border: 1px dashed #93c5fd;
      border-radius: 8px;
      padding: 8px;
      background: #f8fbff;
      margin: 0 0 8px;
      overflow-x: auto;
    }

    #${ARXIV_INFO_POPUP_ID} .frac,
    .${ARXIV_INFO_POPUP_CLASS} .frac {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      vertical-align: middle;
      margin: 0 2px;
    }

    #${ARXIV_INFO_POPUP_ID} .frac .num,
    .${ARXIV_INFO_POPUP_CLASS} .frac .num {
      border-bottom: 1px solid currentColor;
      line-height: 1.1;
      padding: 0 2px;
    }

    #${ARXIV_INFO_POPUP_ID} .frac .den,
    .${ARXIV_INFO_POPUP_CLASS} .frac .den {
      line-height: 1.1;
      padding: 0 2px;
    }

    #${ARXIV_INFO_POPUP_ID} .table-wrap,
    .${ARXIV_INFO_POPUP_CLASS} .table-wrap {
      margin: 0 0 8px;
      overflow-x: auto;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
    }

    #${ARXIV_INFO_POPUP_ID} table,
    .${ARXIV_INFO_POPUP_CLASS} table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    #${ARXIV_INFO_POPUP_ID} th,
    #${ARXIV_INFO_POPUP_ID} td,
    .${ARXIV_INFO_POPUP_CLASS} th,
    .${ARXIV_INFO_POPUP_CLASS} td {
      border-bottom: 1px solid #e2e8f0;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }

    #${ARXIV_INFO_POPUP_ID} th,
    .${ARXIV_INFO_POPUP_CLASS} th {
      background: #f8fbff;
      color: #1e3a8a;
      font-weight: 600;
    }

    #${ARXIV_STATUS_TOAST_ID} {
      position: fixed;
      right: 16px;
      bottom: 18px;
      z-index: 2147483647;
      min-width: 260px;
      max-width: min(440px, 74vw);
      display: none;
      background: rgba(15, 23, 42, 0.96);
      border: 1px solid #334155;
      color: #e2e8f0;
      border-radius: 10px;
      padding: 10px 12px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
    }

    #${ARXIV_STATUS_TOAST_ID}.done {
      border-color: #16a34a;
      color: #dcfce7;
      background: rgba(20, 83, 45, 0.94);
    }

    .ovr-scholar-link {
      margin-left: 8px;
      font-size: 12px;
      color: #1d4ed8;
      text-decoration: none;
    }

    #${ARXIV_INFO_POPUP_ID} .ovr-inline-anchor,
    .${ARXIV_INFO_POPUP_CLASS} .ovr-inline-anchor {
      color: #1d4ed8;
      text-decoration: underline;
      text-underline-offset: 2px;
      cursor: pointer;
    }
  `;

  document.head.appendChild(style);
}

function createNotePopup() {
  let popup = document.getElementById(NOTE_POPUP_ID);
  if (popup) return popup;

  popup = document.createElement("div");
  popup.id = NOTE_POPUP_ID;
  popup.innerHTML = `
    <p class="ovr-popup-title">为选中文本添加笔记</p>
    <div class="ovr-popup-quote" id="ovr-popup-quote"></div>
    <textarea id="ovr-popup-note" placeholder="输入你的标注笔记"></textarea>
    <div class="ovr-popup-actions">
      <button class="ovr-cancel" id="ovr-popup-cancel">取消</button>
      <button class="ovr-save" id="ovr-popup-save">保存</button>
    </div>
  `;
  document.body.appendChild(popup);

  popup.querySelector("#ovr-popup-cancel").addEventListener("click", () => {
    hideNotePopup();
  });

  popup.querySelector("#ovr-popup-save").addEventListener("click", async () => {
    const noteInput = popup.querySelector("#ovr-popup-note");
    const note = noteInput.value;
    const result = await addAnnotation(pendingSelectionText, note, pendingSelectionRange);
    hideNotePopup();
    if (!result.ok) window.alert(result.message);
  });

  return popup;
}

function showNotePopup(selectionText, x, y) {
  const popup = createNotePopup();
  const quoteEl = popup.querySelector("#ovr-popup-quote");
  const noteEl = popup.querySelector("#ovr-popup-note");

  pendingSelectionText = selectionText;
  quoteEl.textContent = selectionText.slice(0, 240);
  noteEl.value = "";

  popup.style.left = `${Math.max(window.scrollX + 8, x - 40)}px`;
  popup.style.top = `${Math.max(window.scrollY + 8, y + 12)}px`;
  popup.style.display = "block";
}

function hideNotePopup() {
  const popup = document.getElementById(NOTE_POPUP_ID);
  if (popup) popup.style.display = "none";
  pendingSelectionText = "";
  pendingSelectionRange = null;
}

function createHoverTooltip() {
  let tip = document.getElementById(HOVER_TOOLTIP_ID);
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = HOVER_TOOLTIP_ID;
  document.body.appendChild(tip);
  return tip;
}

function showHoverTooltip(text, clientX, clientY) {
  const tip = createHoverTooltip();
  tip.textContent = text || "";
  tip.style.display = "block";

  const maxLeft = window.innerWidth - tip.offsetWidth - 12;
  const maxTop = window.innerHeight - tip.offsetHeight - 12;
  const left = Math.min(Math.max(8, clientX + 16), Math.max(8, maxLeft));
  const top = Math.min(Math.max(8, clientY + 18), Math.max(8, maxTop));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideHoverTooltip() {
  const tip = document.getElementById(HOVER_TOOLTIP_ID);
  if (tip) tip.style.display = "none";
}

function installAnnotationHoverPreview() {
  // Hover preview disabled by product decision: keep only click-to-open details.
  hideHoverTooltip();
  const oldTip = document.getElementById(HOVER_TOOLTIP_ID);
  if (oldTip?.parentElement) oldTip.parentElement.removeChild(oldTip);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const span = target.closest(`span.${HIGHLIGHT_CLASS}`);
    if (!(span instanceof HTMLElement)) return;
    // Keep annotation details as a single popup to avoid repeated stacked windows.
    document.querySelectorAll(`.${ARXIV_INFO_POPUP_CLASS}`).forEach((el) => el.remove());
    const annotationId = String(span.dataset.annotationId || "");
    const quote = span.dataset.annotationQuote || span.textContent || "";
    const buildBody = () => {
      const noteNow = span.dataset.annotationNote || "";
      return `**原文**\n${quote || "(无)"}\n\n**笔记**\n${noteNow || "(无笔记)"}`;
    };
    showArxivInfoPopup("标注详情", buildBody(), event.clientX, event.clientY, {
      jumpTarget: span,
      jumpText: "定位标注",
      actions: [
        { id: "edit-note", label: "修改笔记" },
        { id: "delete-annotation", label: "删除标注", kind: "danger" }
      ],
      onAction: async (actionId, popup, actionBtn) => {
        if (!(popup instanceof HTMLElement)) return;
        if (!annotationId) throw new Error("标注ID缺失");
        const anchorBtn = actionBtn instanceof HTMLElement ? actionBtn : popup;
        if (actionId === "edit-note") {
          const oldNote = span.dataset.annotationNote || "";
          showNoteEditorPopover(anchorBtn, oldNote, async (next) => {
            const res = await updateAnnotationNoteById(annotationId, next);
            if (!res.ok) throw new Error(res.error || "修改失败");
            span.dataset.annotationNote = String(res.data?.annotation?.note || "");
            span.title = span.dataset.annotationNote ? `笔记: ${span.dataset.annotationNote}` : "网页标注";
            const bodyEl = popup.querySelector(".body");
            if (bodyEl instanceof HTMLElement) bodyEl.innerHTML = renderPopupMarkdown(buildBody());
            showStatusToast("标注已更新", true, 1200);
          });
          return;
        }
        if (actionId === "delete-annotation") {
          showDeleteConfirmPopover(anchorBtn, async () => {
            const res = await deleteAnnotationById(annotationId);
            if (!res.ok) throw new Error(res.error || "删除失败");
            if (popup.id === ARXIV_INFO_POPUP_ID) popup.style.display = "none";
            else if (popup.parentElement) popup.parentElement.removeChild(popup);
            showStatusToast("标注已删除", true, 1200);
          });
        }
      }
    });
  });
}

function installSelectionNotePopup() {
  document.addEventListener("selectionchange", updateLatestSelection);

  document.addEventListener("mouseup", (event) => {
    updateLatestSelection();
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!selection || !text || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const anchorEl = selection.anchorNode?.parentElement;
    if (anchorEl && anchorEl.closest(`#${NOTE_POPUP_ID}`)) return;

    pendingPopupPos = { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY };
    pendingSelectionRange = range.cloneRange();

    if (selectionPopupTimer) clearTimeout(selectionPopupTimer);
    selectionPopupTimer = setTimeout(() => {
      const latest = getSelectionText() || lastSelectionText;
      if (!latest || latest.length < 2) return;
      showNotePopup(latest, pendingPopupPos.x, pendingPopupPos.y);
    }, 220);
  });

  document.addEventListener("mousedown", (event) => {
    const popup = document.getElementById(NOTE_POPUP_ID);
    if (popup && popup.contains(event.target)) return;
    setTimeout(hideNotePopup, 0);
  });
}

function createArxivInfoPopup(options = {}) {
  const multi = !!options.multi;
  if (multi) {
    const popup = document.createElement("div");
    popup.className = ARXIV_INFO_POPUP_CLASS;
    document.body.appendChild(popup);
    return popup;
  }

  let popup = document.getElementById(ARXIV_INFO_POPUP_ID);
  if (popup) return popup;

  popup = document.createElement("div");
  popup.id = ARXIV_INFO_POPUP_ID;
  document.body.appendChild(popup);

  document.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (popup.contains(event.target)) return;
    if (event.target.closest(".ovr-formula-icon")) return;
    if (event.target.closest(".ovr-action-popover")) return;
    popup.style.display = "none";
    hideActionPopover();
  });

  return popup;
}

function makeArxivInfoPopupDraggable(popup) {
  if (!(popup instanceof HTMLElement)) return;
  if (popup.dataset.dragEnabled === "1") return;
  popup.dataset.dragEnabled = "1";
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

  const onMove = (event) => {
    if (!dragging) return;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = popup.getBoundingClientRect();
    const nextLeft = clamp(event.clientX + scrollX - offsetX, scrollX + 8, scrollX + Math.max(8, vw - rect.width - 8));
    const nextTop = clamp(event.clientY + scrollY - offsetY, scrollY + 8, scrollY + Math.max(8, vh - rect.height - 8));
    popup.style.left = `${Math.round(nextLeft)}px`;
    popup.style.top = `${Math.round(nextTop)}px`;
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    popup.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
  };

  popup.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const head = target.closest(".popup-head");
    if (!(head instanceof HTMLElement)) return;
    if (!popup.contains(head)) return;
    if (target.closest("button, a, input, textarea, select, .popup-head-right")) return;
    dragging = true;
    popup.classList.add("dragging");
    const rect = popup.getBoundingClientRect();
    offsetX = event.clientX + window.scrollX - (rect.left + window.scrollX);
    offsetY = event.clientY + window.scrollY - (rect.top + window.scrollY);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    event.preventDefault();
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeMathDelimiters(text) {
  let s = String(text || "");
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, g1) => `\n$$\n${g1}\n$$\n`);
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, g1) => `\n$$\n${g1}\n$$\n`);
  s = s.replace(/\\\((.+?)\\\)/g, (_, g1) => `$${g1}$`);
  return s;
}

function latexToHtml(input, displayMode = false) {
  const expr = String(input || "").trim();
  if (!expr) return "";
  if (window.katex?.renderToString) {
    try {
      return window.katex.renderToString(expr, {
        throwOnError: false,
        displayMode,
        output: "mathml"
      });
    } catch (_) {
      // Fallback below
    }
  }
  let s = escapeHtml(expr);
  s = s.replace(/\\+left/g, "").replace(/\\+right/g, "");
  s = s.replace(/\\+,/g, " ").replace(/\\+!/g, "");
  s = s.replace(/\\+;/g, " ");
  s = s.replace(/\\+\[/g, "").replace(/\\+\]/g, "");
  s = s.replace(/\\+\(/g, "").replace(/\\+\)/g, "");
  s = s.replace(/\\+begin\{aligned\}/g, "").replace(/\\+end\{aligned\}/g, "");
  s = s.replace(/\\+begin\{cases\}/g, "").replace(/\\+end\{cases\}/g, "");
  s = s.replace(/&amp;/g, " ");

  for (let i = 0; i < 4; i += 1) {
    s = s.replace(/\\+text\{([^{}]+)\}/g, "$1");
    s = s.replace(/\\+mathrm\{([^{}]+)\}/g, "$1");
    s = s.replace(/\\+operatorname\{([^{}]+)\}/g, "$1");
    s = s.replace(/\\+(?:mathcal|mathbb|mathbf|boldsymbol|bm|mathsf|mathtt)\{([^{}]+)\}/g, "$1");
    s = s.replace(/\\+sqrt\{([^{}]+)\}/g, "√($1)");
  }
  s = s.replace(/\\+\{/g, "{").replace(/\\+\}/g, "}");

  const symbolMap = {
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    theta: "θ",
    epsilon: "ϵ",
    varepsilon: "ε",
    lambda: "λ",
    mu: "μ",
    sigma: "σ",
    pi: "π",
    omega: "ω",
    Delta: "Δ",
    Sigma: "Σ",
    Pi: "Π",
    sum: "∑",
    int: "∫",
    infty: "∞",
    cdot: "·",
    times: "×",
    in: "∈",
    leq: "≤",
    geq: "≥",
    neq: "≠",
    approx: "≈"
  };
  for (const [cmd, v] of Object.entries(symbolMap)) {
    s = s.replace(new RegExp(`\\\\+${cmd}\\b`, "g"), v);
  }

  for (let i = 0; i < 4; i += 1) {
    s = s.replace(/\\+frac\{([^{}]+)\}\{([^{}]+)\}/g, (_, num, den) => {
      const numHtml = latexToHtml(num);
      const denHtml = latexToHtml(den);
      return `<span class="frac"><span class="num">${numHtml}</span><span class="den">${denHtml}</span></span>`;
    });
  }

  s = s.replace(/\\\\(?![A-Za-z])/g, "<br/>");
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]}>])\^\{([^{}]+)\}/g, (_, base, exp) => `${base}<sup>${exp}</sup>`);
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]}>])\^([A-Za-z0-9\u0370-\u03FF])/g, (_, base, exp) => `${base}<sup>${exp}</sup>`);
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]}>])_\{([^{}]+)\}/g, (_, base, sub) => `${base}<sub>${sub}</sub>`);
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]}>])_([A-Za-z0-9\u0370-\u03FF])/g, (_, base, sub) => `${base}<sub>${sub}</sub>`);
  return s;
}

function renderInlineMarkdown(text) {
  const mathTokens = [];
  const tokenLeft = "\uE000";
  const tokenRight = "\uE001";
  const mkToken = (idx) => `${tokenLeft}${idx}${tokenRight}`;
  const normalizeLegacyMathKey = (rawKey) =>
    String(rawKey || "")
      .trim()
      .replace(/^[_\-\s]+/, "")
      .replace(/^h(\d+)$/i, "h_$1")
      .replace(/^x(\d+)$/i, "x_$1")
      .replace(/^p(\d+)$/i, "p_$1")
      .replace(/\s+/g, "");

  let raw = String(text || "");
  // Convert legacy leaked placeholders into private tokens first to avoid collision with plain text.
  raw = raw.replace(/@@MATH([^@]*)@@/g, (_, rawKey) => {
    const idx = mathTokens.length;
    const key = String(rawKey || "").trim();
    const m = key.match(/(\d+)/);
    if (m) {
      const n = Number(m[1]);
      const candidate = Number.isFinite(n) ? extractMathCandidates(text)[n] : "";
      if (candidate) {
        mathTokens.push(`<span class="math-inline">${latexToHtml(candidate)}</span>`);
        return mkToken(idx);
      }
    }
    const normalized = normalizeLegacyMathKey(key);
    mathTokens.push(`<span class="math-inline">${latexToHtml(normalized || "公式")}</span>`);
    return mkToken(idx);
  });

  raw = raw.replace(/\$([^$\n]+)\$/g, (_, g1) => {
    const idx = mathTokens.length;
    mathTokens.push(`<span class="math-inline">${latexToHtml(g1)}</span>`);
    return mkToken(idx);
  });
  raw = raw.replace(/(\\[A-Za-z]+(?:\{[^{}]*\})*(?:[_^](?:\{[^{}]*\}|[A-Za-z0-9\u0370-\u03FF]))*)/g, (_, g1) => {
    const idx = mathTokens.length;
    mathTokens.push(`<span class="math-inline">${latexToHtml(g1)}</span>`);
    return mkToken(idx);
  });
  raw = raw.replace(/(\\\{[^{}]*\\\})/g, (_, g1) => {
    const idx = mathTokens.length;
    mathTokens.push(`<span class="math-inline">${latexToHtml(g1)}</span>`);
    return mkToken(idx);
  });

  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Lightweight fallback for common math-like inline tokens not wrapped by $...$.
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]])\^\{([^{}]+)\}/g, (_, base, exp) => `${base}<sup>${exp}</sup>`);
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]])\^([A-Za-z0-9\u0370-\u03FF])/g, (_, base, exp) => `${base}<sup>${exp}</sup>`);
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]])_\{([^{}]+)\}/g, (_, base, sub) => `${base}<sub>${sub}</sub>`);
  s = s.replace(/([A-Za-z0-9\u0370-\u03FF)\]])_([A-Za-z0-9\u0370-\u03FF])/g, (_, base, sub) => `${base}<sub>${sub}</sub>`);
  const tokenMatcher = new RegExp(`${tokenLeft}(\\d+)${tokenRight}`, "g");
  s = s.replace(tokenMatcher, (_, n) => mathTokens[Number(n)] || `<span class="math-inline">（公式）</span>`);
  return s;
}

function extractMathCandidates(sourceText) {
  const src = String(sourceText || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const list = [];
  const seen = new Set();
  const push = (x) => {
    const v = String(x || "").trim();
    if (!v || v.length < 2 || v.length > 120) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(v);
  };

  // Equation-like snippets with operators.
  for (const m of src.matchAll(/[A-Za-z0-9\u0370-\u03FF\\][^。；\n]{0,70}(?:=|≤|≥|<|>|≈|∈|\\in|\\times|\\cdot)[^。；\n]{1,70}/g)) {
    push(m[0]);
  }
  // Inline symbolic tokens such as x^θ, p_t, \ell_{vel}, v_\theta, etc.
  for (const m of src.matchAll(/(?:\\?[A-Za-z]+(?:_\{[^{}]+\}|_[A-Za-z0-9\u0370-\u03FF]+)?(?:\^\{[^{}]+\}|\^[A-Za-z0-9\u0370-\u03FF]+)?|[A-Za-z][A-Za-z0-9]*[\^_][A-Za-z0-9\u0370-\u03FF]+)/g)) {
    push(m[0]);
  }
  return list.slice(0, 24);
}

function cleanMathPlaceholders(text, sourceText = "") {
  const candidates = extractMathCandidates(sourceText);
  return String(text || "")
    .replace(/@@MATH([^@]*)@@/g, (_, rawKey) => {
      const key = String(rawKey || "").trim();
      const m = key.match(/(\d+)/);
      const idx = m ? Number(m[1]) : NaN;
      if (Number.isFinite(idx) && candidates[idx]) return `$${candidates[idx]}$`;
      if (candidates.length) return `$${candidates[0]}$`;
      const normalized = key
        .replace(/^[_\-\s]+/, "")
        .replace(/^h(\d+)$/i, "h_$1")
        .replace(/^x(\d+)$/i, "x_$1")
        .replace(/^p(\d+)$/i, "p_$1")
        .replace(/\s+/g, "");
      if (normalized) return `$${normalized}$`;
      return "（公式）";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseMarkdownTableRow(line) {
  const s = String(line || "").trim();
  if (!s.includes("|")) return null;
  const raw = s.replace(/^\|/, "").replace(/\|$/, "");
  const cells = raw.split("|").map((x) => x.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableDivider(line, columns) {
  const cells = parseMarkdownTableRow(line);
  if (!cells || cells.length < 2) return false;
  if (Number.isFinite(columns) && columns > 0 && cells.length !== columns) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function renderPopupMarkdown(text) {
  const source = normalizeMathDelimiters(String(text || "").replace(/\r\n/g, "\n"));
  const lines = source.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      i += 1;
      const codeLines = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(`<pre><code class="language-${escapeHtml(lang || "plain")}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\$\$$/.test(line.trim())) {
      i += 1;
      const mathLines = [];
      while (i < lines.length && !/^\$\$$/.test(lines[i].trim())) {
        mathLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(`<div class="math-block">${latexToHtml(mathLines.join("\n"), true)}</div>`);
      continue;
    }

    if (/^#{1,4}\s+/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const content = line.replace(/^#{1,4}\s+/, "");
      blocks.push(`<h${level}>${renderInlineMarkdown(content)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line.trim())) {
      blocks.push("<hr/>");
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${renderPopupMarkdown(quoteLines.join("\n")).replace(/^<div class="md">|<\/div>$/g, "")}</blockquote>`);
      continue;
    }

    const tableHead = parseMarkdownTableRow(line);
    if (tableHead && i + 1 < lines.length && isMarkdownTableDivider(lines[i + 1], tableHead.length)) {
      i += 2;
      const bodyRows = [];
      while (i < lines.length) {
        const row = parseMarkdownTableRow(lines[i]);
        if (!row || row.length !== tableHead.length) break;
        bodyRows.push(row);
        i += 1;
      }
      const thead = `<thead><tr>${tableHead.map((c) => `<th>${renderInlineMarkdown(c)}</th>`).join("")}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows
            .map((r) => `<tr>${r.map((c) => `<td>${renderInlineMarkdown(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody>`
        : "";
      blocks.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(`<ul>${items.map((x) => `<li>${renderInlineMarkdown(x)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push(`<ol>${items.map((x) => `<li>${renderInlineMarkdown(x)}</li>`).join("")}</ol>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }
    const pLines = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\$\$$/.test(lines[i].trim())) {
      if (/^#{1,4}\s+/.test(lines[i]) || /^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i])) {
        break;
      }
      pLines.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(pLines.join(" "))}</p>`);
  }

  return `<div class="md">${blocks.join("") || "<p></p>"}</div>`;
}

function createReturnToNoteBtn() {
  let bar = document.getElementById(RETURN_TO_NOTE_BAR_ID);
  if (!(bar instanceof HTMLElement)) {
    bar = document.createElement("div");
    bar.id = RETURN_TO_NOTE_BAR_ID;
    bar.style.position = "fixed";
    bar.style.left = "50%";
    bar.style.bottom = "22px";
    bar.style.transform = "translateX(-50%)";
    bar.style.zIndex = "2147483647";
    bar.style.display = "none";
    bar.style.gap = "8px";
    bar.style.alignItems = "center";
    bar.style.pointerEvents = "auto";
    document.body.appendChild(bar);
  }

  let btn = document.getElementById(RETURN_TO_NOTE_BTN_ID);
  if (!(btn instanceof HTMLButtonElement)) {
    btn = document.createElement("button");
    btn.id = RETURN_TO_NOTE_BTN_ID;
    btn.type = "button";
    btn.textContent = "返回笔记位置";
    btn.style.border = "1px solid #334155";
    btn.style.background = "#0f172a";
    btn.style.color = "#e2e8f0";
    btn.style.borderRadius = "999px";
    btn.style.padding = "9px 14px";
    btn.style.fontSize = "13px";
    btn.style.lineHeight = "1.2";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 10px 24px rgba(0,0,0,0.28)";
    btn.style.opacity = "0.98";
    bar.appendChild(btn);
  }

  let hideBtn = document.getElementById(RETURN_TO_NOTE_HIDE_BTN_ID);
  if (!(hideBtn instanceof HTMLButtonElement)) {
    hideBtn = document.createElement("button");
    hideBtn.id = RETURN_TO_NOTE_HIDE_BTN_ID;
    hideBtn.type = "button";
    hideBtn.textContent = "取消显示";
    hideBtn.style.border = "1px solid #475569";
    hideBtn.style.background = "#1e293b";
    hideBtn.style.color = "#cbd5e1";
    hideBtn.style.borderRadius = "999px";
    hideBtn.style.padding = "9px 12px";
    hideBtn.style.fontSize = "12px";
    hideBtn.style.lineHeight = "1.2";
    hideBtn.style.cursor = "pointer";
    hideBtn.style.boxShadow = "0 10px 24px rgba(0,0,0,0.24)";
    hideBtn.style.opacity = "0.98";
    hideBtn.addEventListener("click", () => hideReturnToNoteBtn());
    bar.appendChild(hideBtn);
  }

  return btn;
}

function hideReturnToNoteBtn() {
  const bar = document.getElementById(RETURN_TO_NOTE_BAR_ID);
  if (bar instanceof HTMLElement) bar.style.display = "none";
}

let activeActionPopover = null;

function hideActionPopover() {
  if (activeActionPopover instanceof HTMLElement && activeActionPopover.parentElement) {
    activeActionPopover.parentElement.removeChild(activeActionPopover);
  }
  activeActionPopover = null;
}

function makeResizableBlock(el, options = {}) {
  if (!(el instanceof HTMLElement)) return;
  if (el.dataset.ovrResizable === "1") return;
  el.dataset.ovrResizable = "1";
  el.classList.add("ovr-resizable");

  const minWidth = Number(options.minWidth) || 240;
  const minHeight = Number(options.minHeight) || 120;
  const margin = Number(options.viewportMargin) || 8;

  const directions = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  let hoverDir = "";
  directions.forEach((dir) => {
    const handle = document.createElement("div");
    handle.className = `ovr-resize-handle ${dir.length === 1 ? `edge-${dir}` : `corner-${dir}`}`;
    handle.dataset.dir = dir;
    handle.title = "拖动调整大小";
    el.appendChild(handle);
  });

  const startResize = (event, dir) => {
    event.preventDefault();
    event.stopPropagation();

    if (String(el.style.transform || "").includes("translate(")) {
      const rect0 = el.getBoundingClientRect();
      el.style.setProperty("left", `${Math.max(margin, rect0.left)}px`, "important");
      el.style.setProperty("top", `${Math.max(margin, rect0.top)}px`, "important");
      el.style.setProperty("transform", "none", "important");
    }

    const computed = window.getComputedStyle(el);
    const isFixed = computed.position === "fixed";
    const rect = el.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const startLeft = isFixed ? rect.left : rect.left + window.scrollX;
    const startTop = isFixed ? rect.top : rect.top + window.scrollY;
    const maxWidth = Math.max(minWidth, window.innerWidth - margin * 2);
    const maxHeight = Math.max(minHeight, window.innerHeight - margin * 2);

    el.classList.add("resizing");
    if (!isFixed) el.style.position = computed.position === "static" ? "absolute" : computed.position;
    el.style.width = `${Math.round(startWidth)}px`;
    el.style.height = `${Math.round(startHeight)}px`;
    el.style.left = `${Math.round(startLeft)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.maxWidth = `${Math.round(maxWidth)}px`;
    el.style.maxHeight = `${Math.round(maxHeight)}px`;

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextLeft = startLeft;
      let nextTop = startTop;

      if (dir.includes("e")) nextWidth = startWidth + dx;
      if (dir.includes("s")) nextHeight = startHeight + dy;
      if (dir.includes("w")) {
        nextWidth = startWidth - dx;
        nextLeft = startLeft + dx;
      }
      if (dir.includes("n")) {
        nextHeight = startHeight - dy;
        nextTop = startTop + dy;
      }

      if (nextWidth < minWidth) {
        if (dir.includes("w")) nextLeft -= minWidth - nextWidth;
        nextWidth = minWidth;
      }
      if (nextHeight < minHeight) {
        if (dir.includes("n")) nextTop -= minHeight - nextHeight;
        nextHeight = minHeight;
      }

      nextWidth = Math.min(maxWidth, nextWidth);
      nextHeight = Math.min(maxHeight, nextHeight);
      el.style.width = `${Math.round(nextWidth)}px`;
      el.style.height = `${Math.round(nextHeight)}px`;
      if (dir.includes("w") || dir.includes("n")) {
        if (isFixed) {
          el.style.left = `${Math.round(Math.max(margin, nextLeft))}px`;
          el.style.top = `${Math.round(Math.max(margin, nextTop))}px`;
        } else {
          el.style.left = `${Math.round(Math.max(window.scrollX + margin, nextLeft))}px`;
          el.style.top = `${Math.round(Math.max(window.scrollY + margin, nextTop))}px`;
        }
      }
    };

    const onUp = () => {
      el.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  el.querySelectorAll(".ovr-resize-handle").forEach((h) => {
    if (!(h instanceof HTMLElement)) return;
    h.addEventListener("pointerdown", (event) => startResize(event, String(h.dataset.dir || "se")));
  });

  const edgeSize = Number(options.edgeSize) || 8;
  const detectDir = (event) => {
    const rect = el.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const nearL = x >= 0 && x <= edgeSize;
    const nearR = x <= rect.width && x >= rect.width - edgeSize;
    const nearT = y >= 0 && y <= edgeSize;
    const nearB = y <= rect.height && y >= rect.height - edgeSize;
    if (nearT && nearL) return "nw";
    if (nearT && nearR) return "ne";
    if (nearB && nearL) return "sw";
    if (nearB && nearR) return "se";
    if (nearT) return "n";
    if (nearB) return "s";
    if (nearL) return "w";
    if (nearR) return "e";
    return "";
  };

  const cursorMap = {
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    nw: "nwse-resize",
    se: "nwse-resize"
  };
  el.addEventListener("pointermove", (event) => {
    if (el.classList.contains("resizing")) return;
    const dir = detectDir(event);
    hoverDir = dir;
    el.style.cursor = dir ? cursorMap[dir] || "default" : "";
  });
  el.addEventListener("pointerleave", () => {
    if (el.classList.contains("resizing")) return;
    hoverDir = "";
    el.style.cursor = "";
  });
  el.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest(".ovr-resize-handle")) return;
    if (!hoverDir) return;
    startResize(event, hoverDir);
  });
}

function placePopoverNearAnchor(pop, anchorEl) {
  if (!(pop instanceof HTMLElement) || !(anchorEl instanceof HTMLElement)) return;
  const rect = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, rect.right - 260), Math.max(8, vw - 280));
  const top = Math.min(Math.max(8, rect.bottom + 8), Math.max(8, vh - 180));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function showNoteEditorPopover(anchorEl, initialNote, onSave) {
  hideActionPopover();
  const pop = document.createElement("div");
  pop.className = "ovr-action-popover";
  pop.innerHTML = `
    <div class="title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <span>编辑标注笔记</span>
      <button type="button" data-role="expand" style="border:1px solid #93c5fd;background:#eff6ff;color:#1d4ed8;border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer;">放大编辑</button>
    </div>
    <textarea placeholder="输入笔记内容"></textarea>
    <div class="row">
      <button type="button" data-role="cancel">取消</button>
      <button type="button" class="primary" data-role="save">保存</button>
    </div>
  `;
  document.body.appendChild(pop);
  placePopoverNearAnchor(pop, anchorEl);
  activeActionPopover = pop;

  const ta = pop.querySelector("textarea");
  if (ta instanceof HTMLTextAreaElement) {
    ta.value = String(initialNote || "");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  const expandBtn = pop.querySelector('[data-role="expand"]');
  if (expandBtn instanceof HTMLButtonElement) {
    let expanded = false;
    expandBtn.addEventListener("click", () => {
      expanded = !expanded;
      if (expanded) {
        pop.classList.add("editor-large");
        pop.style.position = "fixed";
        pop.style.left = "50%";
        pop.style.top = "50%";
        pop.style.right = "auto";
        pop.style.bottom = "auto";
        pop.style.transform = "translate(-50%, -50%)";
        expandBtn.textContent = "恢复普通";
      } else {
        pop.classList.remove("editor-large");
        pop.style.position = "fixed";
        pop.style.transform = "";
        placePopoverNearAnchor(pop, anchorEl);
        expandBtn.textContent = "放大编辑";
      }
      if (ta instanceof HTMLTextAreaElement) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }

  const onDocDown = (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (pop.contains(t)) return;
    if (anchorEl.contains(t)) return;
    hideActionPopover();
    document.removeEventListener("mousedown", onDocDown, true);
  };
  document.addEventListener("mousedown", onDocDown, true);

  pop.querySelector('[data-role="cancel"]')?.addEventListener("click", () => {
    hideActionPopover();
    document.removeEventListener("mousedown", onDocDown, true);
  });
  pop.querySelector('[data-role="save"]')?.addEventListener("click", async () => {
    const value = ta instanceof HTMLTextAreaElement ? ta.value : "";
    await onSave(String(value || ""));
    hideActionPopover();
    document.removeEventListener("mousedown", onDocDown, true);
  });
}

function showDeleteConfirmPopover(anchorEl, onConfirm) {
  hideActionPopover();
  const pop = document.createElement("div");
  pop.className = "ovr-action-popover";
  pop.innerHTML = `
    <div class="title">删除这条标注？</div>
    <div style="margin:0 0 8px;color:#475569;">删除后将移除高亮与笔记内容。</div>
    <div class="row">
      <button type="button" data-role="cancel">取消</button>
      <button type="button" class="danger" data-role="delete">删除</button>
    </div>
  `;
  document.body.appendChild(pop);
  placePopoverNearAnchor(pop, anchorEl);
  activeActionPopover = pop;

  const onDocDown = (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (pop.contains(t)) return;
    if (anchorEl.contains(t)) return;
    hideActionPopover();
    document.removeEventListener("mousedown", onDocDown, true);
  };
  document.addEventListener("mousedown", onDocDown, true);

  const cancelBtn = pop.querySelector('[data-role="cancel"]');
  const deleteBtn = pop.querySelector('[data-role="delete"]');
  const stopEvt = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  cancelBtn?.addEventListener("pointerdown", stopEvt);
  deleteBtn?.addEventListener("pointerdown", stopEvt);

  cancelBtn?.addEventListener("click", (e) => {
    stopEvt(e);
    hideActionPopover();
    document.removeEventListener("mousedown", onDocDown, true);
  });
  deleteBtn?.addEventListener("click", async (e) => {
    stopEvt(e);
    if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = true;
    try {
      await onConfirm();
      hideActionPopover();
      document.removeEventListener("mousedown", onDocDown, true);
    } catch (err) {
      window.alert(String(err?.message || err || "删除失败"));
      if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = false;
    }
  });
}

function navigateFromPopupAndEnableBack(popup, target) {
  if (!(popup instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
  if (!document.body.contains(target)) return false;
  const noteScrollX = window.scrollX;
  const noteScrollY = window.scrollY;
  const notePopupLeft = popup.style.left || "";
  const notePopupTop = popup.style.top || "";
  focusReferenceTarget(target);
  const backBtn = createReturnToNoteBtn();
  const bar = document.getElementById(RETURN_TO_NOTE_BAR_ID);
  if (bar instanceof HTMLElement) bar.style.display = "inline-flex";
  showStatusToast("已定位到原文。底部中间按钮可返回笔记位置。", false, 1800);
  backBtn.onclick = () => {
    window.scrollTo({ left: noteScrollX, top: noteScrollY, behavior: "smooth" });
    if (notePopupLeft) popup.style.left = notePopupLeft;
    if (notePopupTop) popup.style.top = notePopupTop;
    popup.style.display = "block";
    hideReturnToNoteBtn();
  };
  return true;
}

function extractLocatorSnippets(text) {
  const s = String(text || "");
  const out = [];
  const seen = new Set();
  const push = (x) => {
    const t = String(x || "").replace(/\s+/g, " ").trim();
    if (t.length < 16 || t.length > 220) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const m of s.matchAll(/[“"']([^“”"'\n]{16,220})[”"']/g)) push(m[1]);
  if (!out.length) {
    String(s)
      .split(/\n+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 24)
      .slice(0, 8)
      .forEach(push);
  }
  return out.slice(0, 8);
}

function escapeRegExp(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSectionToken(token) {
  return String(token || "")
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/[(){}\[\],.;:]/g, "")
    .replace(/^section\s+/i, "")
    .replace(/^sec\.?\s+/i, "")
    .replace(/^章节\s*[:：]?\s*/i, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeAnchorIdToken(token) {
  return String(token || "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();
}

function toRoman(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0 || n >= 4000) return "";
  const map = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];
  let left = Math.floor(n);
  let out = "";
  for (const [v, s] of map) {
    while (left >= v) {
      out += s;
      left -= v;
    }
  }
  return out;
}

function sectionTokenFromArxivAnchorId(anchorId) {
  const m = String(anchorId || "").trim().match(/^S(\d+)\.F(\d+)$/i);
  if (!m) return "";
  const sec = Number(m[1]);
  const sub = Number(m[2]);
  const secRoman = toRoman(sec);
  if (!secRoman) return "";
  if (!Number.isFinite(sub) || sub <= 0) return normalizeSectionToken(secRoman);
  const letter = String.fromCharCode("A".charCodeAt(0) + Math.max(0, sub - 1));
  return normalizeSectionToken(`${secRoman}-${letter}`);
}

function extractSectionTokensFromTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const set = new Set();
  const push = (token) => {
    const t = normalizeSectionToken(token);
    if (t) set.add(t);
  };
  const lead = text.match(/^([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})\b/i);
  if (lead) push(lead[1]);
  for (const m of text.matchAll(/\b([IVXLCM]+\s*[-‐‑‒–—−]\s*[A-Z]{1,3})\b/gi)) {
    push(m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:section|sec\.?|章节)\s*[:：]?\s*([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})\b/gi
  )) {
    push(m[1]);
  }
  for (const m of text.matchAll(/\b(?:section|sec\.?|章节)\s*[:：]?\s*[IVXLCM]+\s*,\s*([IVXLCM]+\s*[-‐‑‒–—−]\s*[A-Z]{1,3})\b/gi)) {
    push(m[1]);
  }
  return Array.from(set);
}

function buildPopupAnchorContext() {
  const refs = collectReferenceAnchors();
  const sections = collectSectionAnchors();
  const figures = collectFigureAnchors();
  const tables = collectTableAnchors();
  const refMap = new Map();
  const sectionLabelMap = new Map();
  const sectionIdMap = new Map();
  const figureMap = new Map();
  const tableMap = new Map();
  refs.forEach((r) => {
    const idx = Number(r?.index);
    if (!Number.isFinite(idx)) return;
    if (!refMap.has(idx)) refMap.set(idx, r);
  });
  figures.forEach((f) => {
    const idx = Number(f?.index);
    if (!Number.isFinite(idx)) return;
    if (!figureMap.has(idx)) figureMap.set(idx, f);
  });
  tables.forEach((t) => {
    const idx = Number(t?.index);
    if (!Number.isFinite(idx)) return;
    if (!tableMap.has(idx)) tableMap.set(idx, t);
  });

  const sectionAliases = [];
  const seen = new Set();
  sections.forEach((s) => {
    const title = String(s?.title || "").replace(/\s+/g, " ").trim();
    if (!title || !s?.id) return;
    const idToken = String(s.id || "").trim();
    if (idToken) {
      const k = normalizeAnchorIdToken(idToken);
      if (!sectionIdMap.has(k)) sectionIdMap.set(k, { id: idToken, title });
      const arxivToken = sectionTokenFromArxivAnchorId(idToken);
      if (arxivToken && !sectionLabelMap.has(arxivToken)) sectionLabelMap.set(arxivToken, { id: idToken, title });
    }
    extractSectionTokensFromTitle(title).forEach((key) => {
      if (!sectionLabelMap.has(key)) sectionLabelMap.set(key, { id: s.id, title });
    });
    const candidates = [title];
    const stripped = title
      .replace(/^[IVXLCM]+\s*[-.:：]?\s*/i, "")
      .replace(/^\d+(?:\.\d+)*\s*[-.:：]?\s*/, "")
      .trim();
    if (stripped && stripped !== title) candidates.push(stripped);
    candidates.forEach((alias) => {
      if (alias.length < 4) return;
      const key = `${alias.toLowerCase()}|${s.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      sectionAliases.push({ alias, id: s.id, title });
    });
  });
  sectionAliases.sort((a, b) => b.alias.length - a.alias.length);

  return { refMap, sectionAliases, sectionLabelMap, sectionIdMap, figureMap, tableMap };
}

function replaceTextNodeWithAnchorLinks(node, context) {
  const text = String(node.nodeValue || "");
  if (!text.trim()) return false;

  const matches = [];
  const refReg = /\[(\d{1,3})\]/g;
  for (const m of text.matchAll(refReg)) {
    const idx = Number(m[1]);
    const ref = context.refMap.get(idx);
    if (!ref?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: ref.id,
      title: ref.title || `参考文献 [${idx}]`
    });
  }

  const lower = text.toLowerCase();
  context.sectionAliases.forEach((s) => {
    const needle = s.alias.toLowerCase();
    let at = lower.indexOf(needle);
    while (at !== -1) {
      matches.push({
        start: at,
        end: at + needle.length,
        label: text.slice(at, at + needle.length),
        id: s.id,
        title: s.title || s.alias
      });
      at = lower.indexOf(needle, at + needle.length);
    }
  });

  for (const m of text.matchAll(/\b(?:Section|Sec\.?)\s+([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})\b/gi)) {
    const token = normalizeSectionToken(m[1]);
    const sec = context.sectionLabelMap.get(token);
    if (!sec?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: sec.id,
      title: sec.title || m[0]
    });
  }
  for (const m of text.matchAll(
    /\b(?:Section|Sec\.?)\s+[IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?\s*,\s*([IVXLCM]+\s*[-‐‑‒–—−]\s*[A-Z]{1,3})\b/gi
  )) {
    const token = normalizeSectionToken(m[1]);
    const sec = context.sectionLabelMap.get(token);
    if (!sec?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: sec.id,
      title: sec.title || m[0]
    });
  }
  for (const m of text.matchAll(/章节\s*[:：]?\s*([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})/gi)) {
    const token = normalizeSectionToken(m[1]);
    const sec = context.sectionLabelMap.get(token);
    if (!sec?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: sec.id,
      title: sec.title || m[0]
    });
  }
  for (const m of text.matchAll(/#([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)/g)) {
    const token = normalizeAnchorIdToken(m[1]);
    const sec = context.sectionIdMap.get(token);
    const anchorId = String(sec?.id || m[1] || "").trim().replace(/^#/, "");
    if (!anchorId) continue;
    if (!(document.getElementById(anchorId) instanceof HTMLElement)) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: anchorId,
      title: sec.title || m[0]
    });
  }
  for (const m of text.matchAll(/\b([A-Za-z][0-9]+(?:\.[A-Za-z][0-9]+)+)\b/g)) {
    const token = normalizeAnchorIdToken(m[1]);
    const sec = context.sectionIdMap.get(token);
    const anchorId = String(sec?.id || m[1] || "").trim().replace(/^#/, "");
    if (!anchorId) continue;
    if (!(document.getElementById(anchorId) instanceof HTMLElement)) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: anchorId,
      title: sec.title || m[0]
    });
  }

  for (const m of text.matchAll(/\b(?:Figure|Fig\.?)\s*([0-9]{1,3})\b/gi)) {
    const idx = Number(m[1]);
    const fig = context.figureMap.get(idx);
    if (!fig?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: fig.id,
      title: fig.title || m[0]
    });
  }
  for (const m of text.matchAll(/图\s*([0-9]{1,3})/g)) {
    const idx = Number(m[1]);
    const fig = context.figureMap.get(idx);
    if (!fig?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: fig.id,
      title: fig.title || m[0]
    });
  }
  for (const m of text.matchAll(/\b(?:Table|Tab\.?)\s*([0-9]{1,3})\b/gi)) {
    const idx = Number(m[1]);
    const tab = context.tableMap.get(idx);
    if (!tab?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: tab.id,
      title: tab.title || m[0]
    });
  }
  for (const m of text.matchAll(/表\s*([0-9]{1,3})/g)) {
    const idx = Number(m[1]);
    const tab = context.tableMap.get(idx);
    if (!tab?.id) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      label: m[0],
      id: tab.id,
      title: tab.title || m[0]
    });
  }

  if (!matches.length) return false;
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start < lastEnd) continue;
    chosen.push(m);
    lastEnd = m.end;
  }
  if (!chosen.length) return false;

  const frag = document.createDocumentFragment();
  let cursor = 0;
  const pushText = (to) => {
    if (to > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, to)));
    cursor = to;
  };
  chosen.forEach((m) => {
    pushText(m.start);
    const a = document.createElement("a");
    a.className = "ovr-inline-anchor";
    a.href = `#${m.id}`;
    a.dataset.anchorId = m.id;
    a.title = m.title;
    a.textContent = m.label;
    frag.appendChild(a);
    cursor = m.end;
  });
  pushText(text.length);
  node.parentNode?.replaceChild(frag, node);
  return true;
}

function enablePopupInlineAnchorLinks(popup) {
  if (!(popup instanceof HTMLElement)) return;
  const mdRoot = popup.querySelector(".body .md");
  if (!(mdRoot instanceof HTMLElement)) return;
  const context = buildPopupAnchorContext();
  const hasAnyAnchorContext =
    context.refMap.size > 0 ||
    context.sectionAliases.length > 0 ||
    context.sectionLabelMap.size > 0 ||
    context.sectionIdMap.size > 0 ||
    context.figureMap.size > 0 ||
    context.tableMap.size > 0;
  if (!hasAnyAnchorContext) return;

  const walker = document.createTreeWalker(mdRoot, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const p = n.parentElement;
    if (!p) continue;
    if (p.closest("a, code, pre, math, button")) continue;
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    nodes.push(n);
  }
  nodes.forEach((n) => replaceTextNodeWithAnchorLinks(n, context));

  mdRoot.querySelectorAll("a.ovr-inline-anchor").forEach((a) => {
    if (!(a instanceof HTMLElement)) return;
    a.addEventListener("click", (event) => {
      event.preventDefault();
      const anchorId = a.dataset.anchorId || "";
      const target = anchorId ? document.getElementById(anchorId) : null;
      if (!(target instanceof HTMLElement)) return;
      navigateFromPopupAndEnableBack(popup, target);
    });
  });
}

function normalizeSearchText(input) {
  return String(input || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u201c\u201d"]/g, "")
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[‐‑‒–—−-]/g, " ")
    .replace(/[*_`~>#]+/g, " ")
    .replace(/[，。！？；：,.!?;:()\[\]{}|\\/]+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5\u0370-\u03ff\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSnippetText(input) {
  return String(input || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/^[>\s*_`~#-]+/, "")
    .replace(/^[“"'\u201c\u201d\u2018\u2019]+/, "")
    .replace(/[“"'\u201c\u201d\u2018\u2019]+$/, "")
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .replace(/^[,.;:!?，。；：！？]+/, "")
    .replace(/[,.;:!?，。；：！？]+$/, "")
    .trim();
}

function splitSnippetSegments(snippet) {
  return sanitizeSnippetText(snippet)
    .split(/\.{3,}|…+|……+/)
    .map((x) => normalizeSearchText(x))
    .filter((x) => x.length >= 4);
}

function orderedSegmentMatchScore(text, segments) {
  if (!text || !segments.length) return 0;
  let pos = 0;
  let matched = 0;
  for (const seg of segments) {
    const found = text.indexOf(seg, pos);
    if (found === -1) continue;
    matched += seg.length;
    pos = found + seg.length;
  }
  return matched;
}

function findElementBySnippet(snippet) {
  const raw = sanitizeSnippetText(snippet);
  if (!raw) return null;
  const needle = normalizeSearchText(raw);
  const segments = splitSnippetSegments(raw);
  const tokens = needle.split(" ").filter((x) => x.length >= 4);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`#${ARXIV_INFO_POPUP_ID}, .${ARXIV_INFO_POPUP_CLASS}, #${NOTE_POPUP_ID}, #${ARXIV_SIDEBAR_ID}`)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let best = null;
  let bestScore = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = normalizeSearchText(node.nodeValue || "");
    if (!text) continue;
    let score = 0;
    if (needle && text.includes(needle)) {
      score = Math.max(score, needle.length * 10);
    }
    if (segments.length) {
      score = Math.max(score, orderedSegmentMatchScore(text, segments));
    }
    if (tokens.length >= 2) {
      let hit = 0;
      for (const t of tokens) {
        if (text.includes(t)) hit += 1;
      }
      if (hit >= 2) score = Math.max(score, hit * 6);
    }
    if (score <= 0) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const candidate = parent.closest("p, li, div, section, figure, h1, h2, h3, h4, h5, h6") || parent;
    if (!(candidate instanceof HTMLElement)) continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  // Require a minimum confidence when using segmented fuzzy matching.
  if (best instanceof HTMLElement) {
    if (needle.length >= 12 && bestScore >= Math.min(needle.length, 24)) return best;
    if (segments.length >= 2 && bestScore >= 12) return best;
    if (tokens.length >= 3 && bestScore >= 12) return best;
    if (needle.length < 12 && bestScore >= 8) return best;
  }
  return null;
}

function enablePopupLocateButtons(popup, sourceText) {
  if (!(popup instanceof HTMLElement)) return;
  const body = popup.querySelector(".body .md");
  if (!(body instanceof HTMLElement)) return;

  body.querySelectorAll(".ovr-locate-btn").forEach((x) => x.remove());
  const snippets = extractLocatorSnippets(sourceText);
  if (!snippets.length) return;

  let mounted = 0;
  const blocks = Array.from(body.querySelectorAll("p, li, blockquote"));
  for (const snippet of snippets) {
    const target = findElementBySnippet(snippet);
    if (!(target instanceof HTMLElement)) continue;
    const host = blocks.find((el) => (el.textContent || "").includes(snippet.slice(0, Math.min(32, snippet.length)))) || blocks[0];
    if (!(host instanceof HTMLElement)) continue;

    const btn = document.createElement("button");
    btn.className = "ovr-locate-btn";
    btn.type = "button";
    btn.textContent = "定位";
    btn.title = "定位到原文位置";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      navigateFromPopupAndEnableBack(popup, target);
    });
    host.appendChild(btn);
    mounted += 1;
    if (mounted >= 6) break;
  }
}

function focusReferenceTarget(target) {
  if (!(target instanceof HTMLElement) || !document.body.contains(target)) return;
  try {
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  } catch (_) {
    target.scrollIntoView();
  }
  target.classList.add("ovr-ref-focus");
  window.setTimeout(() => target.classList.remove("ovr-ref-focus"), 1800);
}

function showArxivInfoPopup(title, body, clientX, clientY, options = {}) {
  const popup = options.popup instanceof HTMLElement ? options.popup : createArxivInfoPopup({ multi: !!options.multi });
  makeArxivInfoPopupDraggable(popup);
  const hasJump = options.jumpTarget instanceof HTMLElement;
  const jumpLabel = escapeHtml(String(options.jumpText || "跳转到原文"));
  const actions = Array.isArray(options.actions) ? options.actions : [];
  const actionHtml = actions
    .map((a) => {
      const id = escapeHtml(String(a?.id || ""));
      const label = escapeHtml(String(a?.label || "操作"));
      const kindCls = String(a?.kind || "").toLowerCase() === "danger" ? " danger" : "";
      return `<button class="action-btn${kindCls}" type="button" data-action-id="${id}">${label}</button>`;
    })
    .join("");
  popup.innerHTML = `
    <div class="popup-head">
      <div class="title">${escapeHtml(title)}</div>
      <div class="popup-head-right">
        ${actionHtml}
        ${hasJump ? `<button class="jump-btn" type="button" title="${jumpLabel}">${jumpLabel}</button>` : ""}
        <button class="close-btn" type="button" title="关闭">×</button>
      </div>
    </div>
    <div class="body">${renderPopupMarkdown(body)}</div>
  `;
  const jumpBtn = popup.querySelector(".jump-btn");
  if (jumpBtn instanceof HTMLElement && options.jumpTarget instanceof HTMLElement) {
    jumpBtn.addEventListener("click", () => navigateFromPopupAndEnableBack(popup, options.jumpTarget));
  }
  const closeBtn = popup.querySelector(".close-btn");
  if (closeBtn instanceof HTMLElement) {
    closeBtn.addEventListener("click", () => {
      if (popup.id === ARXIV_INFO_POPUP_ID) popup.style.display = "none";
      else if (popup.parentElement) popup.parentElement.removeChild(popup);
      hideActionPopover();
      if (typeof options.onClose === "function") {
        try {
          options.onClose();
        } catch (_) {
          // Ignore close callback errors.
        }
      }
    });
  }
  popup.style.display = "block";
  enablePopupInlineAnchorLinks(popup);
  enablePopupLocateButtons(popup, body);
  if (typeof options.onAction === "function") {
    popup.querySelectorAll(".action-btn[data-action-id]").forEach((btn) => {
      if (!(btn instanceof HTMLElement)) return;
      const invoke = () => {
        const actionId = String(btn.dataset.actionId || "");
        if (!actionId) return;
        try {
          options.onAction(actionId, popup, btn);
        } catch (_) {
          // Ignore popup action errors.
        }
      };
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        invoke();
      });
    });
  }

  // For async updates of the same popup (e.g., section summary "generating" -> "done"),
  // keep the original anchor position instead of re-positioning with stale click coords.
  const shouldKeepPosition =
    options.popup instanceof HTMLElement &&
    options.keepPosition !== false &&
    Boolean(popup.style.left) &&
    Boolean(popup.style.top);
  if (shouldKeepPosition) return popup;

  const maxLeft = window.innerWidth - popup.offsetWidth - 12;
  const maxTop = window.innerHeight - popup.offsetHeight - 12;
  const leftInViewport = Math.min(Math.max(8, clientX + 14), Math.max(8, maxLeft));
  const topInViewport = Math.min(Math.max(8, clientY + 14), Math.max(8, maxTop));
  const multiOffset = options.multi && !options.popup ? document.querySelectorAll(`.${ARXIV_INFO_POPUP_CLASS}`).length - 1 : 0;
  popup.style.left = `${leftInViewport + window.scrollX + Math.min(28 * multiOffset, 120)}px`;
  popup.style.top = `${topInViewport + window.scrollY + Math.min(22 * multiOffset, 100)}px`;
  return popup;
}

function createStatusToast() {
  let toast = document.getElementById(ARXIV_STATUS_TOAST_ID);
  if (toast) return toast;
  toast = document.createElement("div");
  toast.id = ARXIV_STATUS_TOAST_ID;
  document.body.appendChild(toast);
  return toast;
}

function showStatusToast(message, done = false, autoHideMs = 0) {
  const toast = createStatusToast();
  toast.textContent = String(message || "");
  toast.classList.toggle("done", !!done);
  toast.style.display = "block";
  if (autoHideMs > 0) {
    window.setTimeout(() => {
      const latest = document.getElementById(ARXIV_STATUS_TOAST_ID);
      if (latest) latest.style.display = "none";
    }, autoHideMs);
  }
}

function isArxivHtmlPage() {
  return window.location.hostname === "arxiv.org" && window.location.pathname.startsWith("/html/");
}

function getArxivRoot() {
  return document.querySelector("article") || document.querySelector("main") || document.body;
}

function getSidebarPosStorageKey() {
  try {
    return `${OVR_SIDEBAR_POS_PREFIX}${window.location.hostname}`;
  } catch (_) {
    return `${OVR_SIDEBAR_POS_PREFIX}default`;
  }
}

function applySidebarStoredPosition(side) {
  if (!(side instanceof HTMLElement)) return;
  const key = getSidebarPosStorageKey();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const pos = JSON.parse(raw);
    const left = Number(pos?.left);
    const top = Number(pos?.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    side.style.left = `${Math.max(8, left)}px`;
    side.style.top = `${Math.max(8, top)}px`;
  } catch (_) {
    // Ignore malformed storage.
  }
}

function makeSidebarDraggable(side) {
  if (!(side instanceof HTMLElement)) return;
  const handle = side.querySelector(".ovr-side-head");
  if (!(handle instanceof HTMLElement)) return;
  const toggleBtn = side.querySelector("#ovr-sidebar-toggle");
  const key = getSidebarPosStorageKey();
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
  const onMove = (event) => {
    if (!dragging) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = side.getBoundingClientRect();
    const nextLeft = clamp(event.clientX - offsetX, 8, Math.max(8, vw - rect.width - 8));
    const nextTop = clamp(event.clientY - offsetY, 8, Math.max(8, vh - 48));
    side.style.left = `${Math.round(nextLeft)}px`;
    side.style.top = `${Math.round(nextTop)}px`;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    side.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    const left = Number.parseInt(side.style.left || "12", 10);
    const top = Number.parseInt(side.style.top || "72", 10);
    try {
      localStorage.setItem(key, JSON.stringify({ left, top }));
    } catch (_) {
      // Ignore storage errors.
    }
  };

  handle.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (toggleBtn && (target === toggleBtn || toggleBtn.contains(target))) return;
    dragging = true;
    side.classList.add("dragging");
    const rect = side.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    event.preventDefault();
  });
}

function buildArxivSidebar(headings, options = {}) {
  let side = document.getElementById(ARXIV_SIDEBAR_ID);
  if (side) return side;
  const title = String(options.title || "论文大纲");

  side = document.createElement("aside");
  side.id = ARXIV_SIDEBAR_ID;
  side.innerHTML = `
    <div class="ovr-side-head">
      <h3>${escapeHtml(title)}</h3>
      <button id="ovr-sidebar-toggle" class="ovr-side-toggle" type="button" title="收起">◀</button>
    </div>
    <div class="ovr-side-body">
      <ul class="ovr-outline" id="ovr-outline-list"></ul>
      <div class="ovr-search">
        <h3>搜索</h3>
        <input id="ovr-search-query" placeholder="代码或引用关键词" />
        <div class="ovr-search-row">
          <button id="ovr-code-search" type="button">代码搜索</button>
          <button id="ovr-scholar-search" type="button">学术引用</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(side);
  applySidebarStoredPosition(side);
  makeSidebarDraggable(side);

  const toggleBtn = side.querySelector("#ovr-sidebar-toggle");
  const applyCollapsedState = (collapsed) => {
    side.classList.toggle("collapsed", !!collapsed);
    if (toggleBtn) {
      toggleBtn.textContent = collapsed ? "▶" : "◀";
      toggleBtn.title = collapsed ? "展开" : "收起";
    }
  };
  try {
    applyCollapsedState(localStorage.getItem(ARXIV_SIDEBAR_COLLAPSED_KEY) === "1");
  } catch (_) {
    applyCollapsedState(false);
  }
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const nextCollapsed = !side.classList.contains("collapsed");
      applyCollapsedState(nextCollapsed);
      try {
        localStorage.setItem(ARXIV_SIDEBAR_COLLAPSED_KEY, nextCollapsed ? "1" : "0");
      } catch (_) {
        // Ignore storage errors.
      }
    });
  }

  const list = side.querySelector("#ovr-outline-list");
  headings.forEach((h) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${h.id}`;
    a.textContent = `${"  ".repeat(Math.max(0, h.level - 2))}${h.text}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      h.el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    li.appendChild(a);
    list.appendChild(li);
  });

  const input = side.querySelector("#ovr-search-query");
  const resolveQuery = () => input.value.trim() || getSelectionText() || document.title;

  side.querySelector("#ovr-code-search").addEventListener("click", () => {
    const q = resolveQuery();
    window.open(`https://github.com/search?q=${encodeURIComponent(q)}&type=code`, "_blank", "noopener");
  });

  side.querySelector("#ovr-scholar-search").addEventListener("click", () => {
    const q = resolveQuery();
    window.open(`https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`, "_blank", "noopener");
  });

  return side;
}

function collectArxivHeadings() {
  const nodes = Array.from(
    document.querySelectorAll(
      "article h1, article h2, article h3, article h4, article h5, article h6, " +
        "main h1, main h2, main h3, main h4, main h5, main h6, " +
        ".ltx_title.ltx_title_section, .ltx_title.ltx_title_subsection, .ltx_title.ltx_title_subsubsection"
    )
  );
  const headings = [];
  let idx = 0;
  const seenText = new Set();

  for (const el of nodes) {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    const textKey = text.toLowerCase();
    if (seenText.has(textKey)) continue;
    seenText.add(textKey);
    if (!el.id) {
      idx += 1;
      el.id = `ovr-heading-${idx}`;
    }
    let level = Number(el.tagName.slice(1)) || 2;
    if (el.classList.contains("ltx_title_subsection")) level = 3;
    if (el.classList.contains("ltx_title_subsubsection")) level = 4;
    if (el.classList.contains("ltx_title_section")) level = 2;
    headings.push({ id: el.id, text, level, el });
  }
  return headings;
}

function collectGenericHeadings() {
  const nodes = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const headings = [];
  let idx = 0;
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.closest(`#${ARXIV_SIDEBAR_ID}`)) continue;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (!text || text.length > 140) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    if (!el.id) {
      idx += 1;
      el.id = `ovr-g-heading-${idx}`;
    }
    const level = Number(el.tagName.slice(1)) || 2;
    headings.push({ id: el.id, text, level, el });
  }
  return headings;
}

function ensureNodeId(el, prefix = "ovr-anchor") {
  if (!(el instanceof HTMLElement)) return "";
  if (el.id) return el.id;
  const base = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  el.id = base;
  return el.id;
}

function buildHashUrl(id) {
  try {
    const url = new URL(window.location.href);
    url.hash = id ? `#${id}` : "";
    return url.toString();
  } catch (_) {
    return window.location.href;
  }
}

function collectReferenceAnchors(limit = 240) {
  const nodes = Array.from(
    document.querySelectorAll("section#references li, .ltx_bibitem, ol.references li, .references li, #references li")
  );
  const refs = [];
  nodes.forEach((el, idx) => {
    if (!(el instanceof HTMLElement)) return;
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw) return;
    const id = ensureNodeId(el, "ovr-ref");
    const explicitNum = raw.match(/^\[(\d{1,3})\]/)?.[1];
    const num = Number(explicitNum || idx + 1);
    refs.push({
      index: Number.isFinite(num) ? num : idx + 1,
      id,
      url: buildHashUrl(id),
      title: raw.slice(0, 220)
    });
  });
  return refs.slice(0, limit);
}

function collectSectionAnchors(limit = 400) {
  const rows = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.id || !item.title) return;
    const k = `${String(item.id).trim()}|${String(item.title).trim().toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    rows.push(item);
  };

  if (isArxivHtmlPage()) {
    const tocLinks = Array.from(document.querySelectorAll('a[href^="#S"], a[href^="#s"]'));
    tocLinks.forEach((a) => {
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = String(a.getAttribute("href") || "").trim();
      const id = href.replace(/^#/, "").trim();
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!id || !text) return;
      const target = document.getElementById(id);
      if (!(target instanceof HTMLElement)) return;
      push({
        id,
        title: text,
        level: Number(target.tagName?.slice(1)) || 2,
        url: buildHashUrl(id)
      });
    });
  }

  const headingRows = (isArxivHtmlPage() ? collectArxivHeadings() : collectGenericHeadings()).slice(0, limit);
  headingRows.forEach((h) => {
    const id = ensureNodeId(h.el, "ovr-sec");
    push({
      id,
      title: String(h.text || "").trim(),
      level: Number(h.level) || 2,
      url: buildHashUrl(id)
    });
  });

  return rows
    .slice(0, limit)
    .map((h) => {
      return {
        id: String(h.id || "").trim(),
        title: String(h.title || "").trim(),
        level: Number(h.level) || 2,
        url: String(h.url || buildHashUrl(String(h.id || "").trim()))
      };
    })
    .filter((x) => x.title);
}

function collectFigureAnchors(limit = 200) {
  const nodes = Array.from(
    document.querySelectorAll("figure, .ltx_figure, .ltx_float, .figure, .ltx_table, table")
  );
  const figures = [];
  let autoIdx = 0;
  nodes.forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.matches(".ltx_equation, .ltx_eqn_table, .MathJax_Display, .katex-display")) return;
    if (el.querySelector(".ltx_equation, .ltx_eqn_table, .MathJax_Display, .katex-display")) return;

    const hasGraphicContent = Boolean(el.querySelector("img, svg, canvas, video, picture"));
    const cap =
      el.querySelector("figcaption, .ltx_caption, .caption") ||
      (el.previousElementSibling instanceof HTMLElement ? el.previousElementSibling : null) ||
      (el.nextElementSibling instanceof HTMLElement ? el.nextElementSibling : null);
    const text = ((cap?.textContent || el.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 220);
    if (!text || text.length < 4) return;
    const m = text.match(/\b(?:figure|fig\.?|图)\s*([0-9]{1,3})\b/i);
    // Only accept loose numeric fallback when there is clear graphic payload.
    const fallback = hasGraphicContent ? text.match(/^([0-9]{1,3})[\).:\s]/) : null;
    const idx = m ? Number(m[1]) : fallback ? Number(fallback[1]) : NaN;
    // Exclude non-figure blocks that only mention equation/table numbering.
    if (!Number.isFinite(idx)) return;
    if (!m && !hasGraphicContent) return;

    const id = ensureNodeId(el, "ovr-fig");
    figures.push({
      index: idx,
      id,
      url: buildHashUrl(id),
      title: text
    });
    autoIdx += 1;
  });
  return figures.slice(0, limit);
}

function collectTableAnchors(limit = 200) {
  const nodes = Array.from(document.querySelectorAll("table, .ltx_table, figure .ltx_tabular"));
  const tables = [];
  nodes.forEach((el, idx) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.matches(".ltx_equation, .ltx_eqn_table, .MathJax_Display, .katex-display")) return;
    if (el.querySelector(".ltx_equation, .ltx_eqn_table, .MathJax_Display, .katex-display")) return;
    const host = el.closest("figure, .ltx_float, .ltx_table") || el;
    const cap =
      host.querySelector("figcaption, .ltx_caption, .caption") ||
      (host.previousElementSibling instanceof HTMLElement ? host.previousElementSibling : null) ||
      (host.nextElementSibling instanceof HTMLElement ? host.nextElementSibling : null);
    const text = ((cap?.textContent || host.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 220);
    if (!text) return;
    const m = text.match(/\b(?:table|tab\.?|表)\s*([0-9]{1,3})\b/i);
    if (!m) return;
    const id = ensureNodeId(host instanceof HTMLElement ? host : el, "ovr-tab");
    tables.push({
      index: Number(m[1]) || idx + 1,
      id,
      url: buildHashUrl(id),
      title: text
    });
  });
  return tables.slice(0, limit);
}

function initOutlineSidebarForPage() {
  const headings = isArxivHtmlPage() ? collectArxivHeadings() : collectGenericHeadings();
  if (!Array.isArray(headings) || headings.length < 2) return null;
  const title = isArxivHtmlPage() ? "论文大纲" : "页面大纲";
  return buildArxivSidebar(headings, { title });
}

function removeOutlineSidebar() {
  const side = document.getElementById(ARXIV_SIDEBAR_ID);
  if (side && side.parentElement) side.parentElement.removeChild(side);
}

function heuristicZhSummary(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "本段主要说明研究背景、技术方法与关键结论。";
  return "本段围绕具体研究问题展开，先说明问题设定与前提条件，再交代方法或推导步骤，最后指出该段得到的结论及其在全文中的作用。";
}

function heuristicFormulaSummary(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) return "该公式用于定义变量关系或中间推导。";
  return `该公式围绕 ${clean.slice(0, 36)} 展开，用于把当前段落中的变量关系写成可计算形式。结合上下文可将其理解为从前一步假设到本步结论的桥梁，对后续推导和实验设置都有直接影响。`;
}

function splitSentencesForSummary(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 8);
}

function buildLocalExtractiveSummary(text, targetSentences = 4) {
  const sents = splitSentencesForSummary(text);
  if (!sents.length) return "未提取到足够文本，建议重试或缩小选区。";
  if (sents.length <= targetSentences) return sents.join(" ");

  const tokenFreq = new Map();
  for (const s of sents) {
    const tokens = s.match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]{2,}/g) || [];
    for (const t of tokens) tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
  }
  const scored = sents.map((s, idx) => {
    const tokens = s.match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]{2,}/g) || [];
    let score = 0;
    for (const t of tokens) score += tokenFreq.get(t) || 0;
    return { idx, s, score };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const top = scored.slice(0, targetSentences).sort((a, b) => a.idx - b.idx);
  return top.map((x) => x.s).join(" ");
}

function containsCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function shouldRegenerateSummary(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  if (/[.]{3}|…/.test(s)) return true;
  if (!containsCjk(s)) return true;
  if (s.length < 38) return true;
  if (/\[摘要模型未生效|\[摘要异常|超时/.test(s)) return true;
  if (/本节主要介绍研究目标|本段主要说明研究背景|关键结论及其作用/.test(s)) return true;
  return false;
}

function isUsableSectionSummary(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/\[摘要模型未生效|\[摘要异常|解析失败/.test(s)) return false;
  return s.length >= 12;
}

function isLegacyFormulaSummary(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  return /公式含义|与上下文关系|与前后公式关系|该式主要描述/.test(s);
}

function sanitizeFormulaSummary(text) {
  let s = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*公式\s*\d+\s*讲解[:：]?\s*/gim, "")
    .replace(/^\s*公式含义[:：]?\s*/gim, "")
    .replace(/^\s*与上下文关系[:：]?\s*/gim, "")
    .replace(/^\s*与前后公式关系[:：]?\s*/gim, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (isLegacyFormulaSummary(s)) return "";
  return s;
}

function isUsableFormulaSummary(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/^解析失败[:：]/.test(s)) return false;
  if (/生成中|按需模式|未预加载/.test(s)) return false;
  if (isLegacyFormulaSummary(s)) return false;
  return s.length >= 24;
}

function isFormulaOnDemandPlaceholder(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  return /按需模式|未预加载|生成中/.test(s) || /^解析失败[:：]/.test(s);
}

function formatRawModelOutput(raw, limit = 700) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "（空）";
  return s.length > limit ? `${s.slice(0, limit)}...(已截断)` : s;
}

async function generateSingleFormulaExplanation(index, targetEl) {
  const root = getArxivRoot();
  const formulas = collectFormulaBlocks(root);
  const formula = formulas[index];
  if (!formula) return { ok: false, error: "未找到对应公式节点" };

  const sectionCtx = getSectionContextForFormula(root, formula.el);
  const prompt = [
    "你是严谨的学术论文讲解助手。",
    "你将收到一条公式与章节上下文，请输出中文公式讲解。",
    "要求：输出2-3段自然语言，220-420字，内容具体、连贯，不要模板句。",
    "必须覆盖：问题背景、关键符号含义、推导链条与该式作用。",
    "保留数学表达并使用 Markdown 数学语法（$...$ / $$...$$）。",
    "不要 JSON，不要代码块，直接输出 Markdown 正文。"
  ].join("");
  const input = [
    `章节标题:\n${sectionCtx.title || "未知章节"}`,
    `章节上下文:\n${sectionCtx.text || "无可用章节上下文"}`,
    `当前公式:\n${formula.text}`
  ].join("\n\n");
  const res = await callModelForBatchSummary([input], prompt, {
    maxOutputTokens: 520,
    preferFastModel: false,
    timeoutMs: 95000
  });
  const raw = String(res?.arr?.[0]?.summary || res?.arr?.[0]?.text || "").trim();
  const summary = sanitizeFormulaSummary(cleanMathPlaceholders(raw, formula.text));
  if (!isUsableFormulaSummary(summary)) {
    const detail = String(res?.error || "").trim();
    return {
      ok: false,
      error: detail
        ? `${detail}\n原始返回: ${formatRawModelOutput(raw)}`
        : `未获取到有效公式讲解。\n原始返回: ${formatRawModelOutput(raw)}`
    };
  }

  const cache = await getArxivSummaries();
  cache[`f_${index}`] = summary;
  delete cache[summaryErrorKey("f", index)];
  await saveArxivSummaries(cache);

  attachFormulaIcon(targetEl, summary, "", index);
  return { ok: true, data: { summary } };
}

function extractJsonArray(text) {
  const m = String(text || "").match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

async function callModelForBatchSummary(inputs, systemPrompt, options = {}) {
  if (runtimeContextInvalid) {
    return { arr: null, error: "扩展上下文已失效（请刷新当前网页后重试）。" };
  }
  try {
    const request = chrome.runtime.sendMessage({
      type: "OVR_SUMMARY_REQUEST",
      inputs,
      systemPrompt,
      maxOutputTokens: options.maxOutputTokens || 360,
      preferFastModel: options.preferFastModel !== false
    });
    const timeout = new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: `摘要请求超时（>${options.timeoutMs || 25000}ms）` }),
        options.timeoutMs || 25000
      )
    );
    const res = await Promise.race([request, timeout]);
    if (res?.ok && Array.isArray(res.data)) return { arr: res.data, error: "" };
    return { arr: null, error: String(res?.error || "摘要模型请求失败") };
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Extension context invalidated/i.test(msg)) {
      runtimeContextInvalid = true;
      return { arr: null, error: "扩展上下文已失效，请刷新当前网页后重试。" };
    }
    return { arr: null, error: msg };
  }
}

async function preloadSectionSummaries(sections, onProgress, options = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const total = list.length;
  if (typeof onProgress === "function") onProgress(0, total);
  if (!total) return { ok: true, total: 0, generated: 0, failed: 0 };
  const force = options.force === true;

  const cache = await getArxivSummaries();
  const needs = [];
  let done = 0;
  list.forEach((sec, i) => {
    const key = `sec_${i}`;
    if (force) {
      delete cache[key];
      delete cache[summaryErrorKey("sec", i)];
    }
    const summary = cleanMathPlaceholders(String(cache[key] || "").trim(), sec.text || "");
    if (!force && isUsableSectionSummary(summary)) {
      done += 1;
    } else {
      delete cache[key];
      needs.push({ i, key, sec });
    }
  });
  if (typeof onProgress === "function") onProgress(done, total);
  if (!needs.length) {
    await saveArxivSummaries(cache);
    return { ok: true, total, generated: 0, failed: 0 };
  }

  const cfg = await getOpenAIConfig();
  const targetLength = Math.max(80, Math.min(1200, Number(cfg.sectionSummaryLength) || 220));
  const sectionPrompt = [
    "你是严谨的学术论文讲解助手。",
    "你将收到一个章节文本，请输出该章节中文概要。",
    `要求：长度控制在 ${targetLength} 字左右（允许上下浮动20%），内容具体，不要空话。`,
    "必须覆盖：研究问题、方法/机制、关键结果或结论、与全文关系。",
    "请保留关键术语与符号，不要省略号，不要“本节主要介绍”这类模板句。",
    "涉及数学表达时请使用 Markdown 数学语法（行内 $...$，块级 $$...$$）。",
    "输出纯 Markdown 正文；不要 JSON，不要代码块，不要编号前缀。"
  ].join("");
  let generatedCount = 0;
  let failedCount = 0;
  const sectionInputLimit = 1400;
  const sectionRetryLimit = 1000;
  for (let start = 0; start < needs.length; start += 2) {
    const chunk = needs.slice(start, start + 2);
    const inputs = chunk.map((x) => `${x.sec.title}\n${String(x.sec.text || "").slice(0, sectionInputLimit)}`);
    const tokenBudget = Math.max(180, Math.min(620, Math.round(targetLength * 1.8)));
    let res = await callModelForBatchSummary(inputs, sectionPrompt, {
      maxOutputTokens: tokenBudget,
      preferFastModel: true,
      timeoutMs: 110000
    });
    if ((!Array.isArray(res.arr) || !res.arr.length) && /超时|timeout/i.test(String(res.error || ""))) {
      const retryPrompt = [
        "请输出该章节中文概要。",
        `长度约 ${Math.min(targetLength, 320)} 字，聚焦核心方法与结论，避免套话。`,
        "输出纯文本 Markdown，不要 JSON。"
      ].join("");
      const retryInputs = chunk.map((x) => `${x.sec.title}\n${String(x.sec.text || "").slice(0, sectionRetryLimit)}`);
      res = await callModelForBatchSummary(retryInputs, retryPrompt, {
        maxOutputTokens: 320,
        preferFastModel: true,
        timeoutMs: 80000
      });
    }
    chunk.forEach((x, idx) => {
      const raw = String(res?.arr?.[idx]?.summary || res?.arr?.[idx]?.text || "").trim();
      const generated = cleanMathPlaceholders(raw, x.sec.text || "");
      if (isUsableSectionSummary(generated)) {
        cache[x.key] = generated;
        delete cache[summaryErrorKey("sec", x.i)];
        generatedCount += 1;
      } else {
        const detail = String(res?.error || "").trim();
        cache[summaryErrorKey("sec", x.i)] = detail
          ? `解析失败：请检查 API Key 和模型名称是否配置正确。\n详情：${detail}`
          : "解析失败：未返回可解析的章节概要。";
        failedCount += 1;
      }
      done += 1;
      if (typeof onProgress === "function") onProgress(done, total);
    });
  }
  await saveArxivSummaries(cache);
  return { ok: true, total, generated: generatedCount, failed: failedCount };
}

function collectFormulaBlocks(root) {
  const candidates = Array.from(
    root.querySelectorAll(".ltx_equation, .ltx_eqn_table, .MathJax_Display, mjx-container[display='true'], .katex-display")
  );
  const uniq = [];
  const seen = new Set();
  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;
    const host = el.closest("figure, div, section") || el;
    if (seen.has(host)) continue;
    seen.add(host);
    const text = (host.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 6) continue;
    uniq.push({ el: host, text: text.slice(0, 500) });
  }
  return uniq.slice(0, 60);
}

function collectSectionHeadingNodes(root) {
  return Array.from(
    root.querySelectorAll("h2, h3, .ltx_title.ltx_title_section, .ltx_title.ltx_title_subsection, .ltx_title.ltx_title_subsubsection")
  ).filter((x) => x instanceof HTMLElement);
}

function getSectionContextForFormula(root, formulaEl) {
  const headings = collectSectionHeadingNodes(root);
  if (!headings.length) return { title: "", text: "" };
  let currentHeading = null;
  for (const h of headings) {
    if (!(h instanceof HTMLElement)) continue;
    if (h === formulaEl) break;
    const pos = h.compareDocumentPosition(formulaEl);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) currentHeading = h;
  }
  if (!(currentHeading instanceof HTMLElement)) {
    // Fallback: use nearby text when heading alignment fails.
    const nearby = [];
    let cur = formulaEl.previousElementSibling;
    let hops = 0;
    while (cur && hops < 8) {
      const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length >= 24) nearby.unshift(t);
      cur = cur.previousElementSibling;
      hops += 1;
    }
    cur = formulaEl.nextElementSibling;
    hops = 0;
    while (cur && hops < 8) {
      const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length >= 24) nearby.push(t);
      cur = cur.nextElementSibling;
      hops += 1;
    }
    return { title: "当前上下文", text: nearby.join("\n").slice(0, 16000) };
  }
  const title = (currentHeading.textContent || "").replace(/\s+/g, " ").trim();
  const texts = [];
  const nextHeading = headings.find((h) => h instanceof HTMLElement && currentHeading.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
  let cur = currentHeading.nextElementSibling;
  let totalChars = 0;
  while (cur && cur !== nextHeading) {
    const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length >= 20) {
      texts.push(t);
      totalChars += t.length;
    }
    if (totalChars > 26000) break;
    cur = cur.nextElementSibling;
  }
  return { title, text: texts.join("\n").slice(0, 26000) };
}

function attachFormulaIcon(targetEl, summary, relation, index) {
  let icon = targetEl.querySelector(":scope > .ovr-formula-icon");
  if (!(icon instanceof HTMLElement)) {
    icon = document.createElement("span");
    icon.className = "ovr-formula-icon";
    icon.title = "查看公式讲解";
    icon.textContent = "ƒ";
    icon.addEventListener("click", async (event) => {
      event.stopPropagation();
      const el = event.currentTarget;
      if (!(el instanceof HTMLElement)) return;
      const idx0 = Number(el.dataset.formulaIndex || 0);
      const idx = idx0 + 1;
      let popup = formulaSummaryPopupMap.get(idx0);
      if (!(popup instanceof HTMLElement) || !document.body.contains(popup)) {
        formulaSummaryPopupMap.delete(idx0);
        popup = showArxivInfoPopup(
          "公式讲解",
          `**公式 ${idx} 讲解**\n\n正在读取公式讲解，请稍候...`,
          event.clientX,
          event.clientY,
          {
            multi: true,
            jumpTarget: targetEl,
            jumpText: "定位公式",
            onClose: () => formulaSummaryPopupMap.delete(idx0)
          }
        );
        formulaSummaryPopupMap.set(idx0, popup);
      } else {
        popup = showArxivInfoPopup(
          "公式讲解",
          `**公式 ${idx} 讲解**\n\n正在读取公式讲解，请稍候...`,
          event.clientX,
          event.clientY,
          {
            multi: true,
            popup,
            jumpTarget: targetEl,
            jumpText: "定位公式",
            onClose: () => formulaSummaryPopupMap.delete(idx0)
          }
        );
      }
      const key = `f_${idx0}`;
      const errKey = summaryErrorKey("f", idx0);
      const renderFormulaPopup = (content, popupRef = popup) =>
        showArxivInfoPopup("公式讲解", `**公式 ${idx} 讲解**\n\n${content}`, event.clientX, event.clientY, {
          multi: true,
          popup: popupRef,
          jumpTarget: targetEl,
          jumpText: "定位公式",
          actions: [{ id: "regen", label: "重新生成" }],
          onClose: () => formulaSummaryPopupMap.delete(idx0),
          onAction: (actionId, currentPopup) => {
            if (actionId !== "regen") return;
            if (runtimeContextInvalid) {
              renderFormulaPopup("扩展上下文已失效（通常是刚重载了插件）。请刷新当前网页后重试。", currentPopup);
              return;
            }
            renderFormulaPopup("正在重新生成公式讲解，请稍候...", currentPopup);
            void ensureFormulaSummary(true, currentPopup);
          }
        });
      const ensureFormulaSummary = async (force = false, popupRef = popup) => {
        if (runtimeContextInvalid) {
          renderFormulaPopup("扩展上下文已失效（通常是刚重载了插件）。请刷新当前网页后重试。", popupRef);
          return;
        }
        if (force) {
          const latest = await getArxivSummaries();
          delete latest[key];
          delete latest[errKey];
          await saveArxivSummaries(latest);
        }
        const cache = await getArxivSummaries();
        const current = sanitizeFormulaSummary(String(cache[key] || "").trim());
        if (!force && isUsableFormulaSummary(current)) {
          renderFormulaPopup(current, popupRef);
          return;
        }
        const prevErr = String(cache[errKey] || "").trim();
        if (!force && prevErr) renderFormulaPopup(`上次失败，正在重试...\n${prevErr}`, popupRef);
        if (!formulaSummaryInFlight.has(idx0) || force) {
          formulaSummaryInFlight.set(
            idx0,
            (async () => {
              const res = await generateSingleFormulaExplanation(idx0, targetEl);
              if (!res.ok) {
                const latest = await getArxivSummaries();
                const errText = `解析失败：${String(res.error || "未获取到有效公式讲解")}`;
                latest[key] = errText;
                latest[errKey] = errText;
                await saveArxivSummaries(latest);
              }
            })().finally(() => formulaSummaryInFlight.delete(idx0))
          );
        }
        await formulaSummaryInFlight.get(idx0);
        const after = await getArxivSummaries();
        const summaryText = sanitizeFormulaSummary(String(after[key] || "").trim());
        const errText = String(after[errKey] || "").trim();
        if (isUsableFormulaSummary(summaryText)) renderFormulaPopup(summaryText, popupRef);
        else renderFormulaPopup(errText || "解析失败：未获取到有效公式讲解。", popupRef);
      };
      await ensureFormulaSummary(false, popup);
    });
    targetEl.prepend(icon);
  }
  icon.dataset.formulaIndex = String(index);
  icon.dataset.formulaSummary = String(summary || "").trim();
  icon.dataset.formulaRelation = String(relation || "").trim();
}

function collectSectionBlocks(root) {
  const headingNodes = Array.from(root.querySelectorAll("h2, h3"));
  const blocks = [];
  headingNodes.forEach((h, i) => {
    const title = (h.textContent || "").replace(/\s+/g, " ").trim();
    if (!title) return;
    const next = headingNodes[i + 1] || null;
    const parts = [];
    let cur = h.nextElementSibling;
    while (cur && cur !== next) {
      const txt = (cur.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length >= 40) parts.push(txt);
      cur = cur.nextElementSibling;
    }
    const text = parts.join("\n").slice(0, 5000);
    blocks.push({ heading: h, title, text });
  });
  return blocks.slice(0, 40);
}

function installSectionSummaryIcons() {
  const root = getArxivRoot();
  const sections = collectSectionBlocks(root);

  sections.forEach((sec, i) => {
    if (sec.heading.querySelector(":scope > .ovr-section-icon")) return;
    const icon = document.createElement("button");
    icon.className = "ovr-section-icon";
    icon.type = "button";
    icon.title = "点击生成本节概要";
    icon.setAttribute("aria-label", "点击生成本节概要");
    icon.textContent = "S";
    icon.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    icon.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      showStatusToast("正在打开章节概要...", false, 800);
      let popup = sectionSummaryPopupMap.get(i);
      if (!(popup instanceof HTMLElement) || !document.body.contains(popup)) {
        sectionSummaryPopupMap.delete(i);
        popup = showArxivInfoPopup("章节概要", "正在生成中文章节概要，请稍候...", event.clientX, event.clientY, {
          multi: true,
          jumpTarget: sec.heading,
          jumpText: "定位章节",
          onClose: () => sectionSummaryPopupMap.delete(i)
        });
        sectionSummaryPopupMap.set(i, popup);
      } else {
        showArxivInfoPopup("章节概要", "正在生成中文章节概要，请稍候...", event.clientX, event.clientY, {
          multi: true,
          popup,
          jumpTarget: sec.heading,
          jumpText: "定位章节"
        });
      }
      try {
        const cache = await getArxivSummaries();
        const key = `sec_${i}`;
        const errKey = summaryErrorKey("sec", i);
        const renderSectionPopup = (content, popupRef = popup) =>
          showArxivInfoPopup(`章节概要：${sec.title}`, content, event.clientX, event.clientY, {
            multi: true,
            popup: popupRef,
            jumpTarget: sec.heading,
            jumpText: "定位章节",
            actions: [{ id: "regen", label: "重新生成" }],
            onAction: (actionId, currentPopup) => {
              if (actionId !== "regen") return;
              if (runtimeContextInvalid) {
                renderSectionPopup("扩展上下文已失效（通常是刚重载了插件）。请刷新当前网页后重试。", currentPopup);
                return;
              }
              showStatusToast("正在重新生成章节概要...", false, 900);
              renderSectionPopup("正在重新生成中文章节概要，请稍候...", currentPopup);
              void generateSectionSummary(true, currentPopup);
            }
          });
        const generateSectionSummary = async (force = false, popupRef = popup) => {
          if (runtimeContextInvalid) {
            renderSectionPopup("扩展上下文已失效（通常是刚重载了插件）。请刷新当前网页后重试。", popupRef);
            return;
          }
          if (force) {
            const latest = await getArxivSummaries();
            delete latest[key];
            delete latest[errKey];
            await saveArxivSummaries(latest);
          }
          const curCache = await getArxivSummaries();
          const summary = cleanMathPlaceholders(String(curCache[key] || "").trim(), sec.text);
          if (!force && isUsableSectionSummary(summary)) {
            renderSectionPopup(summary, popupRef);
            return;
          }
          const prevErr = String(curCache[errKey] || "").trim();
          if (!force && prevErr) renderSectionPopup(`上次失败，正在重试...\n${prevErr}`, popupRef);
          if (!sectionSummaryInFlight.has(i) || force) {
            sectionSummaryInFlight.set(
              i,
              (async () => {
                const cfg = await getOpenAIConfig();
                const targetLength = Math.max(80, Math.min(1200, Number(cfg.sectionSummaryLength) || 220));
                const sectionPrompt = [
                  "你是严谨的学术论文讲解助手。",
                  "你将收到一个章节文本，请输出该章节中文概要。",
                  `要求：长度控制在 ${targetLength} 字左右（允许上下浮动20%），内容具体，不要空话。`,
                  "必须覆盖：研究问题、方法/机制、关键结果或结论、与全文关系。",
                  "请保留关键术语与符号，不要省略号，不要“本节主要介绍”这类模板句。",
                  "涉及数学表达时请使用 Markdown 数学语法（行内 $...$，块级 $$...$$）。",
                  "严禁输出任何占位符（例如 @@MATH0@@ / @@MATH_0@@）。若需要引用数学表达，直接输出公式本体。",
                  "输出纯 Markdown 正文；不要 JSON，不要代码块，不要编号前缀。"
                ].join("");
                const tokenBudget = Math.max(180, Math.min(620, Math.round(targetLength * 1.8)));
                const primaryInput = `${sec.title}\n${sec.text.slice(0, 1400)}`;
                let res = await callModelForBatchSummary([primaryInput], sectionPrompt, {
                  maxOutputTokens: tokenBudget,
                  preferFastModel: true,
                  timeoutMs: 110000
                });
                if ((!Array.isArray(res.arr) || !res.arr[0]) && /超时|timeout/i.test(String(res.error || ""))) {
                  const retryPrompt = [
                    "请输出该章节中文概要。",
                    `长度约 ${Math.min(targetLength, 320)} 字，聚焦核心方法与结论，避免套话。`,
                    "输出纯文本 Markdown，不要 JSON。"
                  ].join("");
                  const retryInput = `${sec.title}\n${sec.text.slice(0, 1000)}`;
                  res = await callModelForBatchSummary([retryInput], retryPrompt, {
                    maxOutputTokens: 320,
                    preferFastModel: true,
                    timeoutMs: 80000
                  });
                }
                const latest = await getArxivSummaries();
                if (Array.isArray(res.arr) && res.arr[0]) {
                  const generated = cleanMathPlaceholders(String(res.arr[0].summary || "").trim(), sec.text);
                  if (isUsableSectionSummary(generated)) {
                    latest[key] = generated;
                    delete latest[errKey];
                    await saveArxivSummaries(latest);
                    return generated;
                  }
                }
                delete latest[key];
                latest[errKey] = `解析失败：请检查 API Key 和模型名称是否配置正确。\n详情：${
                  res.error || "模型未返回可解析摘要"
                }`;
                await saveArxivSummaries(latest);
                return "";
              })().finally(() => sectionSummaryInFlight.delete(i))
            );
          }
          await sectionSummaryInFlight.get(i);
          const after = await getArxivSummaries();
          const summary2 = cleanMathPlaceholders(String(after[key] || "").trim(), sec.text);
          const err2 = String(after[errKey] || "").trim();
          if (isUsableSectionSummary(summary2)) {
            renderSectionPopup(summary2, popupRef);
          } else {
            renderSectionPopup(err2 || "解析失败：请检查 API Key 和模型名称是否配置正确。", popupRef);
          }
        };
        await generateSectionSummary(false, popup);
      } catch (err) {
        const msg = String(err?.message || err);
        if (/Extension context invalidated/i.test(msg)) {
          showArxivInfoPopup(
            `章节概要：${sec.title}`,
            "扩展上下文已失效（通常是刚重载了插件）。请刷新当前网页后重试。",
            event.clientX,
            event.clientY,
            { multi: true, popup, jumpTarget: sec.heading, jumpText: "定位章节" }
          );
        } else {
          showArxivInfoPopup(`章节概要：${sec.title}`, `生成失败：${msg}`, event.clientX, event.clientY, {
            multi: true,
            popup,
            jumpTarget: sec.heading,
            jumpText: "定位章节"
          });
        }
      }
    });
    sec.heading.prepend(icon);
  });

  return { sections };
}

async function annotateArxivFormulas(options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const placeholder = String(options.placeholder || "当前未生成公式讲解。点击公式前的 ƒ 图标生成。");
  const generateMissing = options.generateMissing === true;
  const force = options.force === true;
  const root = getArxivRoot();
  const formulas = collectFormulaBlocks(root);
  if (!formulas.length) {
    if (onProgress) onProgress(0, 0);
    return { ok: true, total: 0 };
  }

  const cache = await getArxivSummaries();
  const queue = [];
  let done = 0;
  let generated = 0;
  let failed = 0;
  formulas.forEach((f, i) => {
    const key = `f_${i}`;
    const errKey = summaryErrorKey("f", i);
    if (force) {
      delete cache[key];
      delete cache[errKey];
    }
    const cached = sanitizeFormulaSummary(cleanMathPlaceholders(String(cache[key] || ""), f.text));
    const initialText = isUsableFormulaSummary(cached) ? cached : placeholder;
    attachFormulaIcon(f.el, initialText, "", i);
    if (generateMissing && !isUsableFormulaSummary(cached)) queue.push({ i, el: f.el });
    else done += 1;
    if (onProgress) onProgress(done, formulas.length);
  });
  if (!generateMissing) return { ok: true, total: formulas.length };
  if (force) await saveArxivSummaries(cache);
  for (const item of queue) {
    const res = await generateSingleFormulaExplanation(item.i, item.el);
    if (res.ok) generated += 1;
    else failed += 1;
    done += 1;
    if (onProgress) onProgress(done, formulas.length);
  }
  return { ok: true, total: formulas.length, generated, failed };
}

async function generateAllFormulaExplanations(options = {}) {
  const force = options.force === true;
  return annotateArxivFormulas({
    generateMissing: true,
    force,
    onProgress: options.onProgress
  });
}

function addScholarLinksToReferences() {
  const items = Array.from(
    document.querySelectorAll("section#references li, .ltx_bibitem, ol.references li, .references li")
  );

  items.forEach((item) => {
    if (!(item instanceof HTMLElement)) return;
    if (item.querySelector(".ovr-scholar-link")) return;
    const text = (item.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;

    const a = document.createElement("a");
    a.className = "ovr-scholar-link";
    a.href = `https://scholar.google.com/scholar?q=${encodeURIComponent(text.slice(0, 240))}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Scholar";
    item.appendChild(a);
  });
}

async function runArxivSummaryWorkflow(sectionCtrl) {
  const sectionTotal = sectionCtrl?.sections?.length || 0;
  const root = getArxivRoot();
  const formulaTotal = collectFormulaBlocks(root).length;
  const cfg = await getOpenAIConfig();

  const progress = {
    sectionDone: cfg.preloadSectionSummaries ? 0 : sectionTotal,
    sectionTotal,
    formulaDone: cfg.preloadFormulaExplanations ? 0 : formulaTotal,
    formulaTotal
  };
  const render = (done = false) => {
    const doneTitle = cfg.preloadSectionSummaries || cfg.preloadFormulaExplanations ? "文章解析已完成。" : "文章章节结构与公式位置解析完成。";
    const sectionLine = cfg.preloadSectionSummaries
      ? `章节摘要预加载: ${progress.sectionDone}/${progress.sectionTotal}`
      : `章节摘要预加载: 未开启（已完成章节结构解析）`;
    const formulaLine = cfg.preloadFormulaExplanations
      ? `公式讲解预加载: ${progress.formulaDone}/${progress.formulaTotal}`
      : `公式讲解预加载: 未开启（已完成公式位置解析）`;
    const msg = [
      done ? doneTitle : "文章正在解析中...",
      sectionLine,
      formulaLine
    ].join("\n");
    showStatusToast(msg, done, done ? 3000 : 0);
  };

  render(false);
  try {
    const tasks = [];
    if (cfg.preloadSectionSummaries && sectionTotal > 0) {
      tasks.push(
        preloadSectionSummaries(sectionCtrl?.sections || [], (d, t) => {
          progress.sectionDone = d;
          progress.sectionTotal = t;
          render(false);
        })
      );
    }
    if (formulaTotal > 0) {
      tasks.push(
        annotateArxivFormulas({
          generateMissing: cfg.preloadFormulaExplanations,
          onProgress: (d, t) => {
            progress.formulaDone = d;
            progress.formulaTotal = t;
            render(false);
          }
        })
      );
    }
    const settled = await Promise.allSettled(tasks);
    const rejected = settled.find((x) => x.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      throw rejected.reason;
    }
    progress.sectionDone = progress.sectionTotal;
    progress.formulaDone = progress.formulaTotal;
    render(true);
  } catch (err) {
    showStatusToast(`文章解析失败：${String(err?.message || err)}`, false, 3200);
  }
}

async function initArxivEnhancements() {
  if (!isArxivHtmlPage()) return;
  addScholarLinksToReferences();
  const sectionCtrl = installSectionSummaryIcons();
  setTimeout(() => {
    runArxivSummaryWorkflow(sectionCtrl).catch(() => {});
  }, 120);
}

chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
  (async () => {
    if (message.type === "GET_PAGE_CONTEXT") {
      const annotations = await getAnnotations();
      sendResponse({
        ok: true,
        data: {
          title: document.title,
          url: window.location.href,
          text: (document.body?.innerText || "").slice(0, MAX_PAGE_TEXT_LENGTH),
          latestSelection: lastSelectionText,
          annotations,
          anchors: {
            sections: collectSectionAnchors(),
            references: collectReferenceAnchors(),
            figures: collectFigureAnchors(),
            tables: collectTableAnchors()
          }
        }
      });
      return;
    }

    if (message.type === "GET_SELECTION") {
      const selected = getSelectionText();
      if (selected) lastSelectionText = selected;
      sendResponse({ ok: true, data: { selection: selected || lastSelectionText } });
      return;
    }

    if (message.type === "GET_LATEST_SELECTION") {
      sendResponse({ ok: true, data: { selection: lastSelectionText } });
      return;
    }

    if (message.type === "ADD_ANNOTATION") {
      const selectedText = (message.selectedText || "").trim();
      const note = (message.note || "").trim();
      const result = await addAnnotation(selectedText, note);
      if (!result.ok) {
        sendResponse({ ok: false, error: result.message });
        return;
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ADD_ANNOTATION_FROM_SELECTION") {
      const note = (message.note || "").trim();
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim() || "";
      if (!selection || !selectedText || selection.rangeCount === 0 || selection.isCollapsed) {
        sendResponse({ ok: false, error: "请先在网页中选中文本" });
        return;
      }

      const range = selection.getRangeAt(0).cloneRange();
      const result = await addAnnotation(selectedText, note, range);
      if (!result.ok) {
        sendResponse({ ok: false, error: result.message || "写入标注失败" });
        return;
      }

      const rect = range.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        const tip = note ? `已保存并高亮。\n笔记：${note.slice(0, 120)}` : "已保存并高亮。";
        showArxivInfoPopup("标注已保存", tip, rect.left + 8, rect.bottom + 8, { multi: true });
      }

      sendResponse({ ok: true, data: { selection: selectedText } });
      return;
    }

    if (message.type === "LIST_ANNOTATIONS") {
      const annotations = await getAnnotations();
      sendResponse({ ok: true, data: { annotations } });
      return;
    }

    if (message.type === "LOCATE_ANNOTATION") {
      const id = String(message.id || "").trim();
      if (!id) {
        sendResponse({ ok: false, error: "缺少标注 id" });
        return;
      }
      const res = await locateAnnotationById(id);
      sendResponse(res.ok ? { ok: true } : { ok: false, error: res.error || "定位失败" });
      return;
    }

    if (message.type === "UPDATE_ANNOTATION") {
      const id = String(message.id || "").trim();
      const note = String(message.note || "");
      if (!id) {
        sendResponse({ ok: false, error: "缺少标注 id" });
        return;
      }
      const res = await updateAnnotationNoteById(id, note);
      sendResponse(res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error || "更新失败" });
      return;
    }

    if (message.type === "NAVIGATE_TO_ANCHOR") {
      const anchorId = String(message.anchorId || "").trim();
      if (!anchorId) {
        sendResponse({ ok: false, error: "缺少锚点 id" });
        return;
      }
      const showReturn = message.showReturn === true;
      const target = document.getElementById(anchorId);
      if (!(target instanceof HTMLElement)) {
        sendResponse({ ok: false, error: "未找到对应锚点" });
        return;
      }
      const fromX = window.scrollX;
      const fromY = window.scrollY;
      focusReferenceTarget(target);
      if (showReturn) {
        const backBtn = createReturnToNoteBtn();
        const bar = document.getElementById(RETURN_TO_NOTE_BAR_ID);
        if (bar instanceof HTMLElement) bar.style.display = "inline-flex";
        backBtn.textContent = "返回当前位置";
        backBtn.onclick = () => {
          window.scrollTo({ left: fromX, top: fromY, behavior: "smooth" });
          hideReturnToNoteBtn();
          backBtn.textContent = "返回笔记位置";
        };
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "NAVIGATE_TO_SNIPPET") {
      const snippet = sanitizeSnippetText(message.snippet || "");
      if (!snippet || snippet.length < 8) {
        sendResponse({ ok: false, error: "缺少可定位的原文片段" });
        return;
      }
      const target = findElementBySnippet(snippet);
      if (!(target instanceof HTMLElement)) {
        sendResponse({ ok: false, error: "未找到对应原文片段" });
        return;
      }
      focusReferenceTarget(target);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "DELETE_ANNOTATION") {
      const id = String(message.id || "").trim();
      if (!id) {
        sendResponse({ ok: false, error: "缺少标注 id" });
        return;
      }
      const res = await deleteAnnotationById(id);
      sendResponse(res.ok ? { ok: true } : { ok: false, error: res.error || "删除失败" });
      return;
    }

    if (message.type === "CLEAR_ANNOTATIONS") {
      const res = await clearAllAnnotations();
      sendResponse(res.ok ? { ok: true } : { ok: false, error: res.error || "清理失败" });
      return;
    }

    if (message.type === "GENERATE_SECTION_SUMMARIES_BATCH") {
      const sections = collectSectionBlocks(getArxivRoot());
      const force = message.force === true;
      const res = await preloadSectionSummaries(sections, null, { force });
      sendResponse({ ok: true, data: res || { ok: true, total: sections.length, generated: 0, failed: 0 } });
      return;
    }

    if (message.type === "GENERATE_FORMULA_EXPLANATIONS_BATCH") {
      const force = message.force === true;
      const res = await generateAllFormulaExplanations({ force });
      sendResponse({ ok: true, data: res || { ok: true, total: 0, generated: 0, failed: 0 } });
      return;
    }

    sendResponse({ ok: false, error: "未知消息类型" });
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true;
});

injectStyle();
installSelectionNotePopup();
installAnnotationHoverPreview();
renderAnnotationHighlights();
removeOutlineSidebar();
initArxivEnhancements();
