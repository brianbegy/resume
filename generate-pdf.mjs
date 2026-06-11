#!/usr/bin/env node
// Generates brianbegy.pdf from brianbegy.md
// Run with: node generate-pdf.mjs
import { readFileSync, writeFileSync } from "fs";
import { createServer as tcpServer } from "net";
import { createServer as httpServer } from "http";
import { spawn } from "child_process";

const md = readFileSync("brianbegy.md", "utf8");

// ── HTML builder ──────────────────────────────────────────────────────────────
// Wraps each job block (content between <hr> separators under EXPERIENCE)
// in a <div class="job"> so CSS can keep them from splitting across pages.

function buildBody(md) {
  const lines = md.split("\n");
  const out = [];
  let liBuffer = [];
  let inExperience = false;
  let inJob = false;

  const flushLi = () => {
    if (liBuffer.length) { out.push("<ul>" + liBuffer.join("") + "</ul>"); liBuffer = []; }
  };
  const strong = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^# EXPERIENCE$/i.test(line)) {
      inExperience = true;
      out.push(`<h1>EXPERIENCE</h1>`);
      continue;
    }

    if (/^# /.test(line)) {
      flushLi();
      if (inJob) { out.push("</div>"); inJob = false; }
      inExperience = false;
      out.push(`<h1>${line.slice(2)}</h1>`);
      continue;
    }

    if (/^---$/.test(line)) {
      flushLi();
      if (inExperience) {
        if (inJob) out.push("</div>");
        out.push("<hr>");
        out.push('<div class="job">');
        inJob = true;
      } else {
        out.push("<hr>");
      }
      continue;
    }

    if (/^## /.test(line)) {
      flushLi();
      // First job block starts at first h2 under EXPERIENCE
      if (inExperience && !inJob) { out.push('<div class="job">'); inJob = true; }
      out.push(`<h2>${line.slice(3)}</h2>`);
      continue;
    }

    if (/^### /.test(line)) {
      flushLi();
      out.push(`<h3>${line.slice(4)}</h3>`);
      continue;
    }

    if (/^- /.test(line)) {
      liBuffer.push(`<li>${strong(line.slice(2))}</li>`);
      continue;
    }

    if (line.trim() === "") { flushLi(); continue; }

    flushLi();
    out.push(`<p>${strong(line)}</p>`);
  }

  flushLi();
  if (inJob) out.push("</div>");
  return out.join("\n");
}

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: letter; margin: 0.6in 0.65in 0.6in 0.65in; }
  body { font-family: Georgia, serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }

  h1 { font-size: 22pt; font-weight: 700; letter-spacing: 0.02em; margin-bottom: 2pt; color: #111; }
  h2 {
    font-size: 11.5pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; margin-top: 12pt; margin-bottom: 3pt;
    color: #222; border-bottom: 1px solid #ccc; padding-bottom: 2pt;
  }
  h3 { font-size: 10.5pt; font-weight: 700; margin-top: 8pt; margin-bottom: 1pt; color: #222; }
  p { margin-bottom: 4pt; }
  ul { margin: 4pt 0 4pt 16pt; padding: 0; }
  li { margin-bottom: 2pt; }
  strong { font-weight: 700; }
  hr { border: none; border-top: 1px solid #ddd; margin: 8pt 0; }

  /* Contact line */
  h1 + p { font-size: 9.5pt; color: #555; margin-bottom: 0; }
  /* Tagline */
  h1 + p + h2 {
    border-bottom: none; font-size: 10pt; color: #444;
    text-transform: none; letter-spacing: 0; font-weight: 400;
    font-style: italic; margin-top: 2pt;
  }

  /* Keep each job block on one page where possible */
  .job { break-inside: avoid; }
</style>
</head>
<body>
${buildBody(md)}
</body>
</html>`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const freePort = () => new Promise((res) => {
  const s = tcpServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// ── Spin up a local HTTP server for the HTML ──────────────────────────────────

const [htmlPort, cdpPort] = await Promise.all([freePort(), freePort()]);

const web = httpServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(htmlContent); });
await new Promise((res) => web.listen(htmlPort, "127.0.0.1", res));

// ── Launch Chrome headless ────────────────────────────────────────────────────

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${cdpPort}`,
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--disable-default-apps", "--disable-extensions",
]);
const cleanup = () => { chrome.kill(); web.close(); };

// Wait for the DevTools endpoint
await new Promise((res) => {
  const poll = async () => {
    try { const r = await fetch(`http://localhost:${cdpPort}/json/version`); if (r.ok) return res(); } catch {}
    setTimeout(poll, 150);
  };
  setTimeout(poll, 400);
});

// ── Open a new page target via /json/new ──────────────────────────────────────
// Avoids ambiguity about what the default target type is.

const target = await fetch(`http://localhost:${cdpPort}/json/new`, { method: "PUT" }).then((r) => r.json());
const wsUrl = target.webSocketDebuggerUrl;
if (!wsUrl) { cleanup(); throw new Error("Could not create page target"); }

// ── Connect via WebSocket (Node 22 global WebSocket) ─────────────────────────

const ws = await new Promise((res, rej) => {
  const s = new WebSocket(wsUrl);
  s.onopen = () => res(s);
  s.onerror = rej;
});

let seq = 1;
const pending = new Map();
const eventBus = new Map();

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const cb = pending.get(msg.id); pending.delete(msg.id); cb(msg);
  } else if (msg.method && eventBus.has(msg.method)) {
    const cb = eventBus.get(msg.method); eventBus.delete(msg.method); cb(msg.params);
  }
};

const send = (method, params = {}) => new Promise((res) => {
  const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const onEvent = (method) => new Promise((res) => eventBus.set(method, res));

// ── Navigate and print ────────────────────────────────────────────────────────

await send("Page.enable");
const loaded = onEvent("Page.loadEventFired");
await send("Page.navigate", { url: `http://127.0.0.1:${htmlPort}/` });
await loaded;
await wait(300); // let CSS settle

const reply = await send("Page.printToPDF", {
  printBackground: true,
  displayHeaderFooter: false,
  paperWidth: 8.5,
  paperHeight: 11,
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
  preferCSSPageSize: true,
  transferMode: "ReturnAsBase64",
});

ws.close();
cleanup();

if (reply.error) throw new Error(JSON.stringify(reply.error));

const out = `${process.cwd()}/brianbegy.pdf`;
writeFileSync(out, Buffer.from(reply.result.data, "base64"));
console.log(`PDF written to ${out}`);
