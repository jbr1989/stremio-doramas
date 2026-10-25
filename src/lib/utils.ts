import { Env, MetaPreview } from "./types";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ─── request logging ────────────────────────────────────────────────────────
// One [net] line per outgoing HTTP request of the addon, visible in the
// wrangler terminal / wrangler tail. `how` marks the route: direct, proxy
// (Deno relay), render (Browser Rendering), tmdb, companion, relay, or the
// fallback public-proxy name (allorigins/codetabs/corsproxy).
const NET_SNIPPET = 160;

function shortUrl(u: string, max = NET_SNIPPET): string {
  const flat = u.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function errText(e: unknown): string {
  return (e instanceof Error) ? e.message : String(e);
}

export async function netFetch(
  how: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const t0 = Date.now();
  const method = (init?.method || (init?.body != null ? "POST" : "GET")).toUpperCase();
  try {
    const r = await fetch(url, init);
    const len = r.headers.get("content-length") || "";
    const flag = r.ok ? "" : "FAIL ";
    console.log(
      `[net] ${flag}${how} ${method} ${shortUrl(url)} → ${r.status}${len ? `, ${len}B` : ""} (${Date.now() - t0}ms)`
    );
    return r;
  } catch (e) {
    console.error(
      `[net] THROW ${how} ${method} ${shortUrl(url)} → ${errText(e)} (${Date.now() - t0}ms)`
    );
    throw e;
  }
}

// Racer fetch compartido: directo + relay vía FETCH_PROXY_URL (si está
// configurado) en paralelo con Promise.any, descartando respuestas cortas.
// Antes copiado inline ×3 (doramas, tudorama, pandrama).
export async function racerFetch(
  url: string,
  env?: Env,
  opts?: {
    minLen?: number; // longitud mínima del cuerpo (default 300)
    directTimeoutMs?: number; // default 8000
    proxyTimeoutMs?: number; // default 12000
    headers?: HeadersInit; // default CHROME_HEADERS
  }
): Promise<string> {
  const proxyBase = env?.FETCH_PROXY_URL?.trim();
  const minLen = opts?.minLen ?? 300;
  const directTimeoutMs = opts?.directTimeoutMs ?? 8000;
  const proxyTimeoutMs = opts?.proxyTimeoutMs ?? 12000;
  const headers = opts?.headers ?? CHROME_HEADERS;

  const pull = async (name: string, r: Promise<Response>) => {
    const res = await r;
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const txt = await res.text();
    if (txt.length < minLen)
      throw new Error(`${name}: too short (${txt.length}b)`);
    return txt;
  };

  const racers: Promise<string>[] = [
    pull(
      "direct",
      netFetch("direct", url, { headers, signal: AbortSignal.timeout(directTimeoutMs) })
    ),
  ];
  if (proxyBase) {
    racers.push(
      pull(
        "relay",
        netFetch("proxy", `${proxyBase}?url=${encodeURIComponent(url)}`, {
          headers: { "User-Agent": CHROME_UA },
          signal: AbortSignal.timeout(proxyTimeoutMs),
        })
      )
    );
  }
  return Promise.any(racers);
}

export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// UA de móvil: algunos hosts (hexload, savefiles/streamhls) y el /proxy/m3u8
// exigen UA iPhone para servir el stream. Antes copiado inline ×5 en
// extractors.ts e index.ts (deno/fetch.ts tiene su propia copia: runtime
// aparte que no puede importar de src/).
export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const CHROME_HEADERS = {
  "User-Agent": CHROME_UA,
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.google.com/",
  "Sec-CH-UA": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Cache-Control": "max-age=0",
  "Upgrade-Insecure-Requests": "1",
};

export const TTL = {
  catalog: 10 * 60, // 10 min (seconds for KV)
  meta: 2 * 60 * 60, // 2 hr
  stream: 30 * 60, // 30 min
};

export async function cacheGet(
  key: string,
  kv: KVNamespace | undefined
): Promise<unknown> {
  if (!kv) return null;
  try {
    const val = await kv.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  data: unknown,
  ttlSec: number,
  kv: KVNamespace | undefined
) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSec });
  } catch (e) {
    console.log(`[cache] KV write failed for ${key}: ${e}`);
  }
}

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

export async function fetchTmdb(animeName: string, tmdbKey: string) {
  if (!tmdbKey) return null;
  const cleanName = animeName
    .replace(/\s+(Latino|Castellano|Japones|Japonés|Sub\s+Español)$/i, "")
    .replace(/\s+S(\d+)$/i, " Season $1")
    .trim();
  try {
    const r = await netFetch(
      "tmdb",
      `${TMDB_BASE}/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(
        cleanName
      )}&language=es-ES`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!r.ok) return null;
    const data: any = await r.json();
    const hit = data.results?.[0];
    if (!hit) return null;
    return {
      poster: hit.poster_path ? `${TMDB_IMG}${hit.poster_path}` : "",
      background: hit.backdrop_path
        ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}`
        : "",
      description: hit.overview || "",
      year: (hit.first_air_date || "").slice(0, 4),
    };
  } catch {
    return null;
  }
}

export function browserRenderingReady(env: Env): boolean {
  return (
    !!(env.CF_ACCOUNT_ID || "").trim() && !!(env.CF_API_TOKEN || "").trim()
  );
}

export async function renderPage(
  url: string,
  env: Env,
  opts: {
    referer?: string;
    wait?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
    timeoutMs?: number;
    waitForSelector?: string;
  } = {}
): Promise<string | null> {
  const acct = (env.CF_ACCOUNT_ID || "").trim();
  const token = (env.CF_API_TOKEN || "").trim();
  if (!acct || !token) return null;
  const timeoutMs = opts.timeoutMs ?? 20000;
  try {
    const body: Record<string, unknown> = {
      url,
      setExtraHTTPHeaders: {
        Referer: opts.referer ?? "https://latanime.org/",
      },
      gotoOptions: {
        waitUntil: opts.wait ?? "networkidle0",
        timeout: Math.max(6000, timeoutMs - 3000),
      },
    };
    if (opts.waitForSelector) {
      body.waitForSelector = {
        selector: opts.waitForSelector,
        timeout: Math.min(16000, Math.max(4000, timeoutMs - 4000)),
      };
    }
    const r = await netFetch(
      "render",
      `https://api.cloudflare.com/client/v4/accounts/${acct}/browser-rendering/content`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    if (!r.ok) return null;
    const data: any = await r.json();
    const html =
      typeof data?.result === "string"
        ? data.result
        : data?.result?.html || "";
    return html && html.length > 200 ? html : null;
  } catch {
    return null;
  }
}

export function isCfChallenge(body: string): boolean {
  return /<title>Just a moment|_cf_chl_opt|__cf_chl_|challenge-platform|cf-browser-verification/i.test(
    body
  );
}

// The target page does not exist upstream (404/410): retrying it through
// relay/proxies can never succeed, so fetchHtml short-circuits on this.
class SiteNotFoundError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string) {
    super(`HTTP ${status}: ${shortUrl(url)}`);
    this.name = "SiteNotFoundError";
    this.status = status;
    this.url = url;
  }
}

function isSiteNotFound(e: unknown): e is SiteNotFoundError {
  return e instanceof SiteNotFoundError;
}

// Promise.any wraps the racers' rejections in an AggregateError; look through
// it for a definitive 404/410 from any strategy.
function isAnySiteNotFound(e: unknown): boolean {
  if (isSiteNotFound(e)) return true;
  if (e instanceof AggregateError)
    return e.errors.some((inner) => isSiteNotFound(inner));
  return false;
}

export async function fetchHtml(
  url: string,
  env?: Env,
  opts?: { allowShort?: boolean }
): Promise<string> {
  const encoded = encodeURIComponent(url);
  // APIs JSON (kisskh /api/...) devuelven cuerpos < 500B válidos: con
  // allowShort no se descartan por tamaño.
  const MIN_LEN = opts?.allowShort ? 0 : 500;

  const controller = new AbortController();
  const globalTimer = setTimeout(() => controller.abort(), 25000);

  const tryFetch = async (
    name: string,
    fetcher: () => Promise<Response>
  ): Promise<string> => {
    if (controller.signal.aborted) throw new Error(`${name}: global timeout`);
    const r = await fetcher();
    if (r.status === 404 || r.status === 410)
      throw new SiteNotFoundError(r.status, url);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const html = await r.text();
    if (html.length < MIN_LEN)
      throw new Error(`${name}: too short (${html.length}b)`);
    if (name !== "direct") console.log(`[fetchHtml] ${name} for ${url}`);
    return html;
  };

  try {
    // Hosts de reto: la cascada completo es desperdicio (403 al instante /
    // timeouts de 8s en los proxies públicos). Directo con techo corto y, si
    // hay Browser Rendering, render; si no pasa, falla rápido y el extractor
    // caller devuelve null (la opción queda 🌐 external, como siempre).
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    if (CHALLENGE_HOSTS_RE.test(host)) {
      console.log(
        `[fetchHtml] challenge host ${host}, fast path sin proxies: ${shortUrl(url)}`
      );
      if (env && browserRenderingReady(env)) {
        const html = await renderPage(url, env, {
          wait: "load",
          timeoutMs: 16000,
        });
        if (html && html.length >= MIN_LEN) {
          clearTimeout(globalTimer);
          console.log(`[fetchHtml] render (challenge) for ${url}`);
          return html;
        }
      }
      const html = await tryFetch(
        "direct-challenge",
        () =>
          netFetch("direct", url, {
            headers: CHROME_HEADERS,
            signal: AbortSignal.timeout(4000),
          })
      );
      clearTimeout(globalTimer);
      return html;
    }

    const proxyBase = env?.FETCH_PROXY_URL?.trim();
    const racers: Promise<string>[] = [
      tryFetch("direct", () =>
        netFetch("direct", url, {
          headers: CHROME_HEADERS,
          signal: AbortSignal.timeout(8000),
        })
      ),
    ];
    if (proxyBase) {
      racers.push(
        tryFetch("fetchproxy", () =>
          netFetch("proxy", `${proxyBase}?url=${encoded}`, {
            headers: { "User-Agent": CHROME_UA },
            signal: AbortSignal.timeout(12000),
          })
        )
      );
    }
    try {
      const html = await Promise.any(racers);
      clearTimeout(globalTimer);
      return html;
    } catch (e) {
      /* every racer rejected — fall through, unless a 404/410 proved the
         page never existed (see tryFetch): then skip render + proxies */
      if (isAnySiteNotFound(e)) {
        console.log(`[fetchHtml] upstream 404/410, skipping fallbacks: ${shortUrl(url)}`);
        throw e;
      }
    }

    if (env && browserRenderingReady(env) && !controller.signal.aborted) {
      const html = await renderPage(url, env, {
        wait: "load",
        timeoutMs: 16000,
      });
      if (html && html.length >= MIN_LEN) {
        clearTimeout(globalTimer);
        console.log(`[fetchHtml] render for ${url}`);
        return html;
      }
    }

    for (const [name, proxyUrl] of [
      ["allorigins", `https://api.allorigins.win/raw?url=${encoded}`],
      ["codetabs", `https://api.codetabs.com/v1/proxy?quest=${encoded}`],
      ["corsproxy", `https://corsproxy.io/?${encoded}`],
    ] as [string, string][]) {
      if (controller.signal.aborted) break;
      try {
        const html = await tryFetch(name, () =>
          netFetch(name, proxyUrl, {
            headers: { "User-Agent": CHROME_UA },
            signal: AbortSignal.timeout(6000),
          })
        );
        clearTimeout(globalTimer);
        return html;
      } catch (e) {
        console.log(`[fetchHtml] ${name} failed: ${e}`);
        // No short-circuit here: a public proxy's own 404 is not proof the
        // upstream page is dead (we only reach this loop via 403/timeouts).
      }
    }

    throw new Error(`All fetch strategies failed for ${url}`);
  } finally {
    clearTimeout(globalTimer);
  }
}

export function toMetaPreview(c: {
  id: string;
  name: string;
  poster: string;
}): MetaPreview {
  return {
    id: c.id,
    type: "series",
    name: c.name,
    poster: c.poster || "",
    posterShape: "poster",
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  eacute: "é",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  Eacute: "É",
  Aacute: "Á",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  uuml: "ü",
  Uuml: "Ü",
  ordf: "ª",
  ordm: "º",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e] ?? m);
}

// ─── helpers compartidos por las fuentes ────────────────────────────────────

/** Limpieza común de títulos de los sitios DooPlay/WP: quita un "Ver " inicial,
 * corta en " – / — / |" y desecha las colas del tema ("subtitulado", "doblado",
 * "online", "en hd", "castellano", "latino", "(en emisión)", "(finalizado)").
 * Antes vivía copiado ×5 como cleanTudoramaTitle, cleanKplayTitle,
 * cleanDoramaYtTitle, cleanDoramasflixTitle y cleanDoramaTitle. */
export function cleanTitle(s: string): string {
  let t = decodeEntities(s).replace(/^\s*Ver\s+/i, "");
  t = t.split(/\s+[–—|]\s+/)[0];
  t = t.split(
    /\s+(?:subtitulad[oa]|doblad[oa]|online|en\s+hd|sub\s+(?:esp|sp)\w*|castellano|latino)\b/i
  )[0];
  return t
    .replace(/\s*\((?:en\s+emisi[oó]n|finalizado)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hosts de reto: su página de embed rechaza TLS no-navegador (challenge
 *  activo de Cloudflare). La cascada de proxies públicos es inútil contra
 *  ellos (corsproxy 403 al instante, allorigins/codetabs timeout 8s ≈ 24s
 *  perdidos por embed), así que fetchHtml va directo con techo corto y —
 *  si hay Browser Rendering — hace render. Lista con su evidencia:
 *  - dsvplay.com   embed dyt: direct THROW, codetabs/allorigins timeout 8s,
 *                  corsproxy 403 (visto en /debug-all dyt).
 *  - do7go.com / playmogo.com   familia Dood: la página /e/ desafía TLS
 *                  no-navegador (probado con egress Deno/.NET/CF Worker);
 *                  el pass_md5 funciona GET server-side directo. */
const CHALLENGE_HOSTS_RE =
  /(?:^|\.)(?:dsvplay\.com|do7go\.com|playmogo\.com)$/i;

/** Hosts/mirrors de StreamWish admitidos por el relay Deno (/streamwish).
 * Incluye la familia "filelions" (lulu) — embeds que hace hop entre dominios
 * (lulustream→luluvdo) y sirve master.m3u8 en CDN cdn-tnmr.* (verificado en
 * sondas reales: unresolved con extractStreamwish tal cual).
 * Mantener sincronizada con la allowlist de /streamwish en deno/fetch.ts. */
export const STREAMWISH_HOSTS_RE =
  /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|lulustream|luluvdo|luluvido|lulu\.st/i;

/**.Hosts de la família Dood (do7go/playmogo/dood*): NO son StreamWish — sirven
 * un MP4 progresivo vía pass_md5 y el gate del MP4 es Referer (no IP-bound).
 * Se resuelven con extractDood (src/extractors.ts) y se relayan por /mp4 en el
 * proxy Deno. Mantener sincronizada con la allowlist de /mp4 en deno/fetch.ts. */
export const DOOD_HOSTS_RE = /dood|do7go|playmogo|ds2play|dsvplay/i;

/** Familia "byse": la puerta del player hace challenge/attest (ECDSA P-256) +
 * PoW y devuelve el m3u8 cifrado, que el relay Deno resuelve íntegro (/byse,
 * ver deno/byse.ts) porque el token es ASN-bound.
 *
 * Detección POR FORMA de API (clones y dominios rotando incluidos), no por
 * nombre: embed público https://<host>/e/<code> con código [a-z0-9-]{6,20}.
 * Otras familias usan /e/ también (streamwish, dood, streamtape) — por eso la
 * rama byse se evalúa AL FINAL de addEmbedStreams (extractors.ts), cuando ya
 * ninguna otra familia matcheó, y el relay Deno confirma el host sondeando
 * /api/videos/<code>/embed/details (502 "no compatible" si no es la familia).
 * Mantener sincronizada con la allowlist de /byse en deno/byse.ts. */
export const BYSE_SHAPE_RE =
  /^https?:\/\/[^/"']+\/e\/[a-z0-9-]{6,20}(?:$|\/|\?|#)/i;

/** Hosts de reto anti-bot (ver CHALLENGE_HOSTS_RE en README para la tabla con
 *  evidencia): fetchHtml los salta directos con techo corto, sin proxies. */

/** Host plano de un embed para el título del stream:
 * "streamwish" ← https://streamwish.to/e/abc. */
export function hostFromEmbed(embed: string, fallback = "host"): string {
  return embed.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] || fallback;
}

/** Base del relay Deno derivada de FETCH_PROXY_URL:
 * https://<algo>.deno.dev/fetch → https://<algo>.deno.dev. Antes copiado ×7. */
export function denoBaseFromEnv(env?: Env): string {
  return (env?.FETCH_PROXY_URL || "")
    .trim()
    .replace(/\/fetch\/?$/, "")
    .replace(/\/$/, "");
}

/** Fábrica del deduper de streams compartido: ignora las repeticiones por
 * url/externalUrl. Uso: `const { add, streams } = makeStreamDeduper();`.
 * Antes copiado ×6 como `const add = (s: any) => …` (pandrama lo usaba vía
 * `seen`) + el filtrado final de getStreams en index.ts. */
export function makeStreamDeduper() {
  const streams: any[] = [];
  const seen = new Set<string>();
  const add = (s: {
    url?: string;
    externalUrl?: string;
    [k: string]: unknown;
  }) => {
    const k = s.url || s.externalUrl;
    if (k && !seen.has(k)) {
      seen.add(k);
      streams.push(s);
    }
  };
  return { add, streams };
}
