// Doramas helper service for Deno Deploy — a stable, non-Cloudflare egress.
//
// Two jobs:
//
//   GET /fetch?url=https://doramaslat.com/...
//       Relays dorama site HTML when needed. Allowlisted to dorama source domains.
//
//   GET /savefiles?code=<file_code>
//       Resolves a savefiles/streamhls episode to an HLS master playlist and
//       serves it rewritten so every variant/segment is re-fetched through
//       /hls below. savefiles mints signed URLs LOCKED to the IP that did the
//       extraction, so doing the extraction AND all playback fetches here — on
//       Deno's single stable IP — keeps the token valid.
//
//   GET /hls?u=<abs-url>&r=<referer>
//       Fetches a variant playlist (rewriting it recursively) or a segment
//       (streaming the bytes) with the streamhls referer. Allowlisted to the
//       savefiles/streamhls CDNs.
//
// Deno Deploy runs always-warm isolates, so latency and egress IP stay stable.
// deno.json at the repo root pins the entrypoint to this file. Set the Worker's
// FETCH_PROXY_URL to https://<project>.deno.net/fetch — the Worker derives the
// /savefiles base from it.
//
// Every request is console-logged with a [tag] prefix ([req]/[fetch]/
// [savefiles]/[streamwish]/[hls]) — visible live in the Deno Deploy dashboard.

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const STREAMHLS_REFERER = "https://streamhls.to/";

function cors(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(body, { ...init, headers });
}

function jsonError(msg: string, status: number): Response {
  return cors(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── logging helpers ────────────────────────────────────────────────────────
// Deno Deploy trims log messages at 2KB and keeps ~1000 entries/s per deploy,
// so every logged url/snippet is truncated and each request emits 1–3 lines.
const LOG_SNIPPET = 200;

function errText(e: unknown): string {
  return (e instanceof Error) ? e.message : String(e);
}

function trunc(s: string, max = LOG_SNIPPET): string {
  // collapse newlines/whitespace so snippets always stay single-line
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…(+${flat.length - max})`;
}

function ms(t0: number): string {
  return `${Math.round(performance.now() - t0)}ms`;
}

function log(tag: string, msg: string): void {
  console.log(`[${tag}] ${msg}`);
}

function logErr(tag: string, msg: string): void {
  console.error(`[${tag}] ${msg}`);
}

// ─── /fetch — dorama HTML relay ───────────────────────────────────────────
async function handleFetch(target: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    logErr("fetch", `url inválida: ${trunc(target, 120)}`);
    return jsonError("invalid url", 400);
  }
  // Allowlist: doramaslat.com, doramedplay.net, kdramasplay.com, doramasflix.in, doramasyt.com, tudorama.com, pandrama.tv.
  if (u.protocol !== "https:" || !/(^|\.)(doramaslat\.com|doramedplay\.net|kdramasplay\.com|doramasflix\.in|doramasyt\.com|tudorama\.com|pandrama\.tv)$/i.test(u.hostname)) {
    logErr("fetch", `host no permitido: ${u.protocol}//${u.hostname}`);
    return jsonError("host not allowed", 403);
  }
  const t0 = performance.now();
  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.google.com/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(11000),
    });
    const body = await upstream.text();
    if (upstream.ok) {
      log("fetch", `GET ${u.pathname + u.search} → ${upstream.status}, ${body.length}B (${ms(t0)})`);
    } else {
      logErr("fetch", `FAIL GET ${u.pathname + u.search} → ${upstream.status} (${ms(t0)}) html: ${trunc(body, 300)}`);
    }
    return cors(body, {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  } catch (e) {
    logErr("fetch", `THROW GET ${u.pathname + u.search} → ${errText(e)} (${ms(t0)})`);
    return jsonError(String(e), 502);
  }
}

// ─── savefiles / streamhls / streamwish HLS ─────────────────────────────────
// premilkyway.com is StreamWish's HLS CDN. Its playlist/segment tokens
// are IP-bound, so they must be fetched from this same Deno IP that resolved the embed.
function hlsHostAllowed(host: string): boolean {
  return /(^|\.)(savefiles\.com|streamhls\.to|premilkyway\.com)$/i.test(host) ||
    // CDN de la familia filelions (lulu): cdn-tnmr.org / .1x / .1y — TLDs raros que rotan.
    /cdn-tnmr/i.test(host);
}

const STREAMWISH_REFERER = "https://streamwish.top/";

// Dean Edwards p.a.c.k.e.r unpacker
function unpackPacker(source: string): string | null {
  const m = source.match(/}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,'(.*?)'\.split\('\|'\)/s);
  if (!m) return null;
  const base = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const words = m[4].split("|");
  const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const encode = (n: number): string =>
    (n < base ? "" : encode(Math.floor(n / base))) +
    ((n = n % base) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  const dict: Record<string, string> = {};
  for (let i = count - 1; i >= 0; i--) dict[encode(i)] = words[i] || dict[encode(i)] || encode(i);
  return payload.replace(/\b\w+\b/g, (w) => dict[w] || w);
}

// Resolve a StreamWish /e/ embed to its HLS master (token bound to this Deno IP).
async function resolveStreamwish(embedUrl: string): Promise<string | null> {
  const embed = embedUrl.replace(/\/(?:f|d|v)\/([a-z0-9-]+)/i, "/e/$1");
  const origin = (() => { try { return new URL(embed).origin; } catch { return "https://streamwish.top"; } })();
  const t0 = performance.now();
  try {
    const r = await fetch(embed, {
      headers: { "User-Agent": CHROME_UA, "Referer": `${origin}/` },
      redirect: "follow",
      signal: AbortSignal.timeout(11000),
    });
    if (!r.ok) {
      logErr("streamwish", `resolve FAIL GET ${embed} → ${r.status} (${ms(t0)})`);
      return null;
    }
    const html = await r.text();
    const unpacked = unpackPacker(html) || html;
    const packed = unpacked !== html;
    const mHls = unpacked.match(/"hls\d*"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    const mFile = mHls ? null : unpacked.match(/file\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    const mAny = (mHls || mFile) ? null : unpacked.match(/https?:\/\/[^"'\\ ]+\.m3u8[^"'\\ ]*/);
    const m = mHls || mFile || mAny;
    if (!m) {
      logErr("streamwish", `resolve FAIL: sin m3u8 en el html (packed=${packed}) ${trunc(html, 300)}`);
      return null;
    }
    const master = m[1] || m[0];
    const which = mHls ? '"hls2"' : mFile ? "file:" : "genérico";
    log("streamwish", `resolve ${embed} → master ${trunc(master, 150)} (match ${which}, packed=${packed}, ${ms(t0)})`);
    return master;
  } catch (e) {
    logErr("streamwish", `resolve THROW GET ${embed} → ${errText(e)} (${ms(t0)})`);
    return null;
  }
}

// GET /streamwish?url=<embed> → resolve + serve the rewritten master playlist,
// every variant/segment re-fetched through /hls on this same Deno IP.
async function handleStreamwish(embedUrl: string, selfBase: string): Promise<Response> {
  let ok = false;
  let host = "(inválida)";
  // Espejos de StreamWish admitidos. Mantén sincronizado con las regex de
  // src/sources/{doramas,kdramasplay,doramasflix}.ts — un host que el Worker
  // enruta aquí y no esté en esta allowlist muere con 403 silencioso.
  try { host = new URL(embedUrl).hostname; ok = /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|lulustream|luluvdo|lulu\.st/i.test(host); } catch { /* invalid */ }
  if (!ok) {
    logErr("streamwish", `host no permitido / url inválida: ${trunc(embedUrl, 160)}`);
    return jsonError("host not allowed", 403);
  }
  const master = await resolveStreamwish(embedUrl);
  if (!master) return jsonError("could not resolve streamwish embed", 502);
  // Referer Ha de pasar a los /hls descendentes. La familia filelions (lulu)
  // exige Referer = la propia URL del embed (https://luluvdo.com/e/<code>)
  // con UA Chrome para sus variantes/segmentos (verificado: origin/ o
  // streamwish.top → 403); los espejos de StreamWish siguen con streamwish.top.
  const isLulu = /lulustream|luluvdo|lulu\.st/i.test(embedUrl);
  const hlsReferer = isLulu ? embedUrl : STREAMWISH_REFERER;
  const t0 = performance.now();
  try {
    let masterRes = await fetch(master, {
      headers: { "User-Agent": CHROME_UA, "Referer": hlsReferer, "Origin": new URL(hlsReferer).origin },
      signal: AbortSignal.timeout(12000),
    });
    // Fallback sin Referer: el CDN de filelions (lulu/família) sirve el master
    // sin referer (verificado) — no morir por cabeceras de una familia ajena.
    if (!masterRes.ok) {
      logErr("streamwish", `master con referer → ${masterRes.status}; reintento sin referer`);
      masterRes = await fetch(master, {
        headers: { "User-Agent": CHROME_UA },
        signal: AbortSignal.timeout(12000),
      });
    }
    if (!masterRes.ok) {
      logErr("streamwish", `master FAIL → ${masterRes.status} (${ms(t0)})`);
      return jsonError(`upstream ${masterRes.status}`, 502);
    }
    const text = await masterRes.text();
    log("streamwish", `master → ${masterRes.status}, ${text.length}B reescrito (${ms(t0)})`);
    return cors(rewriteM3u8(text, master, selfBase, hlsReferer), {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    logErr("streamwish", `master THROW → ${errText(e)} (${ms(t0)})`);
    return jsonError(String(e), 502);
  }
}

// ─── Dood MP4 relay ─────────────────────────────────────────────────────────
// A família Dood (do7go/playmogo/dood.*) sirve MP4 progresivo gateado por
// Referer — NO es IP-bound, pero el player de Stremio no envía Referer.
// Este relay lo añade y pasa Range para el seeking (respuesta 206 upstream).
function doodMp4HostAllowed(host: string): boolean {
  // CDN generoso: los MP4 de Dood viven en cloudatacdn.com y dominios
  // doodcdn/dscdn/dl-*; también acepta CNAMEs con "dood" en el host.
  return /(?:cloudatacdn|doodcdn|dscdn|dood)/i.test(host);
}

// GET /mp4?url=<mp4>&r=<referer> → re-sirve el MP4 con Referer y Range
// passthrough (seeking). Sin señal de timeout: el body se streamea y puede
// durar más que el fetch (cada Range del player es una petición aparte).
async function handleDoodMp4(
  mp4Url: string,
  refererParam: string,
  req: Request
): Promise<Response> {
  let host = "(inválida)";
  let ok = false;
  try { host = new URL(mp4Url).hostname; ok = doodMp4HostAllowed(host); } catch { /* invalid */ }
  if (!ok) {
    logErr("mp4", `host no permitido / url inválida: ${trunc(mp4Url, 160)}`);
    return jsonError("host not allowed", 403);
  }
  if (!refererParam) refererParam = "https://playmogo.com/";
  const referer = refererParam;
  const t0 = performance.now();
  try {
    const headers: Record<string, string> = {
      "User-Agent": CHROME_UA,
      "Referer": referer,
      "Origin": new URL(referer).origin,
      "Accept": "*/*",
    };
    const range = req.headers.get("range");
    if (range) headers["Range"] = range;
    const r = await fetch(mp4Url, { headers, redirect: "follow" });
    if (r.status !== 200 && r.status !== 206) {
      logErr("mp4", `upstream ${r.status} ${trunc(mp4Url, 140)} (${ms(t0)})`);
      return jsonError(`upstream ${r.status}`, 502);
    }
    const out = new Headers({
      "Content-Type": r.headers.get("content-type") || "video/mp4",
      "Accept-Ranges": r.headers.get("accept-ranges") || "bytes",
      "Cache-Control": "no-cache",
    });
    const cr = r.headers.get("content-range");
    if (cr) out.set("Content-Range", cr);
    const cl = r.headers.get("content-length");
    if (cl) out.set("Content-Length", cl);
    log("mp4", `${range ? "206" : r.status} ${host} ${ms(t0)} (range=${range !== null})`);
    return cors(r.body, { status: r.status, headers: out });
  } catch (e) {
    logErr("mp4", `THROW → ${errText(e)} (${ms(t0)})`);
    return jsonError(String(e), 502);
  }
}

// Extract the master m3u8 for a file code.
async function resolveSavefiles(code: string): Promise<string | null> {
  const t0 = performance.now();
  try {
    const r = await fetch("https://streamhls.to/dl", {
      method: "POST",
      headers: {
        "User-Agent": MOBILE_UA,
        "Referer": `https://streamhls.to/e/${code}`,
        "Origin": "https://streamhls.to",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      body: `op=embed&file_code=${code}&auto=1&referer=https://savefiles.com/${code}`,
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    const html = await r.text();
    const src = html.match(/sources:\s*\["([^"]+\.m3u8[^"]*)"\]/);
    if (src) {
      log("savefiles", `resolve ${code}: POST /dl → ${r.status}, match "sources:" → ${trunc(src[1], 150)} (${ms(t0)})`);
      return src[1];
    }
    const any = html.match(/https:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
    if (any) {
      log("savefiles", `resolve ${code}: POST /dl → ${r.status}, match genérico → ${trunc(any[0], 150)} (${ms(t0)})`);
      return any[0];
    }
    logErr("savefiles", `resolve FAIL ${code}: POST /dl → ${r.status}, html sin m3u8: ${trunc(html, 300)}`);
    return null;
  } catch (e) {
    logErr("savefiles", `resolve THROW ${code}: POST /dl → ${errText(e)} (${ms(t0)})`);
    return null;
  }
}

function rewriteM3u8(text: string, sourceUrl: string, selfBase: string, referer: string): string {
  const base = sourceUrl.substring(0, sourceUrl.lastIndexOf("/") + 1);
  const isMaster = text.includes("#EXT-X-STREAM-INF");
  const proxied = (abs: string) =>
    `${selfBase}/hls?u=${encodeURIComponent(abs)}&r=${encodeURIComponent(referer)}`;
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (t === "") return line;
    if (t.startsWith("#")) {
      const uriM = line.match(/URI="([^"]+)"/);
      if (!uriM) return line;
      const absUri = uriM[1].startsWith("http") ? uriM[1] : base + uriM[1];
      return line.replace(uriM[1], proxied(absUri));
    }
    const abs = t.startsWith("http") ? t : base + t;
    return proxied(abs);
  }).join("\n");
}

// GET /savefiles?code=... → resolve + serve the rewritten master playlist.
async function handleSavefiles(code: string, selfBase: string): Promise<Response> {
  if (!/^[a-z0-9]{6,}$/i.test(code)) {
    logErr("savefiles", `bad code: "${trunc(code, 60)}"`);
    return jsonError("bad code", 400);
  }
  const master = await resolveSavefiles(code);
  if (!master) return jsonError("could not resolve savefiles code", 502);
  const t0 = performance.now();
  try {
    const r = await fetch(master, {
      headers: { "User-Agent": MOBILE_UA, "Referer": STREAMHLS_REFERER, "Origin": "https://streamhls.to" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) {
      logErr("savefiles", `master FAIL ${code}: → ${r.status} (${ms(t0)})`);
      return jsonError(`upstream ${r.status}`, 502);
    }
    const text = await r.text();
    log("savefiles", `master ${code}: → ${r.status}, ${text.length}B reescrito (${ms(t0)})`);
    return cors(rewriteM3u8(text, master, selfBase, STREAMHLS_REFERER), {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    logErr("savefiles", `master THROW ${code}: → ${errText(e)} (${ms(t0)})`);
    return jsonError(String(e), 502);
  }
}

// GET /hls?u=<abs>&r=<referer> → proxy a variant playlist (rewritten) or a segment (streamed).
async function handleHls(rawUrl: string, referer: string, selfBase: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    logErr("hls", `url inválida: ${trunc(rawUrl, 120)}`);
    return jsonError("invalid url", 400);
  }
  if (!hlsHostAllowed(u.hostname)) {
    logErr("hls", `host no permitido: ${u.hostname}`);
    return jsonError("host not allowed", 403);
  }
  const t0 = performance.now();
  const tryHeaders = (ua: string): Record<string, string> => ({
    "User-Agent": ua,
    "Referer": referer || STREAMHLS_REFERER,
    "Origin": new URL(referer || STREAMHLS_REFERER).origin,
  });
  try {
    let r = await fetch(rawUrl, { headers: tryHeaders(MOBILE_UA), signal: AbortSignal.timeout(15000) });
    // Reintento con UA Chrome: la CDN de filelions (lulu) rechaza el móvil
    // aunque el Referer sea correcto (verificado; Chrome desktop sí pasa).
    if (!r.ok) {
      logErr("hls", `UA móvil → ${r.status}, reintento con Chrome: ${u.hostname}`);
      r = await fetch(rawUrl, { headers: tryHeaders(CHROME_UA), signal: AbortSignal.timeout(15000) });
    }
    if (!r.ok) {
      logErr("hls", `FAIL ${u.pathname} → ${r.status} (${ms(t0)})`);
      return new Response(`upstream ${r.status}`, { status: r.status, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const ct = r.headers.get("Content-Type") || "";
    const isPlaylist = rawUrl.includes(".m3u8") || ct.includes("mpegurl");
    if (isPlaylist) {
      const text = await r.text();
      log("hls", `playlist ${u.pathname} → ${r.status}, ${text.split("\n").length} líneas (${ms(t0)})`);
      return cors(rewriteM3u8(text, rawUrl, selfBase, referer || STREAMHLS_REFERER), {
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
      });
    }
    log("hls", `segment ${u.pathname} → ${r.status} ${ct || "video/MP2T"} (${ms(t0)})`);
    return new Response(r.body, {
      headers: {
        "Content-Type": ct || "video/MP2T",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    logErr("hls", `THROW ${u.pathname} → ${errText(e)} (${ms(t0)})`);
    return new Response(String(e), { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const selfBase = url.origin;

  const key = url.searchParams.get("u")
    || url.searchParams.get("code")
    || url.searchParams.get("url");
  log(
    "req",
    `${req.method} ${url.pathname}${key ? ` ${trunc(key, 140)}` : ""}`
  );

  if (req.method === "OPTIONS") return cors(null, { status: 204 });

  if (url.pathname === "/savefiles") {
    return handleSavefiles((url.searchParams.get("code") || "").trim(), selfBase);
  }
  if (url.pathname === "/streamwish") {
    return handleStreamwish((url.searchParams.get("url") || "").trim(), selfBase);
  }
  if (url.pathname === "/mp4") {
    return handleDoodMp4(
      (url.searchParams.get("url") || "").trim(),
      (url.searchParams.get("r") || "").trim(),
      req
    );
  }
  if (url.pathname === "/hls") {
    return handleHls(url.searchParams.get("u") || "", url.searchParams.get("r") || "", selfBase);
  }
  const target = url.searchParams.get("url");
  if (!target) {
    return cors(JSON.stringify({ ok: true, usage: "/fetch?url=… | /savefiles?code=… | /streamwish?url=… | /hls?u=…&r=… | /mp4?url=…&r=…" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return handleFetch(target);
}

Deno.serve(
  { port: Number(Deno.env.get("PORT")) || 8000 },
  handler
);
