// AVSEC Global Watch — daily pull
// Dual provider (Claude primary, Gemini fallback) + web search.
// Sends email ONLY when there is at least one NEW item (title+url never seen before),
// regardless of severity. Quiet/duplicate days => no email. data.json written daily.

import nodemailer from "nodemailer";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const MAIL_TO            = process.env.MAIL_TO;
const DEEPSEEK_API_KEY   = process.env.DEEPSEEK_API_KEY;
const TAVILY_API_KEY     = process.env.TAVILY_API_KEY;

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuching" }); // YYYY-MM-DD

// Tentukan tetingkap masa untuk run ni — pagi (8am) ambik dari 5pm semalam,
// petang (5pm) ambik dari 8am hari ni. Guna ni untuk (a) bagitau AI dalam prompt,
// dan (b) tapis server-side lepas dapat balik hasil (jaga-jaga AI overshoot tarikh lama).
function getCutoffWindow() {
  const now = new Date();
  const kuchingHour = parseInt(now.toLocaleString("en-US", { timeZone: "Asia/Kuching", hour: "2-digit", hour12: false }));
  const isMorning = kuchingHour < 12;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kuching" });
  if (isMorning) {
    return {
      cutoffDate: yesterday, // items bertarikh < yesterday akan ditapis keluar
      cutoffLabel: yesterday + " 17:00 (5:00 PM) MYT — iaitu run petang sebelum ni",
    };
  }
  return {
    cutoffDate: today, // run petang — hanya terima berita bertarikh hari ni
    cutoffLabel: today + " 08:00 (8:00 AM) MYT — iaitu run pagi hari ni",
  };
}

// Sumber yang boleh dijadikan keutamaan carian (bukan restriction total — AI masih boleh
// cari sumber lain, ni just hint supaya carian lebih tepat sasaran untuk AVSEC).
const PRIORITY_SOURCES_HINT = `When searching, give priority to (but are not limited to) these aviation-security-relevant sources: Homeland Security Today (hstoday.us) Airport & Aviation Security section, Aviation Week / Aerospace Daily, FlightGlobal, official ICAO/IATA/EASA/TSA/CAAM/ECAC channels, and reputable national news outlets covering aviation incidents. Do not limit yourself only to these — include any credible source with genuinely new AVSEC-relevant information.`;

// Tentukan giliran provider: alternate DeepSeek/Gemini ikut hari + pagi/petang
function getProviderOrder() {
  const now = new Date();
  const kuchingHour = parseInt(now.toLocaleString("en-US", { timeZone: "Asia/Kuching", hour: "2-digit", hour12: false }));
  const dayOfMonth = parseInt(today.split("-")[2]); // 1-31
  const isMorning = kuchingHour < 12; // sebelum tengah hari = pagi
  const isEvenDay = dayOfMonth % 2 === 0;
  // Hari genap pagi → DeepSeek; genap petang → Gemini
  // Hari ganjil pagi → Gemini; ganjil petang → DeepSeek
  let useDeepSeekFirst;
  if (isEvenDay) useDeepSeekFirst = isMorning;
  else useDeepSeekFirst = !isMorning;
  const slot = isMorning ? "pagi" : "petang";
  console.log("Giliran: hari " + dayOfMonth + " (" + (isEvenDay?"genap":"ganjil") + ") " + slot + " → " + (useDeepSeekFirst ? "DeepSeek dahulu" : "Gemini dahulu"));
  return useDeepSeekFirst;
}

function buildPrompt(existingTitles) {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuching" });
  const { cutoffLabel } = getCutoffWindow();
  const excludeBlock = existingTitles && existingTitles.length
    ? `\n\nALREADY IN OUR ARCHIVE — do NOT repeat these or report the same development again. Find DIFFERENT, newer stories:\n` + existingTitles.slice(0, 40).map(t => "- " + t).join("\n")
    : "";
  return `You are an aviation security (AVSEC) intelligence analyst. Today's date is ${todayStr}. Search the web for the most RECENT and significant aviation security developments worldwide.

CRITICAL RECENCY RULES:
- This is a twice-daily briefing. ONLY include stories published SINCE ${cutoffLabel}. Anything published before that is considered ALREADY COVERED — do not include it.
- Set each item's "date" to the ACTUAL publication date you find. Do NOT guess or invent dates.
- If a story is clearly old (weeks or months ago), do NOT include it — we only want fresh news.
- Prefer breaking/recent developments over background or historical articles.

${PRIORITY_SOURCES_HINT}

Cover a MIX of: security incidents/breaches (hijack, unauthorised access, drone/UAS near airports, smuggling, insider threat, screening failure, cyber attack on aviation systems), and regulatory/policy news (ICAO Annex 17 amendments, CAAM/EASA/TSA/ECAC/IATA circulars, directives or new standards). Cover the whole world.${excludeBlock}

IMPORTANT: Respond with ONLY raw JSON starting with { and ending with }. No markdown, no explanation, no preamble. Exact structure:
{"briefing":"2 sentence global situation summary","items":[{"title":"short headline","category":"Incident|Regulatory|Threat|Technology","region":"Asia-Pacific|Europe|North America|Latin America|Middle East|Africa","severity":"High|Medium|Low","summary":"max 25 words","source":"publication name","url":"link","date":"YYYY-MM-DD"}]}

Give up to 6 items, MOST RECENT first, using the real publication date for each. Only report genuinely NEW developments from the last few days. If fewer than 6 fresh stories exist, return fewer — do NOT pad with old news.`;
}

let PROMPT = buildPrompt([]);

// Prompt berasingan untuk jana fullContent setiap item
function makeFullPrompt(item) {
  return `You are an aviation security (AVSEC) intelligence analyst writing a detailed briefing.
Write a comprehensive 200-300 word analysis of this aviation security development:

Title: ${item.title}
Category: ${item.category}
Region: ${item.region}
Date: ${item.date}
Summary: ${item.summary}
Source: ${item.source}

Write in full paragraphs covering: what happened, who was involved, timeline, scale and impact, technical details, official response, and implications for aviation security. Be factual and specific. Do NOT use bullet points. Return ONLY the analysis text, no title, no preamble.`;
}

// ---------- helpers ----------
function parseJSON(text) {
  if (!text) throw new Error("empty model text");
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("no JSON object found");
  const obj = JSON.parse(t.slice(a, b + 1));
  if (!obj.items || !Array.isArray(obj.items) || obj.items.length === 0)
    throw new Error("no items in JSON");
  return obj;
}

// Dedup guna tajuk (dinormalkan) sahaja — URL tak stabil antara provider/run
// (Gemini & Tavily bagi URL redirect unik setiap kali, jadi URL tak boleh dipakai)
const normTitle = (t) => (t || "")
  .toLowerCase()
  .replace(/[^a-z0-9 ]/g, "")   // buang tanda baca
  .replace(/\s+/g, " ")          // ringkaskan ruang
  .trim();
const keyOf = (it) => normTitle(it.title);

// Gabung (bukan ganti) entry hari yang sama — supaya run petang tak wipe out
// items yang run pagi dah simpan untuk tarikh yang sama. Dedup ikut tajuk.
function mergeDayEntry(daysArr, dateStr, briefingText, newItems) {
  const idx = daysArr.findIndex((d) => d.date === dateStr);
  if (idx === -1) {
    daysArr.push({ date: dateStr, briefing: briefingText, items: newItems });
    return daysArr;
  }
  const existingItems = daysArr[idx].items || [];
  const existingKeys = new Set(existingItems.map(keyOf));
  const toAdd = newItems.filter((it) => !existingKeys.has(keyOf(it)));
  daysArr[idx] = {
    date: dateStr,
    briefing: briefingText || daysArr[idx].briefing || "",
    items: existingItems.concat(toAdd),
  };
  return daysArr;
}

// ---------- providers ----------
async function pullViaClaude() {
  if (!ANTHROPIC_API_KEY) throw new Error("no ANTHROPIC_API_KEY");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: PROMPT }],
    }),
  });
  if (!r.ok) throw new Error("Claude HTTP " + r.status + " " + (await r.text()).slice(0, 300));
  const data = await r.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseJSON(text);
}

async function pullViaGemini() {
  if (!GEMINI_API_KEY) throw new Error("no GEMINI_API_KEY");
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    GEMINI_API_KEY;
  // retry up to 3 times on 503 (server overload — temporary)
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log("Gemini attempt " + attempt + "/3...");
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 8192 },
      }),
    });
    if (r.status === 503 && attempt < 3) {
      console.log("Gemini 503 (overloaded) — waiting 30s before retry...");
      await new Promise(res => setTimeout(res, 30000));
      continue;
    }
    if (!r.ok) throw new Error("Gemini HTTP " + r.status + " " + (await r.text()).slice(0, 300));
    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("\n");
    return parseJSON(text);
  }
  throw new Error("Gemini failed after 3 attempts (503 overload)");
}




// ---------- DeepSeek V4-Flash + Tavily (free, third fallback) ----------
async function pullViaDeepSeekTavily() {
  if (!DEEPSEEK_API_KEY) throw new Error("no DEEPSEEK_API_KEY");
  if (!TAVILY_API_KEY)   throw new Error("no TAVILY_API_KEY");

  // Step 1: Tavily searches — 3 targeted queries, last 3 days
  const queries = [
    "aviation security incident airport breach drone UAS 2026",
    "airport cyber attack ransomware aviation supply chain 2026",
    "ICAO EASA TSA CAAM aviation security regulation directive 2026"
  ];
  const allResults = [];
  for (const query of queries) {
    console.log("Tavily search: " + query.slice(0, 50) + "...");
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": "Bearer " + TAVILY_API_KEY
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: 5,
          days: 2
        })
      });
      if (!r.ok) { console.log("Tavily query failed: " + r.status); continue; }
      const data = await r.json();
      allResults.push(...(data.results || []));
    } catch (e) { console.log("Tavily error: " + e.message); }
  }
  if (allResults.length === 0) throw new Error("Tavily returned no results");
  console.log("Tavily: " + allResults.length + " results collected");

  // Step 2: Format search results as context for DeepSeek
  const context = allResults.slice(0, 12).map((r, i) =>
    "[" + (i + 1) + "] " + (r.title || "") +
    "\nSource: " + (r.url || "") +
    "\nDate: " + (r.published_date || "recent") +
    "\nContent: " + ((r.content || "").slice(0, 400))
  ).join("\n\n");

  const { cutoffLabel: dsCutoffLabel } = getCutoffWindow();
  const deepseekPrompt = `You are an aviation security (AVSEC) intelligence analyst. Today's date is ${today}. Based on the following web search results, identify the most RECENT and significant aviation security developments.

SEARCH RESULTS:
${context}

CRITICAL RECENCY RULES:
- This is a twice-daily briefing. ONLY include stories published SINCE ${dsCutoffLabel}. Anything before that is considered ALREADY COVERED.
- For each item, set "date" to the ACTUAL publication date from the search result. Do NOT guess or invent dates.
- If a story is clearly old (weeks or months ago), do NOT include it — we only want fresh news.
- Prefer breaking/recent developments over background or historical articles.

${PRIORITY_SOURCES_HINT}

Cover a MIX of: security incidents/breaches (hijack, unauthorised access, drone/UAS, smuggling, insider threat, screening failure, cyber attack), and regulatory/policy news (ICAO, CAAM, EASA, TSA, ECAC, IATA directives or standards).

IMPORTANT: Respond with ONLY raw JSON starting with { and ending with }. No markdown, no explanation, no preamble. Exact structure:
{"briefing":"2 sentence global situation summary","items":[{"title":"short headline","category":"Incident|Regulatory|Threat|Technology","region":"Asia-Pacific|Europe|North America|Latin America|Middle East|Africa","severity":"High|Medium|Low","summary":"max 25 words","source":"publication name","url":"link","date":"YYYY-MM-DD"}]}

Give up to 6 items, MOST RECENT first. Use the real publication date for each. Your entire response must be valid JSON starting with { character.`;

  // Step 3: Send to DeepSeek (with retry on 503)
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log("DeepSeek attempt " + attempt + "/3...");
    const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": "Bearer " + DEEPSEEK_API_KEY
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: deepseekPrompt }],
        max_tokens: 2000,
      })
    });
    if (r.status === 503 && attempt < 3) {
      console.log("DeepSeek 503 — waiting 30s...");
      await new Promise(res => setTimeout(res, 30000));
      continue;
    }
    if (!r.ok) throw new Error("DeepSeek HTTP " + r.status + " " + (await r.text()).slice(0, 300));
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || "";
    return parseJSON(text);
  }
  throw new Error("DeepSeek failed after 3 attempts");
}

// ---------- Terjemah ke Bahasa Malaysia ----------
const BM_RULES = `Bahasa Malaysia ONLY, NOT Bahasa Indonesia. Rules:
- "lapangan terbang" NOT "bandara"; "keselamatan" NOT "keamanan"; "syarikat" NOT "perusahaan"
- "nombor" NOT "nomor"; "maklumat" NOT "informasi"; "perkhidmatan" NOT "layanan"
- "antarabangsa" NOT "internasional"; "pihak berkuasa" NOT "pihak berwenang"
DO NOT TRANSLATE: ICAO EASA TSA CAAM FAA FBI NATO, place/airport names,
acronyms (UAS GPS GNSS DDoS RF), aviation terms (runway airside NOTAM TCAS ATC),
cyber terms (ransomware malware phishing), refs (Annex 17 Part-IS NCASP AVSEC),
severity labels (High Medium Low).`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchT(url, opts = {}, ms = 25000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(tid); }
}

async function geminiText(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (r.status === 429) {
      const wait = attempt * 8000; // 15s, 30s, 45s backoff
      console.log("Gemini 429 — tunggu " + (wait/1000) + "s sebelum retry...");
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error("Gemini HTTP " + r.status);
    const d = await r.json();
    return (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
  }
  throw new Error("Gemini HTTP 429 selepas " + retries + " percubaan");
}

async function claudeText(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("Claude HTTP " + r.status);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

async function deepseekText(prompt) {
  const r = await fetchT("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": "Bearer " + DEEPSEEK_API_KEY },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
    }),
  });
  if (!r.ok) throw new Error("DeepSeek HTTP " + r.status);
  const d = await r.json();
  return (d?.choices?.[0]?.message?.content || "").trim();
}

async function aiText(prompt) {
  // Ikut giliran yang sama macam main pull, Claude kecemasan terakhir
  const deepSeekFirst = (typeof globalThis.__deepSeekFirst === "boolean") ? globalThis.__deepSeekFirst : true;
  const tryDS = async () => { if (!DEEPSEEK_API_KEY) throw new Error("no key"); return await deepseekText(prompt); };
  const tryGM = async () => { if (!GEMINI_API_KEY) throw new Error("no key"); return await geminiText(prompt); };
  const order = deepSeekFirst ? [tryDS, tryGM] : [tryGM, tryDS];
  for (const fn of order) {
    try { return await fn(); } catch(e) { console.log("aiText provider gagal: " + e.message); }
  }
  if (ANTHROPIC_API_KEY) {
    try { return await claudeText(prompt); } catch(e) { console.log("Claude text: " + e.message); }
  }
  throw new Error("All translation providers failed");
}

async function aiJSON(prompt) {
  const raw = await aiText(prompt);
  const clean = raw.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("No JSON in response: " + raw.slice(0, 100));
  return JSON.parse(clean.slice(a, b + 1));
}

async function translateToBM(parsed) {
  // Langkah 1: Terjemah briefing + title + summary dalam satu call JSON
  const shortPayload = {
    briefing: parsed.briefing || "",
    items: (parsed.items || []).map(it => ({ title: it.title || "", summary: it.summary || "" }))
  };
  const shortPrompt = `You are a professional Bahasa Malaysia translator. ${BM_RULES}
Translate ONLY fields: briefing, title, summary. Keep ALL other fields unchanged.
Return ONLY valid JSON (no markdown, no preamble) in this exact structure:
{"briefing":"...","items":[{"title":"...","summary":"..."}]}
INPUT: ${JSON.stringify(shortPayload)}`;

  // Tunggu 20 saat supaya Gemini rate limit reset selepas main pull
  console.log("Mula terjemahan BM...");
  await sleep(5000);

  let shortResult = shortPayload;
  try {
    shortResult = await aiJSON(shortPrompt);
    console.log("Terjemahan pendek: berjaya");
  } catch(e) {
    console.log("Terjemahan pendek gagal: " + e.message + " — guna English");
  }

  // Langkah 2: Terjemah fullContent setiap item satu per satu (plain text)
  const translatedFull = [];
  for (let i = 0; i < (parsed.items || []).length; i++) {
    const fc = parsed.items[i].fullContent || parsed.items[i].summary || "";
    if (!fc) { translatedFull.push(""); continue; }
    const fcPrompt = `You are a professional Bahasa Malaysia translator. ${BM_RULES}
Translate the COMPLETE text below into formal Bahasa Malaysia.
Do NOT shorten, summarise or omit ANY details. Translate every sentence.
Return ONLY the translated Bahasa Malaysia text. No JSON, no explanation.

TEXT TO TRANSLATE:
${fc}`;
    if (i > 0) {
      console.log("Jeda 8s antara item terjemahan...");
      await sleep(4000);
    }
    try {
      const translated = await aiText(fcPrompt);
      translatedFull.push(translated);
      console.log("fullContent item " + (i+1) + ": OK (" + translated.length + " chars)");
    } catch(e) {
      console.log("fullContent item " + (i+1) + " gagal — guna English: " + e.message);
      translatedFull.push(fc);
    }
  }

  return {
    briefing: shortResult.briefing || parsed.briefing || "",
    items: (parsed.items || []).map((it, i) => ({
      title:       shortResult.items?.[i]?.title   || it.title,
      summary:     shortResult.items?.[i]?.summary || it.summary,
      fullContent: translatedFull[i]               || it.fullContent || "",
    }))
  };
}

// ---------- email (white / gold / Hornbill-red branding) ----------
const RED = "#d4242a", GOLD = "#b8901f", INK = "#15202e", MUT = "#5a6a7e";
const sevColor = (s) => (s === "High" ? "#dc2626" : s === "Medium" ? "#d97706" : "#059669");
const catColor = (c) =>
  ({ Incident: "#e23b3b", Regulatory: "#c9921f", Threat: "#ea7317", Technology: "#2563eb" }[c] || GOLD);
const esc = (s) =>
  (s == null ? "" : ("" + s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function emailHtml(briefing, items, dateStr) {
  const cards = items
    .map(
      (it) => `
    <tr><td style="padding:0 0 10px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e9f0;border-left:4px solid ${catColor(
        it.category
      )};border-radius:8px;background:#ffffff;">
        <tr><td style="padding:12px 14px;">
          <div style="font:700 11px Arial;color:${catColor(
            it.category
          )};text-transform:uppercase;letter-spacing:1px;">
            ${esc(it.category)} &nbsp;&middot;&nbsp; <span style="color:${MUT};font-weight:400;">${esc(
        it.region
      )}</span>
            <span style="float:right;color:${sevColor(it.severity)};">&#9679; ${esc(it.severity)}</span>
          </div>
          <div style="font:700 15px Arial;color:${INK};margin:6px 0 4px;">${esc(it.title)}</div>
          <div style="font:13px Arial;color:#475569;line-height:1.5;">${esc(it.summary)}</div>
          <div style="font:11px Arial;color:#94a3b8;margin-top:8px;">
            ${esc(it.date || dateStr)}${
        it.url
          ? ` &nbsp;&middot;&nbsp; <a href="${esc(it.url)}" style="color:${GOLD};text-decoration:none;">${esc(
              it.source
            )} &#8599;</a>`
          : ` &nbsp;&middot;&nbsp; ${esc(it.source)}`
      }
          </div>
        </td></tr>
      </table>
    </td></tr>`
    )
    .join("");

  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4e9cf;padding:18px 0;font-family:Arial,sans-serif;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="height:4px;background:linear-gradient(90deg,${RED},${GOLD});border-radius:8px 8px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="background:#ffffff;padding:18px 20px 6px;border:1px solid #e4e9f0;border-top:none;">
          <div style="font:700 22px 'Arial Narrow',Arial;letter-spacing:2px;color:${INK};text-transform:uppercase;">
            AVSEC <span style="color:${RED};">GLOBAL WATCH</span>
          </div>
          <div style="font:11px Arial;color:${MUT};letter-spacing:1px;margin-top:3px;">
            AVIATION SECURITY INTELLIGENCE &nbsp;&middot;&nbsp; ${esc(dateStr)}
          </div>
        </td></tr>
        <tr><td style="background:#ffffff;padding:8px 20px 16px;border:1px solid #e4e9f0;border-top:none;border-radius:0 0 8px 8px;">
          <div style="font:700 10px Arial;color:${GOLD};text-transform:uppercase;letter-spacing:2px;margin:8px 0 6px;">Daily Briefing</div>
          <div style="font:13.5px Arial;color:#334155;line-height:1.55;margin-bottom:14px;">${esc(briefing)}</div>
          <div style="font:700 10px Arial;color:${INK};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;">
            ${items.length} New Development${items.length === 1 ? "" : "s"}
          </div>
          <table width="100%" cellpadding="0" cellspacing="0">${cards}</table>
          <div style="font:10px Arial;color:#94a3b8;text-align:center;margin-top:8px;border-top:1px solid #e4e9f0;padding-top:12px;">
            Hornbill Skyways Sdn. Bhd. &middot; AVSEC Situational Awareness Board<br>
            Full board: <a href="https://sites.google.com/view/department-avsec/news-avsec" style="color:${GOLD};text-decoration:none;">AVSEC News Portal &#8599;</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

async function sendEmail(subject, html) {
  const tx = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await tx.sendMail({
    from: `"AVSEC Global Watch" <${GMAIL_USER}>`,
    to: MAIL_TO,
    subject,
    html,
  });
}

// ---------- main ----------
async function main() {
  console.log("Pulling AVSEC intel for " + today);

  // load existing store + build "seen" set BEFORE adding today
  let store = { days: [] };
  if (existsSync("data.json")) {
    try { store = JSON.parse(readFileSync("data.json", "utf8")); } catch {}
  }
  if (!Array.isArray(store.days)) store.days = [];
  const seen = new Set();
  const existingTitles = [];
  store.days.forEach((d) => (d.items || []).forEach((it) => {
    seen.add(keyOf(it));
    if (it.title) existingTitles.push(it.title);
  }));
  // Kemaskini PROMPT untuk elak ulang berita lama (tetingkap 24 jam)
  PROMPT = buildPrompt(existingTitles);

  // pull — alternate DeepSeek/Gemini ikut giliran, Claude lapisan ketiga (kecemasan)
  const deepSeekFirst = getProviderOrder();
  globalThis.__deepSeekFirst = deepSeekFirst;
  let parsed, provider;

  // Bina senarai cubaan ikut giliran
  const tryDeepSeek = async () => {
    if (!DEEPSEEK_API_KEY || !TAVILY_API_KEY) throw new Error("DeepSeek/Tavily keys not set");
    parsed = await pullViaDeepSeekTavily();
    provider = "DeepSeek V4-Flash + Tavily";
  };
  const tryGemini = async () => {
    parsed = await pullViaGemini();
    provider = "Gemini (2.5 Flash)";
  };
  const tryClaude = async () => {
    parsed = await pullViaClaude();
    provider = "Claude (Sonnet 4.6)";
  };

  const primary = deepSeekFirst ? tryDeepSeek : tryGemini;
  const secondary = deepSeekFirst ? tryGemini : tryDeepSeek;
  const primaryName = deepSeekFirst ? "DeepSeek+Tavily" : "Gemini";
  const secondaryName = deepSeekFirst ? "Gemini" : "DeepSeek+Tavily";

  try {
    await primary();
  } catch (e1) {
    console.log(primaryName + " gagal: " + e1.message + " — cuba " + secondaryName);
    try {
      await secondary();
    } catch (e2) {
      console.log(secondaryName + " gagal: " + e2.message + " — cuba Claude (kecemasan)");
      await tryClaude();
    }
  }
  let items = parsed.items || [];
  console.log("Provider: " + provider + " — " + items.length + " items (sebelum tapis tarikh)");

  // Safety-net: buang item yang tarikhnya lebih lama dari cutoff run ni,
  // walaupun AI dah diarah dalam prompt — ni jaga-jaga AI overshoot/salah tarikh.
  const { cutoffDate } = getCutoffWindow();
  const beforeFilter = items.length;
  items = items.filter((it) => !it.date || it.date >= cutoffDate);
  if (items.length < beforeFilter) {
    console.log("Tapis tarikh: buang " + (beforeFilter - items.length) + " item bertarikh sebelum " + cutoffDate);
  }
  console.log(items.length + " item selepas tapis tarikh (cutoff: " + cutoffDate + ")");

  // which are genuinely new?
  const newItems = items.filter((it) => !seen.has(keyOf(it)));

  // update store (gabung dengan entry hari ni yang sedia ada, keep last 366, stamp)
  store.days = mergeDayEntry(store.days, today, parsed.briefing || "", items);
  store.days = store.days.slice(-366);
  store.generatedAt = new Date().toISOString();
  store.lastProvider = provider;
  writeFileSync("data.json", JSON.stringify(store, null, 2));
  console.log("data.json updated");

  // ---- Jana fullContent untuk setiap item (berita penuh) ----
  console.log("Jana fullContent untuk " + items.length + " item...");
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(3000);
    try {
      const fc = await aiText(makeFullPrompt(items[i]));
      items[i].fullContent = fc;
      console.log("fullContent item " + (i+1) + ": OK (" + fc.length + " chars)");
    } catch(e) {
      items[i].fullContent = items[i].summary || "";
      console.log("fullContent item " + (i+1) + " gagal — guna summary: " + e.message);
    }
  }
  // Tulis semula data.json dengan fullContent (merge, bukan ganti)
  store.days = mergeDayEntry(store.days, today, parsed.briefing || "", items);
  store.days = store.days.slice(-366);
  store.generatedAt = new Date().toISOString();
  store.lastProvider = provider;
  writeFileSync("data.json", JSON.stringify(store, null, 2));
  console.log("data.json updated dengan fullContent");

  // ---- Jana data-ms.json (versi Bahasa Malaysia) ----
  try {
    let storeMS = { days: [] };
    if (existsSync("data-ms.json")) {
      try { storeMS = JSON.parse(readFileSync("data-ms.json", "utf8")); } catch {}
    }
    if (!Array.isArray(storeMS.days)) storeMS.days = [];

    const translated = await translateToBM({ briefing: parsed.briefing || "", items });
    const msItems = items.map((it, i) => ({
      ...it,
      title:       translated.items?.[i]?.title       || it.title,
      summary:     translated.items?.[i]?.summary     || it.summary,
      fullContent: translated.items?.[i]?.fullContent || it.fullContent || "",
    }));
    storeMS.days = mergeDayEntry(storeMS.days, today, translated.briefing || parsed.briefing || "", msItems);
    storeMS.days = storeMS.days.slice(-366);
    storeMS.generatedAt = store.generatedAt;
    storeMS.lastProvider = provider + " (terjemahan)";
    writeFileSync("data-ms.json", JSON.stringify(storeMS, null, 2));
    console.log("data-ms.json updated (BM)");

    // board-ms.json: sticky per kategori (versi BM) — banding tarikh dalam updateBoard
    const newMsItems = msItems.filter((it) => !seen.has(keyOf(it)));
    if (newMsItems.length > 0) {
      const CATS_B = ["Incident", "Regulatory", "Threat", "Technology"];
      let boardMS = { categories: {} };
      if (existsSync("board-ms.json")) {
        try { boardMS = JSON.parse(readFileSync("board-ms.json", "utf8")); } catch {}
      }
      if (!boardMS.categories) boardMS.categories = {};
      const newByCatMS = {};
      CATS_B.forEach((c) => { newByCatMS[c] = []; });
      newMsItems.forEach((it) => { if (newByCatMS[it.category]) newByCatMS[it.category].push(it); });
      const latestDateMS = (arr) => (!arr||!arr.length) ? "" : arr.reduce((m,it)=>(it.date&&it.date>m?it.date:m),"");
      CATS_B.forEach((c) => {
        if (newByCatMS[c].length === 0) return;
        const existLatest = latestDateMS(boardMS.categories[c]);
        const inLatest = latestDateMS(newByCatMS[c]);
        if (!existLatest || (inLatest && inLatest > existLatest)) {
          boardMS.categories[c] = newByCatMS[c];
        }
      });
      boardMS.briefing = translated.briefing || parsed.briefing || "";
      boardMS.generatedAt = storeMS.generatedAt;
      boardMS.lastProvider = provider + " (terjemahan)";
      writeFileSync("board-ms.json", JSON.stringify(boardMS, null, 2));
      console.log("board-ms.json updated (BM)");
    }
  } catch (e) {
    console.log("data-ms.json gagal: " + e.message);
  }



  // ========== BOARD: berita terkini setiap kategori (sticky per kategori) ==========
  // board.json simpan SATU seksyen setiap kategori. Bila ada berita baru utk kategori X,
  // ganti penuh slot X dengan berita baru. Kategori tanpa berita baru kekal.
  const CATS_BOARD = ["Incident", "Regulatory", "Threat", "Technology"];

  // Tarikh terkini dalam slot kategori sedia ada (untuk perbandingan)
  function latestDateInSlot(slotItems) {
    if (!slotItems || !slotItems.length) return "";
    return slotItems.reduce((max, it) => (it.date && it.date > max ? it.date : max), "");
  }

  function updateBoard(boardFile, allItems, briefingText) {
    let board = { categories: {} };
    if (existsSync(boardFile)) {
      try { board = JSON.parse(readFileSync(boardFile, "utf8")); } catch {}
    }
    if (!board.categories) board.categories = {};

    // Kumpul berita ikut kategori
    const newByCat = {};
    CATS_BOARD.forEach((c) => { newByCat[c] = []; });
    allItems.forEach((it) => {
      if (newByCat[it.category]) newByCat[it.category].push(it);
    });

    // Untuk setiap kategori: ganti slot HANYA jika berita baru LEBIH BARU dari yang sedia ada
    CATS_BOARD.forEach((c) => {
      if (newByCat[c].length === 0) return; // takda berita kategori ni → kekal

      const existingLatest = latestDateInSlot(board.categories[c]);
      const incomingLatest = latestDateInSlot(newByCat[c]);

      // kalau slot kosong, atau berita masuk lebih baru → ganti
      if (!existingLatest || (incomingLatest && incomingLatest > existingLatest)) {
        board.categories[c] = newByCat[c];
        console.log("  board[" + c + "] diganti → " + incomingLatest + " (lama: " + (existingLatest||"kosong") + ")");
      } else {
        console.log("  board[" + c + "] kekal → berita masuk (" + incomingLatest + ") tak lebih baru dari " + existingLatest);
      }
    });

    board.briefing = briefingText;
    board.generatedAt = new Date().toISOString();
    board.lastProvider = provider;
    writeFileSync(boardFile, JSON.stringify(board, null, 2));
    return board;
  }

  // Board: hantar semua berita baru (belum dalam arkib) ke updateBoard.
  // updateBoard akan banding tarikh — hanya ganti slot jika berita LEBIH BARU dari sedia ada.
  // Jadi board takkan mundur ke belakang; hanya bergerak ke depan.
  const newItemsForBoard = items.filter((it) => !seen.has(keyOf(it)));

  if (newItemsForBoard.length > 0) {
    console.log("Proses board dengan " + newItemsForBoard.length + " berita baru...");
    updateBoard("board.json", newItemsForBoard, parsed.briefing || "");
  } else {
    console.log("Tiada berita baru — board.json kekal");
  }

  // email ONLY if there is at least one new item (any severity)
  if (newItems.length === 0) {
    console.log("No new items today — email skipped (dashboard still updated).");
    return;
  }
  const subject = `AVSEC Global Watch — ${today} — ${newItems.length} item baru`;
  await sendEmail(subject, emailHtml(parsed.briefing || "", newItems, today));
  console.log("Email sent — " + newItems.length + " new item(s).");
}

main().catch((e) => { console.error("FATAL: " + e.message); process.exit(1); });
