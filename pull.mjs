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

const PROMPT = `You are an aviation security (AVSEC) intelligence analyst. Search the web for the most significant aviation security developments worldwide from the last 72 hours. Cover a MIX of: security incidents/breaches (hijack, unauthorised access, drone/UAS near airports, smuggling, insider threat, screening failure, cyber attack on aviation systems), and regulatory/policy news (ICAO Annex 17 amendments, CAAM/EASA/TSA/ECAC/IATA circulars, directives or new standards). Cover the whole world.

Output ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{"briefing":"2 sentence global situation summary","items":[{"title":"short headline","category":"Incident|Regulatory|Threat|Technology","region":"Asia-Pacific|Europe|North America|Latin America|Middle East|Africa","severity":"High|Medium|Low","summary":"max 25 words — short teaser only","fullContent":"200 to 400 words — comprehensive coverage of this development: what happened, who was involved, exact timeline, scale and impact, technical details, official response, and implications for aviation security worldwide. Write in full paragraphs, not bullet points. Include all specific facts, figures, and named organisations found in search results.","source":"publication name","url":"link","date":"YYYY-MM-DD"}]}

Give exactly 6 items, most recent and most significant first. Only report developments you actually found in search results. The fullContent field must be substantive — never repeat the summary verbatim.`;

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

const keyOf = (it) =>
  ((it.title || "").trim().toLowerCase() + "||" + (it.url || "").trim().toLowerCase());

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
          days: 3
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

  const deepseekPrompt = `You are an aviation security (AVSEC) intelligence analyst. Based on the following recent web search results from the last 72 hours, identify the most significant aviation security developments worldwide.

SEARCH RESULTS:
${context}

From these results, extract and format the most significant AVSEC developments. Cover a MIX of: security incidents/breaches (hijack, unauthorised access, drone/UAS near airports, smuggling, insider threat, screening failure, cyber attack on aviation systems), and regulatory/policy news (ICAO Annex 17 amendments, CAAM/EASA/TSA/ECAC/IATA circulars, directives or new standards).

Output ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{"briefing":"2 sentence global situation summary","items":[{"title":"short headline","category":"Incident|Regulatory|Threat|Technology","region":"Asia-Pacific|Europe|North America|Latin America|Middle East|Africa","severity":"High|Medium|Low","summary":"max 25 words","source":"publication name","url":"link","date":"YYYY-MM-DD"}]}

Give up to 6 items, most recent and most significant first. Only include items found in the search results provided.`;

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
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: deepseekPrompt }],
        max_tokens: 2000,
        response_format: { type: "json_object" }
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
async function translateToBM(parsed) {
  const payload = {
    briefing: parsed.briefing || "",
    items: (parsed.items || []).map(it => ({
      title:       it.title       || "",
      summary:     it.summary     || "",
      fullContent: it.fullContent || ""
    }))
  };

  const PROMPT_BM = `You are a professional Bahasa Malaysia translator specialising in aviation security intelligence content. Translate the provided JSON fields into formal Bahasa Malaysia — as used in official Malaysian government documents and CAAM/ICAO correspondence — NOT Bahasa Indonesia.

STRICT VOCABULARY RULES — use Malaysian terms only:
- "lapangan terbang" NOT "bandara"
- "keselamatan" NOT "keamanan" (for security context)
- "syarikat" NOT "perusahaan"
- "nombor" NOT "nomor"
- "maklumat" NOT "informasi"
- "perkhidmatan" NOT "layanan"
- "pihak berkuasa" NOT "pihak berwenang"
- "wang" NOT "uang"
- "telefon" NOT "telepon"
- "pengimbas" NOT "pemindai"
- "antarabangsa" NOT "internasional"

DO NOT TRANSLATE — keep in English exactly as-is:
- Organisation names: ICAO, EASA, TSA, CAAM, FAA, FBI, NATO, Europol, Frontex, ASIS, Qantas, WestJet, Collins Aerospace
- Place names: all airports, cities, countries
- Technical acronyms: UAS, GPS, GNSS, DDoS, VPN, AI, RF
- Aviation terms: runway, taxiway, airside, NOTAM, BVLOS, TCAS, ATC
- Cybersecurity terms: ransomware, malware, phishing, spyware, cyberattack, dark web
- Regulatory references: Annex 17, Part-IS, NPRM, Section 2209, NCASP, AVSEC
- Severity/category labels: High, Medium, Low, Incident, Regulatory, Threat, Technology

TRANSLATION RULES:
1. Translate COMPLETELY — do not omit, shorten, or paraphrase differently from the original
2. Preserve all numbers, statistics, dates exactly
3. Maintain formal register — ini laporan risikan rasmi, bukan artikel popular
4. Never default to Bahasa Indonesia vocabulary under any circumstances

INPUT (JSON):
${JSON.stringify(payload, null, 2)}

OUTPUT: Return ONLY valid JSON, same structure as input. Translate ONLY these fields: briefing, title, summary, fullContent. Leave ALL other fields unchanged: category, region, severity, source, url, date. No markdown fences, no preamble, no explanation.`;

  // Cuba Claude dulu (tak perlu web search untuk terjemahan)
  if (ANTHROPIC_API_KEY) {
    try {
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
          messages: [{ role: "user", content: PROMPT_BM }],
        }),
      });
      if (r.ok) {
        const data = await r.json();
        const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
        const clean = text.replace(/```json|```/g, "").trim();
        const obj = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
        if (obj.briefing && obj.items) { console.log("Terjemahan: Claude"); return obj; }
      }
    } catch (e) { console.log("Terjemahan Claude gagal: " + e.message); }
  }

  // Fallback: Gemini
  if (GEMINI_API_KEY) {
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT_BM }] }] }),
      });
      if (r.ok) {
        const data = await r.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text || "").join("\n");
        const clean = text.replace(/```json|```/g, "").trim();
        const obj = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
        if (obj.briefing && obj.items) { console.log("Terjemahan: Gemini"); return obj; }
      }
    } catch (e) { console.log("Terjemahan Gemini gagal: " + e.message); }
  }

  console.log("Terjemahan gagal — guna English sebagai fallback");
  return payload;
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
            Full board: <a href="https://avsec-watch.netlify.app" style="color:${GOLD};text-decoration:none;">avsec-watch.netlify.app</a>
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
  store.days.forEach((d) => (d.items || []).forEach((it) => seen.add(keyOf(it))));

  // pull — Claude → Gemini (3x retry) → DeepSeek+Tavily (3x retry)
  let parsed, provider;
  try {
    parsed = await pullViaClaude();
    provider = "Claude (Sonnet 4.6)";
  } catch (e1) {
    console.log("Claude failed: " + e1.message + " — trying Gemini");
    try {
      parsed = await pullViaGemini();
      provider = "Gemini (2.5 Flash)";
    } catch (e2) {
      console.log("Gemini failed: " + e2.message + " — trying DeepSeek+Tavily");
      parsed = await pullViaDeepSeekTavily();
      provider = "DeepSeek V4-Flash + Tavily";
    }
  }
  const items = parsed.items || [];
  console.log("Provider: " + provider + " — " + items.length + " items");

  // which are genuinely new?
  const newItems = items.filter((it) => !seen.has(keyOf(it)));

  // update store (replace today's entry, keep last 366, stamp)
  store.days = store.days.filter((d) => d.date !== today);
  store.days.push({ date: today, briefing: parsed.briefing || "", items });
  store.days = store.days.slice(-366);
  store.generatedAt = new Date().toISOString();
  store.lastProvider = provider;
  writeFileSync("data.json", JSON.stringify(store, null, 2));
  console.log("data.json updated");

  // Jana data-ms.json (versi Bahasa Malaysia)
  let storeMS = { days: [] };
  if (existsSync("data-ms.json")) {
    try { storeMS = JSON.parse(readFileSync("data-ms.json", "utf8")); } catch {}
  }
  if (!Array.isArray(storeMS.days)) storeMS.days = [];

  try {
    const translated = await translateToBM(parsed);
    const msItems = (parsed.items || []).map((it, i) => ({
      ...it,
      title:       translated.items?.[i]?.title       || it.title,
      summary:     translated.items?.[i]?.summary     || it.summary,
      fullContent: translated.items?.[i]?.fullContent || it.fullContent || "",
    }));
    storeMS.days = storeMS.days.filter(d => d.date !== today);
    storeMS.days.push({ date: today, briefing: translated.briefing || parsed.briefing, items: msItems });
    storeMS.days = storeMS.days.slice(-366);
    storeMS.generatedAt  = store.generatedAt;
    storeMS.lastProvider = provider + " (terjemahan)";
    writeFileSync("data-ms.json", JSON.stringify(storeMS, null, 2));
    console.log("data-ms.json updated (BM)");
  } catch (e) {
    console.log("data-ms.json gagal: " + e.message);
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
