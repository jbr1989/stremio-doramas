import { Env } from "./lib/types";
import { MANIFEST } from "./manifest";
import { LOGO_PNG_BASE64 } from "./logo";
import {
  CORS,
  json,
  TTL,
  cacheGet,
  cacheSet,
  makeStreamDeduper,
  MOBILE_UA,
  netFetch,
} from "./lib/utils";
import {
  SOURCES,
  sourceByPrefix,
} from "./registry";
import { doramasflixSource } from "./sources/doramasflix";
import { getAllAlldoramasCatalog } from "./alldoramas";
import { handleDebug, isDebugPath } from "./debug";

async function getCatalog(
  catalogId: string,
  extra: Record<string, string>,
  env?: Env
) {
  if (catalogId.startsWith("alldoramas"))
    return getAllAlldoramasCatalog(extra, env);
  // El orden de SOURCES importa: los catalogId no se solapan, pero se
  // respeta el orden de registro igual que en la cadena original.
  const def = SOURCES.find((s) => catalogId.startsWith(s.catalogId));
  return def ? def.getCatalog(extra, env) : doramasflixSource.getCatalog(extra);
}

async function getMeta(id: string, tmdbKey: string, env?: Env) {
  const def = sourceByPrefix(id.split(":")[0]);
  return def ? def.getMeta(id, tmdbKey, env) : { meta: null };
}

async function getStreams(rawId: string, env: Env) {
  // Slug canónico compartido: cada fuente traduce su id propio (la tabla
  // registry soporta toEpSlug async, p.ej. pandrama resuelve su video vía KV).
  const def = sourceByPrefix(rawId.split(":")[0]);
  let epSlug = "";
  if (def) {
    epSlug = (def.toEpSlug ? await def.toEpSlug(rawId, env) : rawId.slice(def.prefix.length + 1)) || "";
  }

  const tasks: Promise<{ streams: any[] }>[] = [];

  for (const s of SOURCES) {
    if (rawId.startsWith(`${s.prefix}:`)) {
      tasks.push(s.getStreams(rawId, env));
    } else if (epSlug) {
      tasks.push(s.getStreams(s.buildId?.(epSlug) ?? `${s.prefix}:${epSlug}`, env));
    }
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

    if (isDebugPath(path)) {
      const resp = await handleDebug(request, url, path, env, {
        getCatalog,
        getMeta,
        getStreams,
      });
      if (resp) return resp;
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
        const { isDecoyUrl } = await import("./lib/extractors");
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
