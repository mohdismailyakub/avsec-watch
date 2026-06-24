import { readFileSync, writeFileSync, existsSync } from "node:fs";
import nodemailer from "nodemailer";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

const PROMPT = `You are an aviation security (AVSEC) intelligence analyst. Search the web for the most significant aviation security developments worldwide from the last 72 hours. Cover a MIX of: security incidents/breaches (hijack, unauthorised access, drone/UAS near airports, smuggling, insider threat, screening failure, cyber attack on aviation systems), and regulatory/policy news (ICAO Annex 17 amendments, CAAM/EASA/TSA/ECAC/IATA circulars, directives or new standards). Cover the whole world.

Return ONLY valid JSON, no markdown, no preamble, in this exact shape:
{"briefing":"2 sentence global situation summary","items":[{"title":"short headline","category":"Incident|Regulatory|Threat|Technology","region":"Asia-Pacific|Europe|North America|Latin America|Middle East|Africa","severity":"High|Medium|Low","summary":"max 25 words","source":"publication name","url":"link","date":"YYYY-MM-DD"}]}

Give exactly 6 items, most recent and most significant first. Be factual; only report developments you actually found in search results.`;

async function pullIntel() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      messages: [{ role: "user", content: PROMPT }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error("API error: " + JSON.stringify(data.error));
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON found in model response");
  return JSON.parse(text.slice(s, e + 1));
}

function updateStore(parsed, today) {
  let store = { days: [] };
  if (existsSync("data.json")) {
    try { store = JSON.parse(readFileSync("data.json", "utf8")); } catch {}
  }
  if (!Array.isArray(store.days)) store.days = [];
  store.days = store.days.filter((d) => d.date !== today); // replace if re-run same day
  store.days.push({ date: today, briefing: parsed.briefing, items: parsed.items });
  store.days = store.days.slice(-30); // keep last 30 days for the trend
  store.generatedAt = new Date().toISOString();
  writeFileSync("data.json", JSON.stringify(store, null, 2));
}

/* ---------- email rendering (light, table-based for client safety) ---------- */
const sevColor = (s) => (s === "High" ? "#ef4444" : s === "Medium" ? "#f59e0b" : "#34d399");
const catColor = (c) => ({ Incident: "#ef4444", Regulatory: "#c9a227", Threat: "#f97316", Technology: "#38bdf8" }[c] || "#c9a227");
const esc = (s) => (s == null ? "" : ("" + s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function emailHtml(parsed, today) {
  const cards = (parsed.items || []).map((it) => `
    <tr><td style="padding:0 0 10px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-left:4px solid ${catColor(it.category)};border-radius:6px;">
        <tr><td style="padding:12px 14px;">
          <div style="font:600 11px Arial;color:${catColor(it.category)};text-transform:uppercase;letter-spacing:1px;">
            ${esc(it.category)} &nbsp;·&nbsp; <span style="color:#64748b;">${esc(it.region)}</span>
            <span style="float:right;color:${sevColor(it.severity)};">&#9679; ${esc(it.severity)}</span>
          </div>
          <div style="font:600 15px Arial;color:#0f1c2e;margin:6px 0 4px;">${esc(it.title)}</div>
          <div style="font:13px Arial;color:#475569;line-height:1.5;">${esc(it.summary)}</div>
          <div style="font:11px Arial;color:#94a3b8;margin-top:8px;">
            ${esc(it.date || today)}${it.url ? ` &nbsp;·&nbsp; <a href="${esc(it.url)}" style="color:#c9a227;text-decoration:none;">${esc(it.source)}</a>` : ` &nbsp;·&nbsp; ${esc(it.source)}`}
          </div>
        </td></tr>
      </table>
    </td></tr>`).join("");

  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:18px 0;font-family:Arial,sans-serif;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="background:#0f1c2e;border-radius:8px 8px 0 0;padding:16px 18px;">
          <div style="font:700 18px Arial;color:#ffffff;letter-spacing:1px;">AVSEC <span style="color:#c9a227;">GLOBAL WATCH</span></div>
          <div style="font:11px Arial;color:#7d94ac;margin-top:4px;">HSSB &middot; KCH/MYY &middot; ${esc(today)}</div>
        </td></tr>
        <tr><td style="background:#ffffff;padding:16px 18px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;">
          <div style="font:600 10px Arial;color:#c9a227;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;">Daily Briefing</div>
          <div style="font:13.5px Arial;color:#334155;line-height:1.55;margin-bottom:14px;">${esc(parsed.briefing)}</div>
          <table width="100%" cellpadding="0" cellspacing="0">${cards}</table>
          <div style="font:10px Arial;color:#94a3b8;text-align:center;margin-top:8px;border-top:1px solid #e2e8f0;padding-top:12px;">
            Auto-generated &middot; Full board: <a href="https://avsec-watch.netlify.app" style="color:#c9a227;text-decoration:none;">avsec-watch.netlify.app</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

async function sendEmail(parsed, today) {
  const t = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await t.sendMail({
    from: `"HSSB AVSEC Watch" <${process.env.GMAIL_USER}>`,
    to: process.env.MAIL_TO,
    subject: `AVSEC Global Watch — ${today}`,
    html: emailHtml(parsed, today),
  });
}

(async () => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuching" });
  console.log("Pulling AVSEC intel for", today);
  const parsed = await pullIntel();
  console.log("Got", (parsed.items || []).length, "items");
  updateStore(parsed, today);
  console.log("data.json updated");
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.MAIL_TO) {
    await sendEmail(parsed, today);
    console.log("Email sent to", process.env.MAIL_TO);
  } else {
    console.log("Email skipped — Gmail secrets not set");
  }
})().catch((e) => { console.error(e); process.exit(1); });
