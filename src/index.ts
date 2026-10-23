import { Env } from "./types";
import { MANIFEST } from "./manifest";
import { LOGO_PNG_BASE64 } from "./logo";
import {
  CORS,
  json,
  TTL,
  cacheGet,
  cacheSet,
  browserRenderingReady,
  denoBaseFromEnv,
  makeStreamDeduper,
  MOBILE_UA,
  netFetch,
  renderPage,
  isCfChallenge,
} from "./utils";
import {
  extractSavefiles,
  extractMixdrop,
  extractStreamwish,
  findMediaUrl,
} from "./extractors";
import {
  getDoramaCatalog,
  getDoramaMeta,
  getDoramaStreams,
  DORAMA_SOURCES,
} from "./sources/doramas";
import {
  getKplayCatalog,
  getKplayMeta,
  getKplayStreams,
} from "./sources/kdramasplay";
import {
  getDoramasflixCatalog,
  getDoramasflixMeta,
  getDoramasflixStreams,
} from "./sources/doramasflix";
import {
  getTudoramaCatalog,
  getTudoramaMeta,
  getTudoramaStreams,
} from "./sources/tudorama";
import {
  getPandramaCatalog,
  getPandramaMeta,
  getPandramaStreams,
  pandramaEpCanonicalSlug,
} from "./sources/pandrama";
import {
  getDoramaYtCatalog,
  getDoramaYtMeta,
  getDoramaYtStreams,
  canonicalDytSlug,
} from "./sources/doramasyt";
import {
  getDoramaSubCatalog,
  getDoramaSubMeta,
  getDoramaSubStreams,
  canonicalDoramaSubSlug,
} from "./sources/doramasub";
import { getAllAlldoramasCatalog } from "./sources/alldoramas";

async function getCatalog(
  catalogId: string,
  extra: Record<string, string>,
  env?: Env
) {
  if (catalogId.startsWith("alldoramas"))
    return getAllAlldoramasCatalog(extra, env);
  if (catalogId.startsWith("doramaslat"))
    return getDoramaCatalog(DORAMA_SOURCES.dlat, extra, env);
  if (catalogId.startsWith("doramedplay"))
    return getDoramaCatalog(DORAMA_SOURCES.dplay, extra, env);
  if (catalogId.startsWith("kplay")) return getKplayCatalog(extra, env);
  if (catalogId.startsWith("doramasflix"))
    return getDoramasflixCatalog(extra);
  if (catalogId.startsWith("tudorama"))
    return getTudoramaCatalog(extra, env);
  if (catalogId.startsWith("pandrama"))
    return getPandramaCatalog(extra, env);
  if (catalogId.startsWith("doramasyt"))
    return getDoramaYtCatalog(extra, env);
  if (catalogId.startsWith("doramasub"))
    return getDoramaSubCatalog(extra, env);
  return getDoramasflixCatalog(extra);
}

async function getMeta(id: string, tmdbKey: string, env?: Env) {
  if (id.startsWith("dlat:"))
    return getDoramaMeta(DORAMA_SOURCES.dlat, id, tmdbKey, env);
  if (id.startsWith("dplay:"))
    return getDoramaMeta(DORAMA_SOURCES.dplay, id, tmdbKey, env);
  if (id.startsWith("kplay:")) return getKplayMeta(id, tmdbKey, env);
  if (id.startsWith("dflix:")) return getDoramasflixMeta(id, tmdbKey);
  if (id.startsWith("tudorama:")) return getTudoramaMeta(id, tmdbKey, env);
  if (id.startsWith("pandrama:")) return getPandramaMeta(id, tmdbKey, env);
  if (id.startsWith("dyt:")) return getDoramaYtMeta(id, tmdbKey, env);
  if (id.startsWith("dsub:")) return getDoramaSubMeta(id, tmdbKey, env);
  return { meta: null };
}

async function getStreams(rawId: string, env: Env) {
  let epSlug = "";
  let pandramaVideoId = "";
  if (rawId.startsWith("dlat:")) {
    epSlug = rawId.slice("dlat:".length);
  } else if (rawId.startsWith("dplay:")) {
    epSlug = rawId.slice("dplay:".length);
  } else if (rawId.startsWith("dflix:")) {
    epSlug = rawId.slice("dflix:".length);
  } else if (rawId.startsWith("dyt:")) {
    // DYT usa "titulo-episodio-N": a la forma canónica "titulo-1xN" para que
    // las demás fuentes (guardean sobre -\d+x\d+$) acepten el slug.
    epSlug = canonicalDytSlug(rawId.slice("dyt:".length));
  } else if (rawId.startsWith("dsub:")) {
    epSlug = canonicalDoramaSubSlug(rawId.slice("dsub:".length));
  } else if (rawId.startsWith("tudorama:")) {
    epSlug = rawId.slice("tudorama:".length);
  } else if (rawId.startsWith("kplay:")) {
    const parts = rawId.split(":");
    if (parts[1] === "ep") {
      epSlug = parts.slice(2).join(":");
    } else if (parts[1] === "movie") {
      epSlug = `${parts.slice(2).join(":")}-1x1`;
    } else {
      epSlug = parts.slice(1).join(":");
    }
  } else if (rawId.startsWith("pandrama:")) {
    const content = rawId.slice("pandrama:".length);
    if (content.includes(":ep:")) {
      // pandrama:{titleId}:ep:{videoId} — el video no da slug comparable: se
      // resuelve más abajo (async) a "titulo-NxM" para el fan-out.
      pandramaVideoId = content.split(":ep:")[1] || "";
    } else {
      epSlug = content;
    }
  }

  // Resolución async solo para pandrama: representa el video como episodio en
  // el resto de fuentes (cacheada en KV); si falla, queda solo la fuente propia.
  if (pandramaVideoId) {
    epSlug = (await pandramaEpCanonicalSlug(pandramaVideoId, env)) || "";
  }

  const tasks: Promise<{ streams: any[] }>[] = [];

  if (rawId.startsWith("dlat:")) {
    tasks.push(getDoramaStreams(DORAMA_SOURCES.dlat, rawId, env));
  } else if (epSlug) {
    tasks.push(getDoramaStreams(DORAMA_SOURCES.dlat, `dlat:${epSlug}`, env));
  }

  if (rawId.startsWith("dplay:")) {
    tasks.push(getDoramaStreams(DORAMA_SOURCES.dplay, rawId, env));
  } else if (epSlug) {
    tasks.push(getDoramaStreams(DORAMA_SOURCES.dplay, `dplay:${epSlug}`, env));
  }

  if (rawId.startsWith("kplay:")) {
    tasks.push(getKplayStreams(rawId, env));
  } else if (epSlug) {
    tasks.push(getKplayStreams(`kplay:ep:${epSlug}`, env));
  }

  if (rawId.startsWith("dflix:")) {
    tasks.push(getDoramasflixStreams(rawId, env));
  } else if (epSlug) {
    tasks.push(getDoramasflixStreams(`dflix:${epSlug}`, env));
  }

  if (rawId.startsWith("tudorama:")) {
    tasks.push(getTudoramaStreams(rawId, env));
  } else if (epSlug) {
    tasks.push(getTudoramaStreams(`tudorama:${epSlug}`, env));
  }

  if (rawId.startsWith("pandrama:")) {
    tasks.push(getPandramaStreams(rawId, env));
  } else if (epSlug) {
    tasks.push(getPandramaStreams(`pandrama:${epSlug}`, env));
  }

  if (rawId.startsWith("dyt:")) {
    tasks.push(getDoramaYtStreams(rawId, env));
  } else if (epSlug) {
    tasks.push(getDoramaYtStreams(`dyt:${epSlug}`, env));
  }

  if (rawId.startsWith("dsub:")) {
    tasks.push(getDoramaSubStreams(rawId, env));
  } else if (epSlug) {
    tasks.push(getDoramaSubStreams(`dsub:${epSlug}`, env));
  }

  const results = await Promise.allSettled(tasks);
  const { add, streams } = makeStreamDeduper();

  for (const res of results) {
    if (res.status === "fulfilled" && Array.isArray(res.value?.streams)) {
      for (const st of res.value.streams) add(st);
    }
  }

  return { streams };
}

// ---------------------------------------------------------------------------
// /debug-all — chequeo de salud de las 7 fuentes en una sola llamada.
// A diferencia de /debug-extract (getStreams = fan-out mezclado), aquí se
// llama directo al getter de CADA fuente. Por defecto el chequeo es dinámico:
// se toman las series recientes de cada catálogo propio, se expanden a
// episodios vía getMeta y se prueban esos IDs reales (los DBG_IDS fijos se
// pudrían cuando un título cae del site). ?ids=id1,id2 hace override manual;
// ?n= cambia N (default 10, máx 25). Salida plana, una fila por episodio con
// sample = servidor/tipo/name/url de cada stream encontrado.
// ---------------------------------------------------------------------------

/** Cada fuente con el catalogId que la resuelve en getCatalog(). */
const DEBUG_SOURCES: { source: string; catalogId: string }[] = [
  { source: "dlat", catalogId: "doramaslat" },
  { source: "dplay", catalogId: "doramedplay" },
  { source: "kplay", catalogId: "kplay" },
  { source: "dflix", catalogId: "doramasflix" },
  { source: "tudorama", catalogId: "tudorama" },
  { source: "pandrama", catalogId: "pandrama" },
  { source: "dyt", catalogId: "doramasyt" },
  { source: "dsub", catalogId: "doramasub" },
];

const DEBUG_TIMEOUT_MS = 45000;
const DEBUG_CONCURRENCY = 3;

type DebugCheck = {
  source: string;
  id: string;
  run: () => Promise<{ streams: any[] }>;
};

/** ¿Es este un id válido de EPISODIO de esta fuente? Los catálogos pueden
 *  traer metas de serie/lista; el getter de streams solo acepta episodios,
 *  así que filtramos por el formato del id de cada fuente. */
function debugIsEpisodeId(source: string, id: string): boolean {
  if (source === "pandrama") return /^pandrama:\d+:ep:\d+$/.test(id);
  if (source === "dyt") return /^dyt:.+-episodio-\d+$/.test(id);
  if (source === "dsub") return /^dsub:.+capitulo-\d+$/.test(id);
  if (source === "kplay")
    return /^kplay:(?:ep:.+-\d+x\d+|movie:.+)$/.test(id);
  return new RegExp(`^${source}:.+-\\d+x\\d+$`).test(id);
}

/** Dado un stream id con prefijo `fuente:`, construye la llamada al getter de esa fuente. */
function debugCheckFor(prefix: string, id: string, env: Env): DebugCheck | null {
  if (prefix === "dlat")
    return { source: prefix, id, run: () => getDoramaStreams(DORAMA_SOURCES.dlat, id, env) };
  if (prefix === "dplay")
    return { source: prefix, id, run: () => getDoramaStreams(DORAMA_SOURCES.dplay, id, env) };
  if (prefix === "kplay") return { source: prefix, id, run: () => getKplayStreams(id, env) };
  if (prefix === "dflix") return { source: prefix, id, run: () => getDoramasflixStreams(id, env) };
  if (prefix === "tudorama") return { source: prefix, id, run: () => getTudoramaStreams(id, env) };
  if (prefix === "pandrama") return { source: prefix, id, run: () => getPandramaStreams(id, env) };
  if (prefix === "dyt") return { source: prefix, id, run: () => getDoramaYtStreams(id, env) };
  if (prefix === "dsub") return { source: prefix, id, run: () => getDoramaSubStreams(id, env) };
  return null;
}

/** Tipo de un stream individual: external (🌐, no reproducible), mp4 o hls. */
function debugTipoOf(st: any): "hls" | "mp4" | "external" {
  const file = String(st?.behaviorHints?.filename || "");
  if (st?.externalUrl && !st?.url) return "external";
  if (
    file.endsWith(".mp4") ||
    (typeof st?.url === "string" && /\.mp4(\?|$)/i.test(st.url))
  )
    return "mp4";
  return "hls";
}

/** Host del servidor de un stream:
 *  1. campo `title` ("▶ host — label" / "🌐 host — label"),
 *  2. hostname del `externalUrl` (embed original),
 *  3. hostname de `url` (ojo: en HLS puede ser el proxy Deno/Worker, no el origin). */
function debugServerOf(st: any): string {
  const title = String(st?.title || "");
  const m = title.match(/(?:▶|🌐)\s*([^\s—]+)\s*—/);
  if (m) return m[1];
  if (st?.externalUrl) {
    try {
      return new URL(st.externalUrl).hostname;
    } catch {}
  }
  if (typeof st?.url === "string") {
    try {
      return new URL(st.url).hostname;
    } catch {}
  }
  return "?";
}

/** Clasifica los streams de una fuente en HLS/MP4/external según su filename/URL. */
function debugClassify(streams: any[]) {
  const tipos = { hls: 0, mp4: 0, external: 0 };
  for (const st of streams || []) tipos[debugTipoOf(st)]++;
  return tipos;
}

/** Techo por fuente para que un site colgado no bloquee el chequeo completo. */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${tag}: timeout ${ms}ms`)), ms)
    ),
  ]);
}

/** Ejecuta fn sobre items con un tope de concurrencia (resto en cola). */
async function debugMapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => {
    return (async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]);
      }
    })();
  });
  await Promise.all(workers);
  return results;
}

/** Chequeo de un episodio concreto: getter de la fuente + clasificación.
 *  Todos los streams se exponen en `sample` con servidor/tipo/name/url. */
async function debugRunOne(c: DebugCheck): Promise<Record<string, any>> {
  const t0 = Date.now();
  try {
    const r = await withTimeout(c.run(), DEBUG_TIMEOUT_MS, c.source);
    const streams = Array.isArray(r?.streams) ? r.streams : [];
    return {
      source: c.source,
      id: c.id,
      totalMs: Date.now() - t0,
      streamsCount: streams.length,
      tipos: debugClassify(streams),
      // Todas las opciones encontradas, atribuidas a su servidor y con la URL:
      sample: streams.map((s) => ({
        servidor: debugServerOf(s),
        tipo: debugTipoOf(s),
        name: s?.name || "",
        url: s?.url || s?.externalUrl || "",
      })),
    };
  } catch (e) {
    return {
      id: c.id,
      totalMs: Date.now() - t0,
      streamsCount: 0,
      tipos: { hls: 0, mp4: 0, external: 0 },
      error: String(e).slice(0, 300),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const tmdbKey = (env.TMDB_KEY || "").trim();

    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });
    if (path === "/logo.png") {
      const bytes = Uint8Array.from(atob(LOGO_PNG_BASE64), (c) =>
        c.charCodeAt(0)
      );
      return new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          "Content-Length": String(bytes.length),
        },
      });
    }
    // El logo se sirve desde el propio addon: en local apunta al origin del
    // request y en producción al workers.dev, sin depender de sitios externos.
    if (path === "/" || path === "/manifest.json")
      return json({ ...MANIFEST, logo: `${url.origin}/logo.png` });

    if (path === "/debug") {
      return json({
        tmdbKey: tmdbKey ? "set" : "not set",
        kvBinding: env.STREAM_CACHE ? "set" : "not set",
        fetchProxy: (env.FETCH_PROXY_URL || "").trim() || "not set",
        browserRendering: browserRenderingReady(env)
          ? "enabled"
          : "disabled (manual only)",
      });
    }

    if (path === "/debug-extract") {
      const id = url.searchParams.get("id") || "";
      if (!id)
        return json({
          error:
            "Missing ?id= (e.g. dflix:slug-1x1 or dlat:slug-1x1 or kplay:ep:slug)",
        });
      const t0 = Date.now();
      try {
        const result = await getStreams(id, env);
        return json({
          id,
          totalMs: Date.now() - t0,
          streamsCount: result.streams.length,
          streams: result.streams,
        });
      } catch (e) {
        return json({
          id,
          totalMs: Date.now() - t0,
          error: String(e).slice(0, 300),
        });
      }
    }

    if (path === "/debug-all") {
      const n = Math.max(
        1,
        Math.min(parseInt(url.searchParams.get("n") || "10", 10) || 10, 25)
      );
      const t01 = Date.now();

      // Override manual: solo los IDs pedidos, sin ir al catálogo.
      const idsParam = url.searchParams.get("ids");
      if (idsParam) {
        const wanted = idsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const checks: DebugCheck[] = [];
        const unknown: string[] = [];
        for (const id of wanted) {
          const prefix = id.split(":")[0];
          const check = debugCheckFor(prefix, id, env);
          if (check) checks.push(check);
          else unknown.push(id);
        }
        const rows = await debugMapLimit(checks, DEBUG_CONCURRENCY, (c) =>
          debugRunOne(c)
        );
        return json({
          modo: "manual",
          ids: checks.map((c) => c.id),
          unknown,
          results: rows,
          hint: "streams crudos: sin caché KV ni filtro isDecoyUrl. Los externalUrl (🌐) no reproducen — solo HLS y MP4 cuentan como reproducibles.",
        });
      }

      // Estándar: catálogo propio de cada fuente → series recientes →
      // expansión a episodios vía getMeta (los catálogos traen ids de SERIE;
      // el getter de streams solo acepta episodios) → su getter con
      // concurrencia limitada. Las 7 fuentes van en paralelo entre sí;
      // la salida es plana: una fila por episodio, como en el formato antiguo.
      const perSource = await Promise.all(
        DEBUG_SOURCES.map(
          async (s): Promise<Record<string, any>[]> => {
            let metas: any[] = [];
            let catalogUrlOk = true;
            let catalogError: string | undefined;
            try {
              const cat: any = await getCatalog(s.catalogId, {}, env);
              metas = Array.isArray(cat?.metas) ? cat.metas : [];
            } catch (e) {
              catalogUrlOk = false;
              catalogError = String(e).slice(0, 200);
            }

            // Series recientes (suficientes para llegar a n episodios, ~2/serie)
            const seriesIds = metas
              .map((m: any) => m?.id)
              .filter(
                (id: any) => typeof id === "string" && !debugIsEpisodeId(s.source, id)
              )
              .slice(0, Math.max(2, Math.ceil(n / 2)));

            // Expansión serie → episodios (getMeta trae meta.videos[]), 3 en paralelo
            const epIds: string[] = [];
            await debugMapLimit(
              seriesIds,
              DEBUG_CONCURRENCY,
              async (seriesId: string): Promise<boolean> => {
                try {
                  const m: any = await getMeta(seriesId, tmdbKey, env);
                  const vids: any[] = Array.isArray(m?.meta?.videos)
                    ? m.meta.videos
                    : [];
                  const valid = vids
                    .map((v: any) => v?.id)
                    .filter(
                      (id: any) =>
                        typeof id === "string" &&
                        debugIsEpisodeId(s.source, id)
                    )
                    .slice(0, Math.max(1, Math.ceil(n / 4)));
                  const room = n - epIds.length;
                  if (room <= 0) return true; // corta el resto de workers
                  epIds.push(...valid.slice(0, room));
                  return epIds.length >= n;
                } catch {
                  return false; // serie sin meta utilizable: se salta
                }
              }
            );

            const checks = epIds
              .map((id) => debugCheckFor(s.source, id, env))
              .filter((c): c is DebugCheck => c !== null);
            const rows = await debugMapLimit(checks, DEBUG_CONCURRENCY, (c) =>
              debugRunOne(c)
            );
            // Sin episodios (catálogo roto o filtró todo): fila de contexto para que la fuente no desaparezca.
            if (!rows.length)
              return [
                {
                  source: s.source,
                  catalogOk: catalogUrlOk,
                  seriesProbadas: seriesIds.length,
                  episodiosEncontrados: 0,
                  ...(catalogError ? { catalogError } : {}),
                },
              ];
            return rows;
          }
        )
      );
      const results = perSource.flat();
      return json({
        modo: "latest",
        n,
        totalMs: Date.now() - t01,
        results,
        hint: "streams crudos: sin caché KV ni filtro isDecoyUrl. Los externalUrl (🌐) no reproducen — solo HLS y MP4 cuentan como reproducibles. Cada fila trae sample con servidor/tipo/name/url por stream.",
      });
    }

    if (path === "/debug-render") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl) return json({ error: "Missing ?url=" });
      const t0 = Date.now();
      const wait =
        (url.searchParams.get("wait") as
          | "load"
          | "domcontentloaded"
          | "networkidle0"
          | "networkidle2"
          | null) || undefined;
      const selector = url.searchParams.get("selector") || undefined;
      const html = await renderPage(testUrl, env, {
        referer: url.searchParams.get("ref") || "https://doramasflix.in/",
        wait,
        waitForSelector: selector,
        timeoutMs: selector ? 28000 : undefined,
      });
      if (html == null)
        return json({
          error:
            "render returned null — CF_ACCOUNT_ID/CF_API_TOKEN unset or render failed",
          ms: Date.now() - t0,
        });
      return json({
        testUrl,
        wait: wait || "networkidle0",
        htmlLen: html.length,
        isChallenge: isCfChallenge(html),
        media: findMediaUrl(html),
        snippet: html.slice(0, 600),
        ms: Date.now() - t0,
      });
    }

    if (path === "/debug-host") {
      const embedUrl = url.searchParams.get("url");
      if (!embedUrl) return new Response("Missing url", { status: 400 });
      const hdrs = {
        "User-Agent": MOBILE_UA,
        Referer: "https://doramasflix.in/",
        Origin: "https://doramasflix.in",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
      };
      try {
        const r = await netFetch("direct", embedUrl, {
          headers: hdrs,
          signal: AbortSignal.timeout(10000),
        });
        const html = await r.text();
        const urls = [
          ...html.matchAll(
            /["'`](https?:\/\/[^"'`\s]{15,}\.(?:mp4|mkv|m3u8|ts)[^"'`\s]*)/gi
          ),
        ].map((m) => m[1]);
        return json({
          status: r.status,
          contentType: r.headers.get("content-type"),
          htmlLen: html.length,
          foundUrls: urls,
          htmlSnippet: html.slice(0, 5000),
        });
      } catch (e) {
        return json({ error: String(e) });
      }
    }

    if (path === "/debug-savefiles") {
      const code = url.searchParams.get("code") || "hxhufbkiftyf";
      const t0 = Date.now();
      const streamUrl = await extractSavefiles(
        `https://savefiles.com/${code}`
      );
      const workerBase = new URL(request.url).origin;
      const proxyUrl = streamUrl
        ? `${workerBase}/proxy/m3u8?url=${encodeURIComponent(
            streamUrl
          )}&ref=${encodeURIComponent("https://streamhls.to/")}`
        : null;
      return json({ code, streamUrl, proxyUrl, ms: Date.now() - t0 });
    }

    if (path === "/debug-streamwish") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl)
        return json({
          error: "Missing ?url= (a streamwish /e/ or /f/ embed)",
        });
      const t0 = Date.now();
      const streamUrl = await extractStreamwish(testUrl);
      const denoBase = denoBaseFromEnv(env);
      const denoUrl = denoBase
        ? `${denoBase}/streamwish?url=${encodeURIComponent(testUrl)}`
        : null;
      return json({
        testUrl,
        unpackedM3u8: streamUrl,
        denoUrl,
        ipBound: true,
        ms: Date.now() - t0,
      });
    }

    if (path === "/debug-mixdrop") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl) return json({ error: "Missing ?url=" });
      const t0 = Date.now();
      const streamUrl = await extractMixdrop(testUrl);
      return json({ testUrl, streamUrl, ms: Date.now() - t0 });
    }

    if (path === "/debug-dood") {
      const testUrl = url.searchParams.get("url");
      if (!testUrl)
        return json({
          error: "Missing ?url= (a dood family /e/ embed: do7go, playmogo, dood.*)",
        });
      const t0 = Date.now();
      const { extractDood } = await import("./extractors");
      const mp4 = await extractDood(testUrl, env);
      const denoBase = denoBaseFromEnv(env);
      const origin = (() => {
        try {
          return new URL(testUrl).origin;
        } catch {
          return "https://playmogo.com/";
        }
      })();
      const proxyUrl = mp4 && denoBase
        ? `${denoBase}/mp4?url=${encodeURIComponent(mp4)}&r=${encodeURIComponent(origin)}`
        : null;
      return json({
        testUrl,
        mp4Url: mp4 ? mp4.replace(/(\?.*)$/, "?…") : null,
        proxyUrl,
        browserRendering: browserRenderingReady(env) ? "enabled" : "disabled",
        ms: Date.now() - t0,
      });
    }

    if (path === "/cache-clear") {
      const key = url.searchParams.get("key");
      if (key && env.STREAM_CACHE) {
        await env.STREAM_CACHE.delete(key);
        return json({ cleared: key });
      }
      return json({
        error:
          "Missing ?key= (full KV key, e.g. stream:v4:dflix:slug-1x1, meta:{id} or epmap:v1:kplay:{titleKey}) or no KV binding",
      });
    }

    if (path === "/_health") {
      return json({
        status: "alive",
        version: MANIFEST.version,
        kv: env.STREAM_CACHE ? "bound" : "missing",
      });
    }

    const catM = path.match(
      /^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/
    );
    if (catM) {
      const [, , catalogId, extraStr] = catM;
      const extra: Record<string, string> = {};
      if (extraStr)
        extraStr.split("&").forEach((p) => {
          const [k, v] = p.split("=");
          if (k && v) extra[k] = decodeURIComponent(v);
        });
      if (url.searchParams.get("search"))
        extra.search = url.searchParams.get("search")!;
      if (url.searchParams.get("genre"))
        extra.genre = url.searchParams.get("genre")!;
      const cacheKey = `catalog:${catalogId}:${extra.search || ""}:${
        extra.genre || ""
      }:${extra.skip || ""}`;
      const cached = await cacheGet(cacheKey, env.STREAM_CACHE);
      if (cached) return json(cached);
      try {
        const result = await getCatalog(catalogId, extra, env);
        await cacheSet(
          cacheKey,
          result,
          // El consolidado cuesta ~7 requests por página: se cachea 1h en
          // vez de los 10 min estándar.
          catalogId.startsWith("alldoramas") ? 60 * 60 : TTL.catalog,
          env.STREAM_CACHE
        );
        return json(result);
      } catch (e) {
        return json({ metas: [], error: String(e) });
      }
    }

    const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (metaM) {
      const id = decodeURIComponent(metaM[2]);
      // v2: los metas ahora exponen `genres` (scrape de la ficha) — bump de
      // clave para no servir metas cacheados sin géneros hasta su TTL.
      const cached = await cacheGet(`meta:v2:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      try {
        const result = await getMeta(id, tmdbKey, env);
        await cacheSet(`meta:v2:${id}`, result, TTL.meta, env.STREAM_CACHE);
        return json(result);
      } catch (e) {
        return json({ meta: null, error: String(e) });
      }
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      const cached = await cacheGet(`stream:v4:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      try {
        const { isDecoyUrl } = await import("./extractors");
        const result = await getStreams(id, env);
        result.streams = result.streams.filter(
          (st: { url?: string; externalUrl?: string }) =>
            !isDecoyUrl(st.url || st.externalUrl || "")
        );
        if (result.streams.length > 0)
          await cacheSet(
            `stream:v4:${id}`,
            result,
            TTL.stream,
            env.STREAM_CACHE
          );
        return json(result);
      } catch (e) {
        return json({ streams: [], error: String(e) });
      }
    }

    if (path === "/proxy/m3u8") {
      const m3u8Url = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://doramasflix.in/";
      if (!m3u8Url) return new Response("Missing url", { status: 400 });
      try {
        const base = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
        const workerBase = new URL(request.url).origin;
        const proxied = (absUrl: string, forceM3u8 = false) => {
          const route =
            forceM3u8 || absUrl.includes(".m3u8") ? "m3u8" : "seg";
          return `${workerBase}/proxy/${route}?url=${encodeURIComponent(
            absUrl
          )}&ref=${encodeURIComponent(referer)}`;
        };
        const r = await netFetch("direct", m3u8Url, {
          headers: {
            Referer: referer,
            Origin: new URL(referer).origin,
            "User-Agent": MOBILE_UA,
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok)
          return new Response(`Upstream ${r.status}`, { status: r.status });
        const m3u8Text = await r.text();
        const isMaster = m3u8Text.includes("#EXT-X-STREAM-INF");
        const rewritten = m3u8Text
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (trimmed === "") return line;
            if (trimmed.startsWith("#")) {
              const uriM = line.match(/URI="([^"]+)"/);
              if (!uriM) return line;
              const absUri = uriM[1].startsWith("http")
                ? uriM[1]
                : base + uriM[1];
              return line.replace(uriM[1], proxied(absUri));
            }
            const absUrl = trimmed.startsWith("http")
              ? trimmed
              : base + trimmed;
            return proxied(absUrl, isMaster);
          })
          .join("\n");
        return new Response(rewritten, {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
          },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    if (path === "/proxy/seg") {
      const segUrl = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "https://doramasflix.in/";
      if (!segUrl) return new Response("Missing url", { status: 400 });
      try {
        const r = await netFetch("direct", segUrl, {
          headers: {
            Referer: referer,
            Origin: new URL(referer).origin,
            "User-Agent": MOBILE_UA,
          },
        });
        if (!r.ok)
          return new Response(`Upstream ${r.status}`, { status: r.status });
        return new Response(r.body, {
          headers: {
            "Content-Type":
              r.headers.get("Content-Type") || "video/MP2T",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
