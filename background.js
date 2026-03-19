chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.url && /^https?:/i.test(tab.url)) {
    chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
  }
});

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

function getSummaryEndpoints(baseUrl, modelName) {
  const cleaned = getBaseUrl(baseUrl);
  const endpoints = [];
  const push = (mode, url) => {
    if (!url) return;
    if (endpoints.some((x) => x.mode === mode && x.url === url)) return;
    endpoints.push({ mode, url });
  };

  if (cleaned.endsWith("/chat/completions")) {
    push("chat", cleaned);
    const root = cleaned.replace(/\/chat\/completions$/, "");
    push("responses", `${root}/responses`);
    return endpoints;
  }
  if (cleaned.endsWith("/responses")) {
    push("responses", cleaned);
    const root = cleaned.replace(/\/responses$/, "");
    push("chat", `${root}/chat/completions`);
    return endpoints;
  }

  const model = String(modelName || "").toLowerCase();
  const isOfficialOpenAI = /api\.openai\.com/i.test(cleaned);
  const preferChatFirst = model.includes("qwen") || !isOfficialOpenAI;

  if (preferChatFirst) {
    push("chat", `${cleaned}/chat/completions`);
    push("responses", `${cleaned}/responses`);
  } else {
    push("responses", `${cleaned}/responses`);
    push("chat", `${cleaned}/chat/completions`);
  }

  // Extra compatibility candidates for users who fill baseUrl without /v1
  // or providers with alias routes.
  if (/\/v1$/i.test(cleaned)) {
    const noV1 = cleaned.replace(/\/v1$/i, "");
    push("chat", `${noV1}/chat/completions`);
    push("responses", `${noV1}/responses`);
  } else {
    push("chat", `${cleaned}/v1/chat/completions`);
    push("responses", `${cleaned}/v1/responses`);
  }
  return endpoints;
}

function tryParseJsonArray(str) {
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function extractJsonArray(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;

  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj?.items)) return obj.items;
  } catch (_) {}

  // Prefer fenced JSON blocks first.
  const fenceMatches = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fenceMatches) {
    const inner = String(block)
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    const arr = tryParseJsonArray(inner);
    if (arr) return arr;
    try {
      const obj = JSON.parse(inner);
      if (Array.isArray(obj?.items)) return obj.items;
    } catch (_) {}
  }

  // Balanced scan: try every bracketed segment, avoiding greedy over-capture.
  const starts = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === "\"") {
        inStr = false;
      }
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      continue;
    }
    if (ch === "[") starts.push(i);
    if (ch === "]" && starts.length) {
      const start = starts.pop();
      const candidate = raw.slice(start, i + 1).trim();
      const arr = tryParseJsonArray(candidate);
      if (arr) return arr;
    }
  }
  return null;
}

function parseSummaryItems(text, expectedCount = 1) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const arr = extractJsonArray(raw);
  if (Array.isArray(arr) && arr.length) return arr;

  const cleaned = raw
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .trim();
  if (!cleaned) return null;
  if (expectedCount <= 1) return [{ i: 1, summary: cleaned }];

  const lines = cleaned
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)[\).、：:\-\s]+(.+)$/);
    if (m) items.push({ i: Number(m[1]), summary: m[2].trim() });
  }
  return items.length ? items : null;
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

async function fetchWithTimeout(url, options, timeoutMs = 120000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getOpenAIConfig() {
  const data = await chrome.storage.local.get("openai_config");
  const cfg = data.openai_config || {};
  const model = cfg.model || "gpt-4o-mini";
  return {
    apiKey: cfg.apiKey || "",
    baseUrl: cfg.baseUrl || "https://api.openai.com/v1",
    model,
    summaryModel: cfg.summaryModel || model
  };
}

async function handleSummaryRequest(message) {
  const cfg = await getOpenAIConfig();
  if (!cfg.apiKey) return { ok: false, error: "未配置 API Key" };
  const inputs = Array.isArray(message.inputs) ? message.inputs : [];
  const systemPrompt = String(message.systemPrompt || "").trim();
  if (!inputs.length || !systemPrompt) return { ok: false, error: "请求参数缺失" };

  const usr = inputs.map((p, i) => `${i + 1}. ${String(p || "")}`).join("\n\n");
  const errors = [];
  const maxOutputTokens = Math.max(120, Math.min(12000, Number(message.maxOutputTokens) || 360));
  const modelCandidates = Array.from(
    new Set([String(cfg.summaryModel || "").trim(), String(cfg.model || "").trim()].filter(Boolean))
  );

  for (const model of modelCandidates) {
    const endpoints = getSummaryEndpoints(cfg.baseUrl, model);
    for (const ep of endpoints) {
    try {
      if (ep.mode === "responses") {
        const input = [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: usr }] }
        ];
        const resp2 = await fetchWithTimeout(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model, input, temperature: 0.2, max_output_tokens: maxOutputTokens })
        });
        if (!resp2.ok) {
          errors.push(`[responses:${model}] ${resp2.status} ${ep.url} ${await resp2.text()}`);
          continue;
        }
        const data = await resp2.json();
        const txt = extractResponsesText(data) || "";
        const arr = parseSummaryItems(txt, inputs.length);
        if (arr) return { ok: true, data: arr };
        errors.push(`[responses:${model}] 无法解析摘要文本 @ ${ep.url}`);
      } else {
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: usr }
        ];
        const resp = await fetchWithTimeout(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxOutputTokens })
        });
        if (!resp.ok) {
          errors.push(`[chat:${model}] ${resp.status} ${ep.url} ${await resp.text()}`);
          continue;
        }
        const data = await resp.json();
        const txt = data?.choices?.[0]?.message?.content || "";
        const arr = parseSummaryItems(txt, inputs.length);
        if (arr) return { ok: true, data: arr };
        errors.push(`[chat:${model}] 无法解析摘要文本 @ ${ep.url}`);
      }
    } catch (err) {
      errors.push(`[${ep.mode}:${model}] ${ep.url} ${String(err?.message || err)}`);
    }
  }
  }
  return { ok: false, error: errors.join("\n").slice(0, 1200) || "摘要生成失败" };
}

chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
  if (message?.type !== "OVR_SUMMARY_REQUEST") return false;
  (async () => {
    const res = await handleSummaryRequest(message);
    sendResponse(res);
  })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
