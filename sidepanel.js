const STORAGE_CONFIG_KEY = "openai_config";
const STORAGE_SESSIONS_KEY = "chat_sessions_v1";
const STORAGE_ACTIVE_SESSION_KEY = "chat_active_session_v1";
const STORAGE_VECTOR_KEY = "local_vector_db_v1";
const STORAGE_POLICY_KEY = "local_storage_policy_v1";

const MAX_SESSION_MESSAGES = 200;
const VECTOR_SIM_THRESHOLD = 0.22;

const els = {
  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".panel")),
  apiKey: document.getElementById("apiKey"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  summaryModel: document.getElementById("summaryModel"),
  chatbotName: document.getElementById("chatbotName"),
  sectionSummaryLength: document.getElementById("sectionSummaryLength"),
  preloadSectionSummaries: document.getElementById("preloadSectionSummaries"),
  preloadFormulaExplanations: document.getElementById("preloadFormulaExplanations"),
  saveSettings: document.getElementById("saveSettings"),
  saveStatus: document.getElementById("saveStatus"),
  refreshAnnotations: document.getElementById("refreshAnnotations"),
  clearAnnotations: document.getElementById("clearAnnotations"),
  annotationList: document.getElementById("annotationList"),
  selectionPreview: document.getElementById("selectionPreview"),
  syncSelection: document.getElementById("syncSelection"),
  chatMessages: document.getElementById("chatMessages"),
  question: document.getElementById("question"),
  askBtn: document.getElementById("askBtn"),
  stopBtn: document.getElementById("stopBtn"),
  quickReadBtn: document.getElementById("quickReadBtn"),
  webSearchBtn: document.getElementById("webSearchBtn"),
  codeSearchBtn: document.getElementById("codeSearchBtn"),
  scholarVersionBtn: document.getElementById("scholarVersionBtn"),
  annotateFromChatBtn: document.getElementById("annotateFromChatBtn"),
  activeSessionName: document.getElementById("activeSessionName"),
  openSessions: document.getElementById("openSessions"),
  closeSessions: document.getElementById("closeSessions"),
  sessionDrawer: document.getElementById("sessionDrawer"),
  sessionList: document.getElementById("sessionList"),
  newSession: document.getElementById("newSession"),
  storageLocation: document.getElementById("storageLocation"),
  maxSessionMessages: document.getElementById("maxSessionMessages"),
  cleanupDays: document.getElementById("cleanupDays"),
  saveStoragePolicy: document.getElementById("saveStoragePolicy"),
  cleanupByDays: document.getElementById("cleanupByDays"),
  clearAllCache: document.getElementById("clearAllCache"),
  storageStatus: document.getElementById("storageStatus")
};

let sessions = [];
let activeSessionId = "";
let vectorDb = [];
let storagePolicy = null;
let latestSelectionText = "";
let assistantDisplayName = "ASSISTANT";
let currentAbortController = null;
let currentPendingNode = null;
let latestPageAnchorContext = {
  pageUrl: "",
  sections: [],
  references: [],
  figures: [],
  tables: [],
  sectionAliases: [],
  sectionLabelMap: new Map(),
  appendixLabelMap: new Map(),
  sectionIdMap: new Map(),
  figureMap: new Map(),
  tableMap: new Map(),
  referenceMap: new Map()
};

function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 9)}`;
}

function activateTab(panelId) {
  for (const btn of els.tabs) {
    btn.classList.toggle("active", btn.dataset.tab === panelId);
  }
  for (const panel of els.panels) {
    panel.classList.toggle("active", panel.id === panelId);
  }
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAlias(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSnippetText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .replace(/^[>\s]+/, "")
    .replace(/^[“"'\u201c\u201d\u2018\u2019]+/, "")
    .replace(/[“"'\u201c\u201d\u2018\u2019]+$/, "")
    .replace(/^[,.;:!?，。；：！？]+/, "")
    .replace(/[,.;:!?，。；：！？]+$/, "")
    .trim();
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
  const tokens = sectionTokensFromArxivAnchorId(anchorId);
  return tokens[0] || "";
}

function sectionTokensFromArxivAnchorId(anchorId) {
  const out = [];
  const m = String(anchorId || "").trim().match(/^S(\d+)(?:\.F(\d+))?$/i);
  if (!m) return out;
  const sec = Number(m[1]);
  const sub = Number(m[2]);
  const secRoman = toRoman(sec);
  if (!secRoman) return out;
  out.push(normalizeSectionToken(secRoman));
  if (Number.isFinite(sub) && sub > 0) {
    const letter = String.fromCharCode("A".charCodeAt(0) + Math.max(0, sub - 1));
    out.push(normalizeSectionToken(`${secRoman}-${letter}`));
  }
  return out.filter(Boolean);
}

function addSectionTokenWithParents(map, token, payload) {
  const t = normalizeSectionToken(token);
  if (!t) return;
  if (!map.has(t)) map.set(t, payload);
  const parentRoman = t.match(/^([ivxlcm]+)-[a-z]{1,3}$/i)?.[1];
  if (parentRoman && !map.has(parentRoman)) map.set(parentRoman, payload);
}

function extractSectionTokensFromTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const safeText = text.replace(/[‐‑‒–—−]/g, "-");
  const set = new Set();
  const push = (token) => {
    const t = normalizeSectionToken(token);
    if (t) set.add(t);
  };
  const lead = safeText.match(/^([IVXLCM]+(?:\s*-\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})\b/i);
  if (lead) push(lead[1]);
  for (const m of safeText.matchAll(/\b([IVXLCM]+\s*-\s*[A-Z]{1,3})\b/gi)) {
    push(m[1]);
  }
  for (const m of safeText.matchAll(
    /\b(?:section|sec\.?|章节)\s*[:：]?\s*([IVXLCM]+(?:\s*-\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})\b/gi
  )) {
    push(m[1]);
  }
  for (const m of safeText.matchAll(/\b(?:section|sec\.?|章节)\s*[:：]?\s*[IVXLCM]+\s*,\s*([IVXLCM]+\s*-\s*[A-Z]{1,3})\b/gi)) {
    push(m[1]);
  }
  for (const m of safeText.matchAll(
    /\b(?:section|sec\.?|章节)\s*[:：]?\s*((?:[IVXLCM]+(?:\s*-\s*[A-Z]{1,3})?|\d+(?:\.\d+){0,3})(?:\s*,\s*(?:[IVXLCM]+(?:\s*-\s*[A-Z]{1,3})?|\d+(?:\.\d+){0,3}))*)\b/gi
  )) {
    const list = String(m[1] || "")
      .split(/\s*,\s*/)
      .map((x) => x.trim())
      .filter(Boolean);
    list.forEach((x) => push(x));
  }
  return Array.from(set);
}

function sectionAliasCandidates(title) {
  const full = normalizeAlias(title);
  if (!full) return [];
  const set = new Set([full]);
  const stripped = full
    .replace(/^[IVXLCM]+\s*[-.:：]?\s*/i, "")
    .replace(/^\d+(?:\.\d+)*\s*[-.:：]?\s*/, "")
    .trim();
  if (stripped && stripped !== full) set.add(stripped);
  return Array.from(set).filter((x) => x.length >= 4);
}

function normalizeAppendixToken(token) {
  return String(token || "")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[(){}\[\],.;:]/g, "")
    .replace(/^appendix\s*/i, "")
    .replace(/^app\.?\s*/i, "")
    .replace(/^附录\s*[:：]?\s*/i, "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .trim();
}

function extractAppendixTokensFromTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const set = new Set();
  const push = (token) => {
    const t = normalizeAppendixToken(token);
    if (t) set.add(t);
  };
  for (const m of text.matchAll(/\b(?:Appendix|App\.?)\s*([A-Z](?:\.[0-9]+)?|[IVXLCM]{1,8})\b/gi)) {
    push(m[1]);
  }
  for (const m of text.matchAll(/附录\s*[:：]?\s*([A-Z](?:\.[0-9]+)?|[IVXLCM]{1,8})/gi)) {
    push(m[1]);
  }
  return Array.from(set);
}

function updatePageAnchorContext(page) {
  const sections = Array.isArray(page?.anchors?.sections) ? page.anchors.sections : [];
  const references = Array.isArray(page?.anchors?.references) ? page.anchors.references : [];
  const figures = Array.isArray(page?.anchors?.figures) ? page.anchors.figures : [];
  const tables = Array.isArray(page?.anchors?.tables) ? page.anchors.tables : [];
  const referenceMap = new Map();
  references.forEach((r) => {
    const idx = Number(r?.index);
    const url = String(r?.url || "").trim();
    if (!Number.isFinite(idx) || !url) return;
    if (!referenceMap.has(idx)) referenceMap.set(idx, { index: idx, url, title: String(r?.title || "") });
  });

  const sectionAliases = [];
  const sectionLabelMap = new Map();
  const appendixLabelMap = new Map();
  const sectionIdMap = new Map();
  const seen = new Set();
  sections.forEach((s) => {
    const url = String(s?.url || "").trim();
    if (!url) return;
    const title = String(s?.title || "").trim();
    const anchorId = extractAnchorIdFromUrl(url) || String(s?.id || "").trim();
    if (anchorId) {
      const key = normalizeAnchorIdToken(anchorId);
      if (!sectionIdMap.has(key)) sectionIdMap.set(key, { url, title, id: anchorId });
      sectionTokensFromArxivAnchorId(anchorId).forEach((t) => addSectionTokenWithParents(sectionLabelMap, t, { url, title }));
    }
    extractSectionTokensFromTitle(title).forEach((k) => {
      addSectionTokenWithParents(sectionLabelMap, k, { url, title });
    });
    extractAppendixTokensFromTitle(title).forEach((k) => {
      if (!appendixLabelMap.has(k)) appendixLabelMap.set(k, { url, title });
    });
    sectionAliasCandidates(s?.title).forEach((alias) => {
      const key = `${alias.toLowerCase()}|${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      sectionAliases.push({ alias, url, title: String(s?.title || "") });
    });
  });
  sectionAliases.sort((a, b) => b.alias.length - a.alias.length);

  const figureMap = new Map();
  figures.forEach((f) => {
    const idx = Number(f?.index);
    const url = String(f?.url || "").trim();
    if (!Number.isFinite(idx) || !url) return;
    if (!figureMap.has(idx)) figureMap.set(idx, { index: idx, url, title: String(f?.title || "") });
  });
  const tableMap = new Map();
  tables.forEach((t) => {
    const idx = Number(t?.index);
    const url = String(t?.url || "").trim();
    if (!Number.isFinite(idx) || !url) return;
    if (!tableMap.has(idx)) tableMap.set(idx, { index: idx, url, title: String(t?.title || "") });
  });

  latestPageAnchorContext = {
    pageUrl: String(page?.url || ""),
    sections,
    references,
    figures,
    tables,
    sectionAliases,
    sectionLabelMap,
    appendixLabelMap,
    sectionIdMap,
    figureMap,
    tableMap,
    referenceMap
  };
}

function linkifyAssistantHtml(html) {
  if (!html) return html;
  const hasSections =
    latestPageAnchorContext.sectionAliases.length > 0 ||
    latestPageAnchorContext.sectionLabelMap.size > 0 ||
    latestPageAnchorContext.appendixLabelMap.size > 0 ||
    latestPageAnchorContext.sectionIdMap.size > 0;
  const hasRefs = latestPageAnchorContext.referenceMap.size > 0;
  const hasFigures = latestPageAnchorContext.figureMap.size > 0;
  const hasTables = latestPageAnchorContext.tableMap.size > 0;
  if (!hasSections && !hasRefs && !hasFigures && !hasTables) return html;

  const host = document.createElement("div");
  host.innerHTML = html;

  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest("a, code, pre, math, script, style")) continue;
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    textNodes.push(node);
  }

  const linkCls = "ovr-context-link";
  textNodes.forEach((node) => {
    const text = String(node.nodeValue || "");
    if (!text.trim()) return;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    const pushText = (to) => {
      if (to > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, to)));
      cursor = to;
    };

    const matches = [];
    if (hasRefs) {
      const refReg = /\[(\d{1,3})\]/g;
      for (const m of text.matchAll(refReg)) {
        const idx = Number(m[1]);
        const ref = latestPageAnchorContext.referenceMap.get(idx);
        if (!ref) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: ref.url,
          title: ref.title || `参考文献 [${idx}]`,
          label: m[0]
        });
      }
    }

    if (hasSections) {
      const lower = text.toLowerCase();
      latestPageAnchorContext.sectionAliases.forEach((s) => {
        const needle = s.alias.toLowerCase();
        let at = lower.indexOf(needle);
        while (at !== -1) {
          matches.push({
            start: at,
            end: at + needle.length,
            url: s.url,
            anchorId: extractAnchorIdFromUrl(s.url),
            title: s.title || s.alias,
            label: text.slice(at, at + needle.length)
          });
          at = lower.indexOf(needle, at + needle.length);
        }
      });

      for (const m of text.matchAll(/\b(?:Section|Sec\.?)\s+([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})\b/gi)) {
        const token = normalizeSectionToken(m[1]);
        const sec = latestPageAnchorContext.sectionLabelMap.get(token);
        if (!sec) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec.url,
          anchorId: extractAnchorIdFromUrl(sec.url),
          title: sec.title || m[0],
          label: m[0]
        });
      }
      for (const m of text.matchAll(
        /\b(?:Section|Sec\.?)\s+[IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?\s*,\s*([IVXLCM]+\s*[-‐‑‒–—−]\s*[A-Z]{1,3})\b/gi
      )) {
        const token = normalizeSectionToken(m[1]);
        const sec = latestPageAnchorContext.sectionLabelMap.get(token);
        if (!sec) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec.url,
          anchorId: extractAnchorIdFromUrl(sec.url),
          title: sec.title || m[0],
          label: m[0]
        });
      }
      for (const m of text.matchAll(/章节\s*[:：]?\s*([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})/gi)) {
        const token = normalizeSectionToken(m[1]);
        const sec = latestPageAnchorContext.sectionLabelMap.get(token);
        if (!sec) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec.url,
          anchorId: extractAnchorIdFromUrl(sec.url),
          title: sec.title || m[0],
          label: m[0]
        });
      }
      for (const m of text.matchAll(/\b([IVXLCM]+\s*[-‐‑‒–—−]\s*[A-Z]{1,3})\b/g)) {
        const token = normalizeSectionToken(m[1]);
        const sec = latestPageAnchorContext.sectionLabelMap.get(token);
        if (!sec) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec.url,
          anchorId: extractAnchorIdFromUrl(sec.url),
          title: sec.title || m[0],
          label: m[0]
        });
      }
      for (const m of text.matchAll(/\b(?:Appendix|App\.?)\s*([A-Z](?:\.[0-9]+)?|[IVXLCM]{1,8})\b/gi)) {
        const token = normalizeAppendixToken(m[1]);
        const sec = latestPageAnchorContext.appendixLabelMap.get(token);
        if (!sec) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec.url,
          anchorId: extractAnchorIdFromUrl(sec.url),
          title: sec.title || m[0],
          label: m[0]
        });
      }
      for (const m of text.matchAll(/附录\s*[:：]?\s*([A-Z](?:\.[0-9]+)?|[IVXLCM]{1,8})/gi)) {
        const token = normalizeAppendixToken(m[1]);
        const sec = latestPageAnchorContext.appendixLabelMap.get(token);
        if (!sec) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec.url,
          anchorId: extractAnchorIdFromUrl(sec.url),
          title: sec.title || m[0],
          label: m[0]
        });
      }

      for (const m of text.matchAll(/#([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)/g)) {
        const token = normalizeAnchorIdToken(m[1]);
        const sec = latestPageAnchorContext.sectionIdMap.get(token);
        const anchorId = (sec?.id || String(m[1] || "").trim()).replace(/^#/, "");
        if (!anchorId) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec?.url || buildPageHashUrl(anchorId),
          anchorId,
          title: sec?.title || m[0],
          label: m[0]
        });
      }
      for (const m of text.matchAll(/\b([A-Za-z][0-9]+(?:\.[A-Za-z][0-9]+)*)\b/g)) {
        const token = normalizeAnchorIdToken(m[1]);
        const sec = latestPageAnchorContext.sectionIdMap.get(token);
        const anchorId = (sec?.id || String(m[1] || "").trim()).replace(/^#/, "");
        if (!anchorId) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: sec?.url || buildPageHashUrl(anchorId),
          anchorId,
          title: sec?.title || m[0],
          label: m[0]
        });
      }
    }

    if (hasFigures) {
      for (const m of text.matchAll(/\b(?:Figure|Fig\.?)\s*([0-9]{1,3})\b/gi)) {
        const idx = Number(m[1]);
        const fig = latestPageAnchorContext.figureMap.get(idx);
        if (!fig) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: fig.url,
          anchorId: extractAnchorIdFromUrl(fig.url),
          title: fig.title || `Figure ${idx}`,
          label: m[0]
        });
      }
      for (const m of text.matchAll(/图\s*([0-9]{1,3})/g)) {
        const idx = Number(m[1]);
        const fig = latestPageAnchorContext.figureMap.get(idx);
        if (!fig) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: fig.url,
          anchorId: extractAnchorIdFromUrl(fig.url),
          title: fig.title || `图 ${idx}`,
          label: m[0]
        });
      }
    }

    if (hasTables) {
      for (const m of text.matchAll(/\b(?:Table|Tab\.?)\s*([0-9]{1,3})\b/gi)) {
        const idx = Number(m[1]);
        const tab = latestPageAnchorContext.tableMap.get(idx);
        if (!tab) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: tab.url,
          anchorId: extractAnchorIdFromUrl(tab.url),
          title: tab.title || `Table ${idx}`,
          label: m[0]
        });
      }
      for (const m of text.matchAll(/表\s*([0-9]{1,3})/g)) {
        const idx = Number(m[1]);
        const tab = latestPageAnchorContext.tableMap.get(idx);
        if (!tab) continue;
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          url: tab.url,
          anchorId: extractAnchorIdFromUrl(tab.url),
          title: tab.title || `表 ${idx}`,
          label: m[0]
        });
      }
    }

    for (const m of text.matchAll(/[“"']([^“”"'\n]{18,220})[”"']/g)) {
      const snippet = sanitizeSnippetText(m[1]);
      if (!snippet) continue;
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        url: "#snippet",
        snippet,
        title: "定位原文片段",
        label: m[0]
      });
    }

    if (!matches.length) return;
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const chosen = [];
    let lastEnd = -1;
    for (const m of matches) {
      if (m.start < lastEnd) continue;
      chosen.push(m);
      lastEnd = m.end;
    }
    if (!chosen.length) return;

    chosen.forEach((m) => {
      pushText(m.start);
      const a = document.createElement("a");
      a.href = m.url;
      a.className = linkCls;
      const anchorId = String(m.anchorId || extractAnchorIdFromUrl(m.url) || "").trim();
      if (anchorId) a.dataset.anchorId = anchorId;
      if (m.snippet) a.dataset.snippet = String(m.snippet);
      a.title = m.title;
      a.textContent = m.label;
      frag.appendChild(a);
      cursor = m.end;
    });
    pushText(text.length);
    node.parentNode?.replaceChild(frag, node);
  });

  return host.innerHTML;
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
      // Fallback to lightweight renderer below.
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
    le: "≤",
    geq: "≥",
    ge: "≥",
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
  let raw = String(text || "").replace(/\$([^$\n]+)\$/g, (_, g1) => {
    const idx = mathTokens.length;
    mathTokens.push(`<span class="math-inline">${latexToHtml(g1)}</span>`);
    return `@@MATH_${idx}@@`;
  });
  raw = raw.replace(/(\\[A-Za-z]+(?:\{[^{}]*\})*(?:[_^](?:\{[^{}]*\}|[A-Za-z0-9\u0370-\u03FF]))*)/g, (_, g1) => {
    const idx = mathTokens.length;
    mathTokens.push(`<span class="math-inline">${latexToHtml(g1)}</span>`);
    return `@@MATH_${idx}@@`;
  });
  raw = raw.replace(/(\\\{[^{}]*\\\})/g, (_, g1) => {
    const idx = mathTokens.length;
    mathTokens.push(`<span class="math-inline">${latexToHtml(g1)}</span>`);
    return `@@MATH_${idx}@@`;
  });

  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/@@MATH_(\d+)@@/g, (_, n) => mathTokens[Number(n)] || "");
  return s;
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

function renderMarkdown(text) {
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
      blocks.push(`<pre><code class=\"language-${escapeHtml(lang || "plain")}\">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
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
      blocks.push(`<div class=\"math-block\">${latexToHtml(mathLines.join("\n"), true)}</div>`);
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
      blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n")).replace(/^<div class=\"md\">|<\/div>$/g, "")}</blockquote>`);
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

  return `<div class=\"md\">${blocks.join("") || "<p></p>"}</div>`;
}

function formatDate(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleString();
}

function getSettingsDefaults() {
  return {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    summaryModel: "gpt-4o-mini",
    chatbotName: "Assistant",
    sectionSummaryLength: 220,
    preloadSectionSummaries: false,
    preloadFormulaExplanations: true
  };
}

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_CONFIG_KEY);
  const config = data[STORAGE_CONFIG_KEY] || {};
  return {
    ...getSettingsDefaults(),
    ...config
  };
}

async function saveSettings() {
  const sectionSummaryLength = normalizePositiveInt(els.sectionSummaryLength?.value, 220, 80, 1200);
  const modelName = els.model.value.trim() || "gpt-4o-mini";
  const summaryModelName = els.summaryModel?.value.trim() || modelName;
  const config = {
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim() || "https://api.openai.com/v1",
    model: modelName,
    summaryModel: summaryModelName,
    chatbotName: (els.chatbotName?.value || "").trim() || "Assistant",
    sectionSummaryLength,
    preloadSectionSummaries: !!els.preloadSectionSummaries?.checked,
    preloadFormulaExplanations: !!els.preloadFormulaExplanations?.checked
  };
  await chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: config });
  assistantDisplayName = String(config.chatbotName || "Assistant").toUpperCase();
  if (els.sectionSummaryLength) els.sectionSummaryLength.value = String(sectionSummaryLength);
  if (els.summaryModel) els.summaryModel.value = summaryModelName;
  if (els.preloadSectionSummaries) els.preloadSectionSummaries.checked = !!config.preloadSectionSummaries;
  if (els.preloadFormulaExplanations) els.preloadFormulaExplanations.checked = !!config.preloadFormulaExplanations;
  els.saveStatus.textContent = "配置已保存";
  setTimeout(() => {
    els.saveStatus.textContent = "";
  }, 1400);
}

function getStoragePolicyDefaults() {
  return {
    maxSessionMessages: MAX_SESSION_MESSAGES,
    cleanupDays: 30
  };
}

function normalizePositiveInt(value, fallback, min, max) {
  const num = Number.parseInt(String(value), 10);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function normalizeStoragePolicy(raw) {
  const defaults = getStoragePolicyDefaults();
  return {
    maxSessionMessages: normalizePositiveInt(raw?.maxSessionMessages, defaults.maxSessionMessages, 20, 2000),
    cleanupDays: normalizePositiveInt(raw?.cleanupDays, defaults.cleanupDays, 1, 3650)
  };
}

function parseTimestamp(input) {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const ts = Date.parse(input);
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function getCurrentStoragePolicy() {
  return storagePolicy || getStoragePolicyDefaults();
}

function updateStorageStatus(message) {
  const countMessages = sessions.reduce((sum, s) => sum + ((s.messages || []).length || 0), 0);
  const summary = `会话 ${sessions.length}，消息 ${countMessages}`;
  els.storageStatus.textContent = message ? `${message}（${summary}）` : summary;
}

function hydrateStoragePolicyUI() {
  const p = getCurrentStoragePolicy();
  if (els.storageLocation) els.storageLocation.textContent = "chrome.storage.local";
  if (els.maxSessionMessages) els.maxSessionMessages.value = String(p.maxSessionMessages);
  if (els.cleanupDays) els.cleanupDays.value = String(p.cleanupDays);
}

async function loadStoragePolicy() {
  const data = await chrome.storage.local.get(STORAGE_POLICY_KEY);
  storagePolicy = normalizeStoragePolicy(data[STORAGE_POLICY_KEY] || {});
  hydrateStoragePolicyUI();
}

function getActiveSession() {
  return sessions.find((s) => s.id === activeSessionId) || null;
}

async function loadSessionsState() {
  const data = await chrome.storage.local.get([STORAGE_SESSIONS_KEY, STORAGE_ACTIVE_SESSION_KEY]);
  sessions = Array.isArray(data[STORAGE_SESSIONS_KEY]) ? data[STORAGE_SESSIONS_KEY] : [];

  if (!sessions.length) {
    sessions.push({
      id: uid("session"),
      title: "默认会话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    });
  }

  activeSessionId = data[STORAGE_ACTIVE_SESSION_KEY] || sessions[0].id;
  if (!sessions.some((s) => s.id === activeSessionId)) {
    activeSessionId = sessions[0].id;
  }

  await persistSessions();
}

async function persistSessions() {
  await chrome.storage.local.set({
    [STORAGE_SESSIONS_KEY]: sessions,
    [STORAGE_ACTIVE_SESSION_KEY]: activeSessionId
  });
}

async function loadVectorDb() {
  const data = await chrome.storage.local.get(STORAGE_VECTOR_KEY);
  vectorDb = Array.isArray(data[STORAGE_VECTOR_KEY]) ? data[STORAGE_VECTOR_KEY] : [];
}

async function persistVectorDb() {
  await chrome.storage.local.set({ [STORAGE_VECTOR_KEY]: vectorDb });
}

function sessionLabel(s) {
  return s.title || "未命名会话";
}

function isSessionEmpty(session) {
  return !Array.isArray(session?.messages) || session.messages.length === 0;
}

function pruneEmptySessions(options = {}) {
  const keepId = options.keepId || "";
  sessions = sessions.filter((s) => {
    if (!s) return false;
    if (s.id === keepId) return true;
    return !isSessionEmpty(s);
  });
  ensureAtLeastOneSession();
  if (!sessions.some((s) => s.id === activeSessionId)) {
    activeSessionId = sessions[0]?.id || "";
  }
}

function tryGetHostname(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./i, "");
  } catch (_) {
    return "";
  }
}

function summarizeForTitle(text, maxLen = 18) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

function buildConversationTitle(page, question) {
  const site = tryGetHostname(page?.url) || "未知站点";
  const pageTopic = summarizeForTitle(page?.title || "", 18) || "网页阅读";
  const qTopic = summarizeForTitle(question || "", 16) || "对话";
  const raw = `${site}｜${pageTopic}｜${qTopic}`;
  return raw.length > 52 ? `${raw.slice(0, 52)}…` : raw;
}

function getFirstSiteLabel(session) {
  const site = String(session?.firstSite || "").trim();
  if (site) return `首站: ${site}`;
  const firstUrl = String(session?.firstUrl || "").trim();
  const host = tryGetHostname(firstUrl);
  return host ? `首站: ${host}` : "首站: 未记录";
}

function renderSessionList() {
  pruneEmptySessions({ keepId: activeSessionId });
  els.sessionList.innerHTML = "";
  const ordered = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const s of ordered) {
    const li = document.createElement("li");
    li.className = `session-item ${s.id === activeSessionId ? "active" : ""}`;
    li.innerHTML = `
      <div class="session-title">${escapeHtml(sessionLabel(s))}</div>
      <div class="session-site">${escapeHtml(getFirstSiteLabel(s))}</div>
      <div class="session-meta">${escapeHtml(formatDate(s.updatedAt))}</div>
    `;
    li.addEventListener("click", async () => {
      activeSessionId = s.id;
      pruneEmptySessions({ keepId: activeSessionId });
      await persistSessions();
      renderSessionList();
      renderCurrentSessionMessages();
      els.sessionDrawer.classList.add("hidden");
    });
    els.sessionList.appendChild(li);
  }
}

function renderCurrentSessionMessages() {
  const session = getActiveSession();
  els.chatMessages.innerHTML = "";
  if (!session) return;

  els.activeSessionName.textContent = `当前会话: ${sessionLabel(session)}`;
  for (const [idx, m] of (session.messages || []).entries()) {
    appendMessage(m.role, m.content, false, idx);
  }
}

function appendMessage(role, content, persist = true, fixedIndex = null) {
  let messageIndex = fixedIndex;
  if (persist) {
    const s = getActiveSession();
    if (!s) return;
    s.messages.push({ role, content, ts: Date.now() });
    const msgLimit = getCurrentStoragePolicy().maxSessionMessages;
    if (s.messages.length > msgLimit) s.messages = s.messages.slice(-msgLimit);
    s.updatedAt = Date.now();
    persistSessions();
    messageIndex = s.messages.length - 1;
  }

  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (Number.isFinite(messageIndex)) div.dataset.msgIndex = String(messageIndex);

  const roleLabel = role === "user" ? "YOU" : role === "assistant" ? assistantDisplayName : "SYSTEM";
  let actionHtml = "";
  if (role === "user" && Number.isFinite(messageIndex)) {
    actionHtml = `<span class="msg-actions"><button class="msg-action-btn edit-question" data-edit-index="${messageIndex}" type="button">编辑</button></span>`;
  } else if (role === "assistant" && Number.isFinite(messageIndex)) {
    actionHtml = `<span class="msg-actions">
      <button class="msg-action-btn regen-answer" data-answer-index="${messageIndex}" type="button">重新生成</button>
      <button class="msg-action-btn copy-raw-md" data-raw-index="${messageIndex}" type="button">复制原始MD</button>
    </span>`;
  }
  const rendered = renderMarkdown(content);
  const enriched = role === "assistant" ? linkifyAssistantHtml(rendered) : rendered;
  div.innerHTML = `<div class=\"role\"><span>${roleLabel}</span>${actionHtml}</div><div class=\"bubble\">${enriched}</div>`;

  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    if (ta.parentElement) ta.parentElement.removeChild(ta);
  }
}

function appendPendingAssistantMessage(text = "正在生成回复") {
  const div = document.createElement("div");
  div.className = "msg assistant pending";
  div.innerHTML = `
    <div class="role">${assistantDisplayName}</div>
    <div class="bubble">
      <span class="pending-row">
        <span>${escapeHtml(text)}</span>
        <span class="pending-dots"><i></i><i></i><i></i></span>
      </span>
    </div>
  `;
  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return div;
}

function removePendingAssistantMessage(node) {
  if (!node) return;
  if (node.parentElement) node.parentElement.removeChild(node);
}

function setAskBusy(busy) {
  const isBusy = !!busy;
  if (els.askBtn) {
    els.askBtn.disabled = isBusy;
    els.askBtn.textContent = isBusy ? "生成中..." : "发送提问";
  }
  if (els.stopBtn) els.stopBtn.disabled = !isBusy;
  if (els.question) els.question.disabled = isBusy;
}

function isAbortError(err) {
  const msg = String(err?.message || err || "");
  return err?.name === "AbortError" || /aborted|aborterror|已停止|canceled|cancelled/i.test(msg);
}

function beginEditQuestion(index) {
  const s = getActiveSession();
  if (!s || !s.messages?.[index] || s.messages[index].role !== "user") return;
  const row = els.chatMessages.querySelector(`.msg.user[data-msg-index="${index}"]`);
  if (!(row instanceof HTMLElement)) return;
  const bubble = row.querySelector(".bubble");
  if (!(bubble instanceof HTMLElement)) return;

  bubble.innerHTML = `
    <div class="edit-wrap">
      <textarea class="edit-input">${escapeHtml(String(s.messages[index].content || ""))}</textarea>
      <div class="edit-actions">
        <button class="cancel-edit" type="button" data-edit-cancel="${index}">取消</button>
        <button class="save-edit" type="button" data-edit-save="${index}">保存并重新生成</button>
      </div>
    </div>
  `;
  const input = bubble.querySelector(".edit-input");
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

async function regenerateFromEditedQuestion(index, newQuestion) {
  const s = getActiveSession();
  if (!s || !s.messages?.[index] || s.messages[index].role !== "user") return;
  if (!newQuestion.trim()) return;
  if (els.askBtn?.disabled) {
    appendMessage("system", "当前正在生成，请稍后再编辑并重试。", true);
    return;
  }

  s.messages[index].content = newQuestion.trim();
  s.messages[index].ts = Date.now();
  s.messages = s.messages.slice(0, index + 1);
  s.updatedAt = Date.now();
  await persistSessions();
  renderSessionList();
  renderCurrentSessionMessages();

  const pendingNode = appendPendingAssistantMessage("已更新问题，正在重新生成");
  currentPendingNode = pendingNode;
  currentAbortController = new AbortController();
  setAskBusy(true);
  try {
    const result = await askModel(newQuestion.trim(), currentAbortController.signal);
    removePendingAssistantMessage(pendingNode);
    appendMessage("assistant", result.answer, true);
    const autoAnchor = pickFirstAnchorIdFromAnswer(result.answer);
    if (autoAnchor) {
      try {
        await navigateToAnchorFromChat(autoAnchor);
      } catch (_) {
        // Ignore auto-locate failures to avoid interrupting chat flow.
      }
    }
    await renameActiveSessionIfNeeded(newQuestion.trim(), result.page);
  } catch (err) {
    removePendingAssistantMessage(pendingNode);
    if (!isAbortError(err)) {
      appendMessage("system", String(err.message || err), true);
    }
  } finally {
    currentPendingNode = null;
    currentAbortController = null;
    setAskBusy(false);
  }
}

async function regenerateFromAssistantAnswer(index) {
  const s = getActiveSession();
  if (!s || !Array.isArray(s.messages) || !s.messages[index] || s.messages[index].role !== "assistant") return;
  let userIdx = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (s.messages[i]?.role === "user") {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) {
    appendMessage("system", "未找到可用于重新生成的上一条提问。", true);
    return;
  }
  const question = String(s.messages[userIdx].content || "").trim();
  if (!question) {
    appendMessage("system", "上一条提问为空，无法重新生成。", true);
    return;
  }
  await regenerateFromEditedQuestion(userIdx, question);
}

function getModelHistory(limit = 10) {
  const s = getActiveSession();
  if (!s) return [];
  return (s.messages || [])
    .filter((m) => ["user", "assistant", "system"].includes(m.role))
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}

async function createNewSession() {
  pruneEmptySessions({ keepId: activeSessionId });
  const now = Date.now();
  const s = {
    id: uid("session"),
    title: `会话 ${new Date(now).toLocaleDateString()} ${new Date(now).toLocaleTimeString()}`,
    createdAt: now,
    updatedAt: now,
    messages: [],
    firstUrl: "",
    firstSite: "",
    firstPageTitle: "",
    firstQuestion: ""
  };
  sessions.push(s);
  activeSessionId = s.id;
  await persistSessions();
  renderSessionList();
  renderCurrentSessionMessages();
}

async function renameActiveSessionIfNeeded(question, page) {
  const s = getActiveSession();
  if (!s) return;
  if ((s.messages || []).length > 2) return;
  if (!s.firstUrl && page?.url) s.firstUrl = String(page.url);
  if (!s.firstSite) s.firstSite = tryGetHostname(page?.url);
  if (!s.firstPageTitle && page?.title) s.firstPageTitle = String(page.title);
  if (!s.firstQuestion && question) s.firstQuestion = String(question);
  const title = buildConversationTitle(page, question);
  if (!title) return;
  s.title = title;
  s.updatedAt = Date.now();
  await persistSessions();
  renderSessionList();
  renderCurrentSessionMessages();
}

function ensureAtLeastOneSession() {
  if (sessions.length) return;
  const now = Date.now();
  sessions = [
    {
      id: uid("session"),
      title: "默认会话",
      createdAt: now,
      updatedAt: now,
      messages: []
    }
  ];
  activeSessionId = sessions[0].id;
}

function applyPolicyLimitsInMemory() {
  const p = getCurrentStoragePolicy();
  for (const s of sessions) {
    if (!Array.isArray(s.messages)) s.messages = [];
    if (s.messages.length > p.maxSessionMessages) {
      s.messages = s.messages.slice(-p.maxSessionMessages);
    }
  }
  vectorDb.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (vectorDb.length > p.maxVectors) {
    vectorDb = vectorDb.slice(0, p.maxVectors);
  }
  ensureAtLeastOneSession();
  if (!sessions.some((s) => s.id === activeSessionId)) {
    activeSessionId = sessions[0].id;
  }
}

async function saveStoragePolicyFromUi() {
  storagePolicy = normalizeStoragePolicy({
    maxVectors: els.maxVectors?.value,
    maxSessionMessages: els.maxSessionMessages?.value,
    cleanupDays: els.cleanupDays?.value
  });
  await chrome.storage.local.set({ [STORAGE_POLICY_KEY]: storagePolicy });
  hydrateStoragePolicyUI();
  applyPolicyLimitsInMemory();
  await persistSessions();
  await persistVectorDb();
  renderSessionList();
  renderCurrentSessionMessages();
  updateStorageStatus("存储策略已保存");
}

async function cleanupStorageByDays() {
  const policy = normalizeStoragePolicy({
    ...getCurrentStoragePolicy(),
    cleanupDays: els.cleanupDays?.value
  });
  storagePolicy = policy;
  await chrome.storage.local.set({ [STORAGE_POLICY_KEY]: storagePolicy });
  hydrateStoragePolicyUI();

  const cutoff = Date.now() - policy.cleanupDays * 24 * 60 * 60 * 1000;
  let removedVectors = 0;
  const beforeVectors = vectorDb.length;
  vectorDb = vectorDb.filter((item) => parseTimestamp(item.createdAt) >= cutoff);
  removedVectors = beforeVectors - vectorDb.length;

  let removedMessages = 0;
  for (const s of sessions) {
    const before = (s.messages || []).length;
    s.messages = (s.messages || []).filter((m) => parseTimestamp(m.ts) >= cutoff);
    removedMessages += before - s.messages.length;
    if (!s.messages.length && parseTimestamp(s.updatedAt) < cutoff) {
      s.updatedAt = Date.now();
    }
  }

  applyPolicyLimitsInMemory();
  await persistSessions();
  await persistVectorDb();
  renderSessionList();
  renderCurrentSessionMessages();
  updateStorageStatus(`已按 ${policy.cleanupDays} 天清理，删除消息 ${removedMessages} 条、向量 ${removedVectors} 条`);
}

async function clearAllStorageCache() {
  const ok = window.confirm("确认清空全部对话、向量记忆和当前缓存吗？此操作不可恢复。");
  if (!ok) return;

  const now = Date.now();
  const baseSession = {
    id: uid("session"),
    title: "默认会话",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  sessions = [baseSession];
  activeSessionId = baseSession.id;
  vectorDb = [];
  latestSelectionText = "";
  els.selectionPreview.textContent = "当前未检测到选中文本";
  els.chatMessages.innerHTML = "";

  await chrome.storage.local.set({
    [STORAGE_SESSIONS_KEY]: sessions,
    [STORAGE_ACTIVE_SESSION_KEY]: activeSessionId,
    [STORAGE_VECTOR_KEY]: vectorDb
  });
  renderSessionList();
  renderCurrentSessionMessages();
  updateStorageStatus("已清空历史对话与缓存");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("未找到激活标签页");
  return tabs[0];
}

function buildSearchQuery() {
  const q = String(els.question?.value || "").trim();
  if (q) return q;
  if (latestSelectionText) return latestSelectionText.slice(0, 240);
  return "";
}

async function openWebSearch() {
  const tab = await getActiveTab();
  let selection = "";
  try {
    const selectionRes = await sendToContentScript("GET_SELECTION");
    selection = String(selectionRes?.data?.selection || "").replace(/\s+/g, " ").trim();
  } catch (_) {
    // Fallback below.
  }
  const query = (selection && selection.slice(0, 240)) || String(tab.title || "").trim() || tab.url || "web search";
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  await chrome.tabs.create({ url, active: true });
  appendMessage("system", `已发起网页搜索：\n- 查询词：\`${query}\`\n- 链接：[Google 搜索](${url})`, true);
}

async function openCodeSearch() {
  const tab = await getActiveTab();
  const query = buildSearchQuery() || tab.title || "code search";
  const url = `https://github.com/search?type=code&q=${encodeURIComponent(query)}`;
  await chrome.tabs.create({ url, active: true });
  appendMessage("system", `已发起代码查询：\n- 查询词：\`${query}\`\n- 链接：[GitHub Code Search](${url})`, true);
}

function tryExtractArxivId(url) {
  const m = String(url || "").match(/arxiv\.org\/(?:abs|html|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i);
  return m?.[1] || "";
}

async function openScholarVersions() {
  const tab = await getActiveTab();
  const pageTitle = String(tab.title || "").replace(/\s*[-|]\s*arXiv.*$/i, "").trim();
  const arxivId = tryExtractArxivId(tab.url || "");
  const query = arxivId ? `arXiv:${arxivId}` : pageTitle || buildSearchQuery() || tab.url || "paper";
  const url = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en`;
  await chrome.tabs.create({ url, active: true });
  appendMessage(
    "system",
    `已打开 Google Scholar 版本入口搜索：\n- 查询词：\`${query}\`\n- 链接：[Scholar 搜索结果](${url})`,
    true
  );
}

function getLatestAssistantMessage() {
  const s = getActiveSession();
  if (!s || !Array.isArray(s.messages)) return "";
  for (let i = s.messages.length - 1; i >= 0; i -= 1) {
    const m = s.messages[i];
    if (m?.role === "assistant" && String(m.content || "").trim()) {
      return String(m.content).trim();
    }
  }
  return "";
}

async function annotateSelectionWithLatestAnswer() {
  const latestAnswer = getLatestAssistantMessage();
  if (!latestAnswer) throw new Error("当前会话还没有可用的 AI 回答。");

  const note = `【Chatbot 相关内容】\n${latestAnswer.slice(0, 4000)}`;
  const res = await sendToContentScript("ADD_ANNOTATION_FROM_SELECTION", { note });
  if (!res?.ok) throw new Error(res?.error || "写入标注失败");
  if (res?.data?.selection) {
    latestSelectionText = res.data.selection;
    if (els.selectionPreview) els.selectionPreview.textContent = latestSelectionText;
  }
  await refreshAnnotations();
  appendMessage("system", "已将最近一次回答写入当前选区标注。", true);
}

function isSupportedPage(url) {
  return !!url && /^https?:/i.test(url);
}

async function sendToContentScript(type, payload = {}) {
  const tab = await getActiveTab();
  if (!tab.id) throw new Error("当前标签页不可用");
  if (!isSupportedPage(tab.url)) {
    throw new Error("当前页面不支持读取内容，请切换到普通网页（http/https）");
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...payload });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Receiving end does not exist|Extension context invalidated/i.test(msg)) {
      throw new Error("扩展连接已失效（通常是刚重载插件）。请刷新当前网页后重试。");
    }
    throw err;
  }
}

function tokenize(text) {
  return (text.match(/[a-zA-Z0-9\u4e00-\u9fa5]{2,}/g) || []).map((x) => x.toLowerCase());
}

function pickRelevantAnnotations(question, annotations, maxItems = 20) {
  if (annotations.length <= maxItems) return annotations;
  const terms = tokenize(question);
  const scored = annotations.map((a) => {
    const source = `${a.quote || ""} ${a.note || ""}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (source.includes(term)) score += 1;
    }
    return { a, score };
  });
  scored.sort((x, y) => y.score - x.score || (y.a.createdAt || "").localeCompare(x.a.createdAt || ""));
  return scored.slice(0, maxItems).map((x) => x.a);
}

function renderAnnotations(annotations) {
  els.annotationList.innerHTML = "";
  if (!annotations.length) {
    const li = document.createElement("li");
    li.textContent = "当前页面还没有标注";
    els.annotationList.appendChild(li);
    return;
  }

  for (const item of annotations) {
    const quote = String(item.quote || "").replace(/\s+/g, " ").trim();
    const noteFirstLine = String(item.note || "")
      .split(/\r?\n/, 1)[0]
      .replace(/\s+/g, " ")
      .trim();
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="quote">${escapeHtml(quote.slice(0, 80))}</div>
      <div class="note">${escapeHtml((noteFirstLine || "(无笔记)").slice(0, 120))}</div>
      <button class="item-delete" data-id="${escapeHtml(String(item.id || ""))}" type="button">删除</button>
    `;
    li.dataset.id = item.id;
    els.annotationList.appendChild(li);
  }
}

async function syncSelection() {
  const result = await sendToContentScript("GET_SELECTION");
  if (!result?.ok) throw new Error(result?.error || "读取选区失败");
  latestSelectionText = result.data.selection || "";
  els.selectionPreview.textContent = latestSelectionText || "当前未检测到选中文本";
}

async function refreshAnnotations() {
  const result = await sendToContentScript("LIST_ANNOTATIONS");
  if (!result?.ok) throw new Error(result?.error || "读取标注失败");
  renderAnnotations(result.data.annotations || []);
}

async function clearAllAnnotations() {
  const result = await sendToContentScript("CLEAR_ANNOTATIONS");
  if (!result?.ok) throw new Error(result?.error || "清理失败");
}

async function locateAnnotationFromSidebar(id) {
  const res = await sendToContentScript("LOCATE_ANNOTATION", { id });
  if (!res?.ok) throw new Error(res?.error || "定位失败");
}

function extractAnchorIdFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return String(u.hash || "").replace(/^#/, "").trim();
  } catch (_) {
    return "";
  }
}

function buildPageHashUrl(anchorId) {
  const aid = String(anchorId || "").trim().replace(/^#/, "");
  if (!aid) return "";
  try {
    const base = String(latestPageAnchorContext.pageUrl || "").trim();
    if (base) {
      const u = new URL(base);
      u.hash = aid;
      return u.toString();
    }
  } catch (_) {
    // Ignore and fallback below.
  }
  return `#${aid}`;
}

async function navigateToAnchorFromChat(urlOrHash) {
  const anchorId = extractAnchorIdFromUrl(urlOrHash) || String(urlOrHash || "").replace(/^.*#/, "").trim();
  if (!anchorId) throw new Error("未解析到锚点");
  const res = await sendToContentScript("NAVIGATE_TO_ANCHOR", { anchorId, showReturn: false });
  if (!res?.ok) throw new Error(res?.error || "定位失败");
}

function pickFirstAnchorIdFromAnswer(answer) {
  const text = String(answer || "");
  if (!text.trim()) return "";

  const secIdMatch = text.match(/#([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)/);
  if (secIdMatch) {
    return String(secIdMatch[1] || "").trim();
  }
  const secIdBareMatch = text.match(/\b([A-Za-z][0-9]+(?:\.[A-Za-z][0-9]+)*)\b/);
  if (secIdBareMatch) {
    const sec = latestPageAnchorContext.sectionIdMap.get(normalizeAnchorIdToken(secIdBareMatch[1]));
    const secAnchor = extractAnchorIdFromUrl(sec?.url || "") || sec?.id || secIdBareMatch[1];
    if (secAnchor) return secAnchor;
  }

  // Prefer explicit references like [12]
  const refMatch = text.match(/\[(\d{1,3})\]/);
  if (refMatch) {
    const idx = Number(refMatch[1]);
    const ref = latestPageAnchorContext.referenceMap.get(idx);
    const refAnchor = extractAnchorIdFromUrl(ref?.url || "");
    if (refAnchor) return refAnchor;
  }

  const lower = text.toLowerCase();
  const figMatch = text.match(/\b(?:Figure|Fig\.?)\s*([0-9]{1,3})\b/i) || text.match(/图\s*([0-9]{1,3})/);
  if (figMatch) {
    const idx = Number(figMatch[1]);
    const fig = latestPageAnchorContext.figureMap.get(idx);
    const figAnchor = extractAnchorIdFromUrl(fig?.url || "");
    if (figAnchor) return figAnchor;
  }
  const tabMatch = text.match(/\b(?:Table|Tab\.?)\s*([0-9]{1,3})\b/i) || text.match(/表\s*([0-9]{1,3})/);
  if (tabMatch) {
    const idx = Number(tabMatch[1]);
    const tab = latestPageAnchorContext.tableMap.get(idx);
    const tabAnchor = extractAnchorIdFromUrl(tab?.url || "");
    if (tabAnchor) return tabAnchor;
  }

  const secMatch =
    text.match(/\b(?:Section|Sec\.?)\s+([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})\b/i) ||
    text.match(/章节\s*[:：]?\s*([IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?|\d+(?:\.\d+){0,3})/i);
  const secCompositeMatch = text.match(
    /\b(?:Section|Sec\.?)\s+[IVXLCM]+(?:\s*[-‐‑‒–—−]\s*[A-Z]{1,3})?(?:\.\d+)?\s*,\s*([IVXLCM]+\s*[-‐‑‒–—−]\s*[A-Z]{1,3})\b/i
  );
  if (secCompositeMatch) {
    const sec = latestPageAnchorContext.sectionLabelMap.get(normalizeSectionToken(secCompositeMatch[1]));
    const secAnchor = extractAnchorIdFromUrl(sec?.url || "");
    if (secAnchor) return secAnchor;
  }
  if (secMatch) {
    const sec = latestPageAnchorContext.sectionLabelMap.get(normalizeSectionToken(secMatch[1]));
    const secAnchor = extractAnchorIdFromUrl(sec?.url || "");
    if (secAnchor) return secAnchor;
  }
  const appendixMatch =
    text.match(/\b(?:Appendix|App\.?)\s*([A-Z](?:\.[0-9]+)?|[IVXLCM]{1,8})\b/i) ||
    text.match(/附录\s*[:：]?\s*([A-Z](?:\.[0-9]+)?|[IVXLCM]{1,8})/i);
  if (appendixMatch) {
    const sec = latestPageAnchorContext.appendixLabelMap.get(normalizeAppendixToken(appendixMatch[1]));
    const secAnchor = extractAnchorIdFromUrl(sec?.url || "");
    if (secAnchor) return secAnchor;
  }
  const secTokenOnly = text.match(/\b([IVXLCM]+\s*[-‐‑‒–—−]\s*[A-Z]{1,3})\b/i);
  if (secTokenOnly) {
    const sec = latestPageAnchorContext.sectionLabelMap.get(normalizeSectionToken(secTokenOnly[1]));
    const secAnchor = extractAnchorIdFromUrl(sec?.url || "");
    if (secAnchor) return secAnchor;
  }
  for (const s of latestPageAnchorContext.sectionAliases || []) {
    const alias = String(s?.alias || "").toLowerCase();
    if (!alias || alias.length < 4) continue;
    if (lower.includes(alias)) {
      const secAnchor = extractAnchorIdFromUrl(s.url || "");
      if (secAnchor) return secAnchor;
    }
  }
  return "";
}

function pickFirstSnippetFromAnswer(answer) {
  const text = String(answer || "");
  const m = text.match(/[“"']([^“”"'\n]{18,220})[”"']/);
  if (!m) return "";
  return sanitizeSnippetText(m[1]);
}

function getBaseUrl(baseUrl) {
  return (baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function getCandidateEndpoints(baseUrl) {
  const cleaned = getBaseUrl(baseUrl);
  if (cleaned.endsWith("/chat/completions")) return [{ mode: "chat", url: cleaned }];
  if (cleaned.endsWith("/responses")) return [{ mode: "responses", url: cleaned }];
  return [
    { mode: "responses", url: `${cleaned}/responses` },
    { mode: "chat", url: `${cleaned}/chat/completions` }
  ];
}

function getEmbeddingEndpoint(baseUrl) {
  const cleaned = getBaseUrl(baseUrl)
    .replace(/\/chat\/completions$/, "")
    .replace(/\/responses$/, "");
  return `${cleaned}/embeddings`;
}

function buildHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

function extractResponsesText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string" && c.text.trim()) chunks.push(c.text.trim());
    }
  }
  return chunks.join("\n").trim();
}

async function requestWithResponses(endpoint, settings, systemPrompt, userPrompt, signal) {
  const input = [
    { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
    ...getModelHistory(10).map((m) => ({ role: m.role, content: [{ type: "input_text", text: m.content }] })),
    { role: "user", content: [{ type: "input_text", text: userPrompt }] }
  ];

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.model, input, temperature: 0.2 }),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[responses] ${resp.status} ${text}`);
  }
  const data = await resp.json();
  const answer = extractResponsesText(data);
  if (!answer) throw new Error("[responses] 响应中没有可读文本");
  return answer;
}

async function requestWithChatCompletions(endpoint, settings, systemPrompt, userPrompt, signal) {
  const messages = [{ role: "system", content: systemPrompt }, ...getModelHistory(10), { role: "user", content: userPrompt }];
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.model, messages, temperature: 0.2 }),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[chat] ${resp.status} ${text}`);
  }
  const data = await resp.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error("[chat] 响应中没有可读文本");
  return answer;
}

async function requestModelCompletion(settings, systemPrompt, userPrompt, signal) {
  const endpoints = getCandidateEndpoints(settings.baseUrl);
  const errors = [];

  for (const item of endpoints) {
    try {
      if (item.mode === "responses") return await requestWithResponses(item.url, settings, systemPrompt, userPrompt, signal);
      return await requestWithChatCompletions(item.url, settings, systemPrompt, userPrompt, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      errors.push(`${item.mode}@${item.url} -> ${String(err.message || err)}`);
    }
  }

  throw new Error(`API 调用失败，已尝试多个端点:\n${errors.join("\n")}`);
}

async function getEmbedding(text, settings) {
  const t = String(text || "").trim();
  if (!t) return null;

  const endpoint = getEmbeddingEndpoint(settings.baseUrl);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(settings.apiKey),
      body: JSON.stringify({
        model: settings.embeddingModel || "text-embedding-3-small",
        input: t.slice(0, 8000)
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const emb = data?.data?.[0]?.embedding;
    return Array.isArray(emb) ? emb : null;
  } catch (_) {
    return null;
  }
}

function vectorNorm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  const na = vectorNorm(a);
  const nb = vectorNorm(b);
  if (!na || !nb) return -1;
  return dot / (na * nb);
}

function simpleHash(text) {
  let h = 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return `h_${Math.abs(h)}`;
}

async function addTextToVectorDb(text, settings, meta = {}) {
  const clean = String(text || "").trim();
  if (!clean) return;
  const hash = simpleHash(`${meta.source || "src"}|${meta.url || ""}|${clean.slice(0, 280)}`);
  if (vectorDb.some((x) => x.hash === hash)) return;

  const emb = await getEmbedding(clean, settings);
  if (!emb) return;

  vectorDb.push({
    id: uid("vec"),
    hash,
    embedding: emb,
    text: clean.slice(0, 2000),
    source: meta.source || "unknown",
    url: meta.url || "",
    title: meta.title || "",
    sessionId: activeSessionId,
    createdAt: Date.now()
  });
  await persistVectorDb();
}

async function ingestCurrentPage(page, settings) {
  await addTextToVectorDb(`${page.title}\n${page.url}\n${(page.text || "").slice(0, 1400)}`, settings, {
    source: "page_context",
    url: page.url,
    title: page.title
  });

  for (const ann of page.annotations || []) {
    const txt = `标注: ${ann.quote || ""}\n笔记: ${ann.note || ""}`;
    await addTextToVectorDb(txt, settings, {
      source: "annotation",
      url: page.url,
      title: page.title
    });
  }
}

async function retrieveMemories(question, settings, topK = 5) {
  const emb = await getEmbedding(question, settings);
  if (!emb) return [];

  const scored = vectorDb
    .map((item) => ({ item, score: cosineSimilarity(emb, item.embedding) }))
    .filter((x) => x.score >= VECTOR_SIM_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((x) => ({
    score: x.score,
    source: x.item.source,
    title: x.item.title,
    url: x.item.url,
    text: x.item.text
  }));
}

async function askModel(question, signal) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("请先在配置页填写 API Key");

  const contextRes = await sendToContentScript("GET_PAGE_CONTEXT");
  if (!contextRes?.ok) throw new Error(contextRes?.error || "无法读取网页内容");

  const page = contextRes.data;
  updatePageAnchorContext(page);
  if (page.latestSelection) {
    latestSelectionText = page.latestSelection;
    els.selectionPreview.textContent = latestSelectionText;
  }

  const relevantAnnotations = pickRelevantAnnotations(question, page.annotations || []);

  const promptContext = [
    `网页标题: ${page.title}`,
    `网页URL: ${page.url}`,
    "",
    "当前选中文本:",
    latestSelectionText || "无",
    "",
    "标注笔记:",
    relevantAnnotations.length
      ? relevantAnnotations
          .map((x, i) => `${i + 1}. 引用: ${x.quote}\n   笔记: ${x.note || "(无)"}\n   时间: ${x.createdAt || ""}`)
          .join("\n")
      : "无",
    "",
    "网页正文(可能截断):",
    page.text || ""
  ].join("\n");

  const systemPrompt =
    "你是论文阅读助手。请结合当前网页内容、当前选中文本和用户标注回答。输出使用 Markdown；数学公式请优先使用 $$...$$ 或 $...$。";
  const userPrompt = `问题: ${question}\n\n上下文:\n${promptContext}`;

  const answer = await requestModelCompletion(settings, systemPrompt, userPrompt, signal);

  return { answer, page };
}

function detectReadingPageType(page) {
  const url = String(page?.url || "");
  if (/arxiv\.org\/(html|abs)\//i.test(url)) return "arxiv";
  if (/medium\.com|substack\.com|dev\.to|hashnode\.com|juejin\.cn|zhihu\.com|notion\.site|wordpress/i.test(url)) return "blog";
  return "article";
}

async function quickReadCurrentPage(signal) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("请先在配置页填写 API Key");

  const contextRes = await sendToContentScript("GET_PAGE_CONTEXT");
  if (!contextRes?.ok) throw new Error(contextRes?.error || "无法读取网页内容");
  const page = contextRes.data;
  updatePageAnchorContext(page);
  const pageType = detectReadingPageType(page);

  const styleHint =
    pageType === "arxiv"
      ? "你在速读学术论文。要强调研究问题、方法、关键实验、结论与局限。"
      : "你在速读博客/技术文章。要强调核心观点、实现路径、适用场景、风险与实践建议。";

  const systemPrompt = [
    "你是高密度阅读助手，请输出“可快速决策”的中文速读稿。",
    "参考 papers.cool 常见风格：先给结论，再提炼关键点，强调证据与可执行建议。",
    "输出必须为 Markdown，数学表达尽量使用 $...$ 或 $$...$$。",
    "禁止空话、禁止泛泛总结、禁止重复原文。"
  ].join("\n");

  const userPrompt = [
    `页面类型: ${pageType}`,
    styleHint,
    "",
    "请按以下结构输出：",
    "## 30秒结论",
    "## 这篇内容在解决什么问题",
    "## 核心方法/观点（3-5点）",
    "## 证据与结果（列关键数据、实验或论据）",
    "## 局限与风险",
    "## 读者行动建议（3条）",
    "",
    "页面信息：",
    `标题: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    "",
    "正文（可能截断）：",
    String(page.text || "").slice(0, 18000)
  ].join("\n");

  const answer = await requestModelCompletion(settings, systemPrompt, userPrompt, signal);
  return { answer, page };
}

function wireUiEvents() {
  els.tabs.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  els.openSessions.addEventListener("click", () => {
    renderSessionList();
    els.sessionDrawer.classList.remove("hidden");
  });

  els.closeSessions.addEventListener("click", () => {
    els.sessionDrawer.classList.add("hidden");
  });

  els.newSession.addEventListener("click", async () => {
    await createNewSession();
    els.sessionDrawer.classList.add("hidden");
    activateTab("chatPanel");
  });

  els.saveSettings.addEventListener("click", saveSettings);
  els.saveStoragePolicy.addEventListener("click", async () => {
    try {
      await saveStoragePolicyFromUi();
    } catch (err) {
      updateStorageStatus(`保存失败: ${String(err.message || err)}`);
    }
  });
  els.cleanupByDays.addEventListener("click", async () => {
    try {
      await cleanupStorageByDays();
    } catch (err) {
      updateStorageStatus(`清理失败: ${String(err.message || err)}`);
    }
  });
  els.clearAllCache.addEventListener("click", async () => {
    try {
      await clearAllStorageCache();
    } catch (err) {
      updateStorageStatus(`清空失败: ${String(err.message || err)}`);
    }
  });

  els.syncSelection.addEventListener("click", async () => {
    try {
      await syncSelection();
    } catch (err) {
      appendMessage("system", String(err.message || err));
    }
  });

  els.refreshAnnotations.addEventListener("click", async () => {
    try {
      await refreshAnnotations();
    } catch (err) {
      appendMessage("system", String(err.message || err));
    }
  });
  els.clearAnnotations?.addEventListener("click", async () => {
    const ok = window.confirm("确认一键清理当前页面的全部标注吗？");
    if (!ok) return;
    try {
      await clearAllAnnotations();
      await refreshAnnotations();
      appendMessage("system", "已清理当前页面全部标注。", true);
    } catch (err) {
      appendMessage("system", String(err.message || err), true);
    }
  });

  els.annotationList.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const locateBtn = target.closest("button.locate[data-id]");
    if (locateBtn instanceof HTMLElement) {
      const id = String(locateBtn.dataset.id || "").trim();
      if (!id) return;
      try {
        await locateAnnotationFromSidebar(id);
      } catch (err) {
        appendMessage("system", String(err.message || err), true);
      }
      return;
    }

    const deleteBtn = target.closest("button.item-delete[data-id], button.delete[data-id]");
    if (deleteBtn instanceof HTMLElement) {
      const id = String(deleteBtn.dataset.id || "").trim();
      if (!id) return;
      const ok = window.confirm("确认删除这条标注吗？");
      if (!ok) return;
      const res = await sendToContentScript("DELETE_ANNOTATION", { id });
      if (!res?.ok) {
        appendMessage("system", res?.error || "删除失败");
        return;
      }
      await refreshAnnotations();
      return;
    }

    const item = target.closest("li[data-id]");
    if (item instanceof HTMLElement) {
      const id = String(item.dataset.id || "").trim();
      if (!id) return;
      try {
        await locateAnnotationFromSidebar(id);
      } catch (err) {
        appendMessage("system", String(err.message || err), true);
      }
    }
  });

  els.chatMessages.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const link = target.closest("a.ovr-context-link");
    if (link instanceof HTMLAnchorElement) {
      e.preventDefault();
      try {
        const snippet = sanitizeSnippetText(link.dataset.snippet || "");
        if (snippet) {
          const res = await sendToContentScript("NAVIGATE_TO_SNIPPET", { snippet });
          if (!res?.ok) throw new Error(res?.error || "定位原文片段失败");
          return;
        }
        const anchorId = String(link.dataset.anchorId || "").trim();
        if (anchorId) await navigateToAnchorFromChat(anchorId);
      } catch (err) {
        appendMessage("system", String(err.message || err), true);
      }
      return;
    }

    const editBtn = target.closest(".edit-question");
    if (editBtn instanceof HTMLElement) {
      const idx = Number.parseInt(editBtn.dataset.editIndex || "", 10);
      if (Number.isFinite(idx)) beginEditQuestion(idx);
      return;
    }

    const regenBtn = target.closest(".regen-answer");
    if (regenBtn instanceof HTMLElement) {
      const idx = Number.parseInt(regenBtn.dataset.answerIndex || "", 10);
      if (!Number.isFinite(idx)) return;
      await regenerateFromAssistantAnswer(idx);
      return;
    }

    const copyRawBtn = target.closest(".copy-raw-md");
    if (copyRawBtn instanceof HTMLElement) {
      const idx = Number.parseInt(copyRawBtn.dataset.rawIndex || "", 10);
      const s = getActiveSession();
      const raw = Number.isFinite(idx) && s?.messages?.[idx] ? String(s.messages[idx].content || "") : "";
      if (!raw.trim()) {
        appendMessage("system", "未找到可复制的原始 Markdown 文本。", true);
        return;
      }
      try {
        await copyTextToClipboard(raw);
        appendMessage("system", "已复制该条回答的原始 Markdown。", true);
      } catch (err) {
        appendMessage("system", `复制失败: ${String(err?.message || err)}`, true);
      }
      return;
    }

    const cancelBtn = target.closest(".cancel-edit");
    if (cancelBtn instanceof HTMLElement) {
      renderCurrentSessionMessages();
      return;
    }

    const saveBtn = target.closest(".save-edit");
    if (saveBtn instanceof HTMLElement) {
      const idx = Number.parseInt(saveBtn.dataset.editSave || "", 10);
      if (!Number.isFinite(idx)) return;
      const row = saveBtn.closest(".msg.user");
      const input = row?.querySelector(".edit-input");
      const value = input instanceof HTMLTextAreaElement ? input.value : "";
      await regenerateFromEditedQuestion(idx, value);
    }
  });

  const submitAsk = async () => {
    if (els.askBtn.disabled) return;
    const question = String(els.question?.value || "").trim();
    if (!question) return;

    els.question.value = "";
    appendMessage("user", question, true);
    const pendingNode = appendPendingAssistantMessage("请求已发送，正在生成");
    currentPendingNode = pendingNode;
    currentAbortController = new AbortController();
    setAskBusy(true);

    try {
      const result = await askModel(question, currentAbortController.signal);
      removePendingAssistantMessage(pendingNode);
      appendMessage("assistant", result.answer, true);
      const autoAnchor = pickFirstAnchorIdFromAnswer(result.answer);
      if (autoAnchor) {
        try {
          await navigateToAnchorFromChat(autoAnchor);
        } catch (_) {
          // Ignore auto-locate failures to avoid interrupting chat flow.
        }
      }
      await renameActiveSessionIfNeeded(question, result.page);
    } catch (err) {
      removePendingAssistantMessage(pendingNode);
      if (!isAbortError(err)) {
        appendMessage("system", String(err.message || err), true);
      }
    } finally {
      currentPendingNode = null;
      currentAbortController = null;
      setAskBusy(false);
    }
  };

  els.askBtn.addEventListener("click", submitAsk);
  els.question?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return; // Shift+Enter keeps newline behavior.
    if (event.isComposing || event.keyCode === 229) return; // Avoid IME composition enter.
    event.preventDefault();
    submitAsk();
  });

  els.quickReadBtn?.addEventListener("click", async () => {
    if (els.askBtn?.disabled) return;
    const pendingNode = appendPendingAssistantMessage("正在生成一键速读概要");
    currentPendingNode = pendingNode;
    currentAbortController = new AbortController();
    setAskBusy(true);
    try {
      const result = await quickReadCurrentPage(currentAbortController.signal);
      removePendingAssistantMessage(pendingNode);
      appendMessage("assistant", result.answer, true);
      const autoAnchor = pickFirstAnchorIdFromAnswer(result.answer);
      if (autoAnchor) {
        try {
          await navigateToAnchorFromChat(autoAnchor);
        } catch (_) {
          // Ignore auto-locate failures to avoid interrupting chat flow.
        }
      }
      await renameActiveSessionIfNeeded(`速读 ${result.page?.title || ""}`.trim(), result.page);
    } catch (err) {
      removePendingAssistantMessage(pendingNode);
      if (!isAbortError(err)) {
        appendMessage("system", String(err.message || err), true);
      }
    } finally {
      currentPendingNode = null;
      currentAbortController = null;
      setAskBusy(false);
    }
  });

  els.stopBtn?.addEventListener("click", () => {
    if (!currentAbortController) return;
    currentAbortController.abort("manual_stop");
    if (currentPendingNode) {
      removePendingAssistantMessage(currentPendingNode);
      currentPendingNode = null;
    }
    currentAbortController = null;
    setAskBusy(false);
    appendMessage("system", "已停止本次生成。", true);
  });

  els.webSearchBtn?.addEventListener("click", async () => {
    try {
      await openWebSearch();
    } catch (err) {
      appendMessage("system", String(err.message || err), true);
    }
  });

  els.codeSearchBtn?.addEventListener("click", async () => {
    try {
      await openCodeSearch();
    } catch (err) {
      appendMessage("system", String(err.message || err), true);
    }
  });

  els.scholarVersionBtn?.addEventListener("click", async () => {
    try {
      await openScholarVersions();
    } catch (err) {
      appendMessage("system", String(err.message || err), true);
    }
  });

  els.annotateFromChatBtn?.addEventListener("click", async () => {
    try {
      await annotateSelectionWithLatestAnswer();
    } catch (err) {
      appendMessage("system", String(err.message || err), true);
    }
  });
}

async function init() {
  const settings = await getSettings();
  if (els.apiKey) els.apiKey.value = settings.apiKey || "";
  if (els.baseUrl) els.baseUrl.value = settings.baseUrl || "https://api.openai.com/v1";
  if (els.model) els.model.value = settings.model || "gpt-4o-mini";
  if (els.summaryModel) els.summaryModel.value = settings.summaryModel || settings.model || "gpt-4o-mini";
  if (els.chatbotName) els.chatbotName.value = settings.chatbotName || "Assistant";
  if (els.sectionSummaryLength) {
    els.sectionSummaryLength.value = String(normalizePositiveInt(settings.sectionSummaryLength, 220, 80, 1200));
  }
  if (els.preloadSectionSummaries) els.preloadSectionSummaries.checked = !!settings.preloadSectionSummaries;
  if (els.preloadFormulaExplanations) els.preloadFormulaExplanations.checked = !!settings.preloadFormulaExplanations;
  assistantDisplayName = String(settings.chatbotName || "Assistant").toUpperCase();

  await loadStoragePolicy();
  await loadSessionsState();
  pruneEmptySessions({ keepId: activeSessionId });
  await loadVectorDb();
  applyPolicyLimitsInMemory();
  await persistSessions();
  await persistVectorDb();

  wireUiEvents();
  renderSessionList();
  renderCurrentSessionMessages();
  updateStorageStatus("");

  try {
    const pageRes = await sendToContentScript("GET_PAGE_CONTEXT");
    if (pageRes?.ok) updatePageAnchorContext(pageRes.data || {});
    await syncSelection();
    await refreshAnnotations();
    renderCurrentSessionMessages();
  } catch (err) {
    appendMessage("system", String(err.message || err), false);
  }
}

init().catch((err) => {
  appendMessage("system", `初始化失败: ${err.message || err}`, false);
});
