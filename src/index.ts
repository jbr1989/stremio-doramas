import { Env } from "./types";
import { MANIFEST } from "./manifest";
import {
  CORS,
  json,
  TTL,
  cacheGet,
  cacheSet,
  browserRenderingReady,
  netFetch,
  renderPage,
  isCfChallenge,
} from "./utils";
import {
  extractHexload,
  extractMp4upload,
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

async function getCatalog(
  catalogId: string,
  extra: Record<string, string>,
  env?: Env
) {
  if (catalogId.startsWith("doramaslat"))
    return getDoramaCatalog(DORAMA_SOURCES.dlat, extra, env);
  if (catalogId.startsWith("doramedplay"))
    return getDoramaCatalog(DORAMA_SOURCES.dsub, extra, env);
  if (catalogId.startsWith("kplay")) return getKplayCatalog(extra, env);
  if (catalogId.startsWith("doramasflix"))
    return getDoramasflixCatalog(extra, env);
  return getDoramasflixCatalog(extra, env);
}

async function getMeta(id: string, tmdbKey: string, env?: Env) {
  if (id.startsWith("dlat:"))
    return getDoramaMeta(DORAMA_SOURCES.dlat, id, tmdbKey, env);
  if (id.startsWith("dsub:"))
    return getDoramaMeta(DORAMA_SOURCES.dsub, id, tmdbKey, env);
  if (id.startsWith("kplay:")) return getKplayMeta(id, tmdbKey, env);
  if (id.startsWith("dflix:")) return getDoramasflixMeta(id, tmdbKey, env);
  return { meta: null };
}

async function getStreams(rawId: string, env: Env, request: Request) {
  if (rawId.startsWith("dlat:"))
    return getDoramaStreams(DORAMA_SOURCES.dlat, rawId, env, request);
  if (rawId.startsWith("dsub:"))
    return getDoramaStreams(DORAMA_SOURCES.dsub, rawId, env, request);
  if (rawId.startsWith("kplay:")) return getKplayStreams(rawId, env, request);
  if (rawId.startsWith("dflix:"))
    return getDoramasflixStreams(rawId, env, request);
  return { streams: [] };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const tmdbKey = (env.TMDB_KEY || "").trim();

    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });
    if (path === "/" || path === "/manifest.json") return json(MANIFEST);

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
        const result = await getStreams(id, env, request);
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
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
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
      const denoBase = (env.FETCH_PROXY_URL || "")
        .trim()
        .replace(/\/fetch\/?$/, "")
        .replace(/\/$/, "");
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

    if (path === "/cache-clear") {
      const key = url.searchParams.get("key");
      if (key && env.STREAM_CACHE) {
        await env.STREAM_CACHE.delete(key);
        return json({ cleared: key });
      }
      return json({
        error:
          "Missing ?key= (full KV key, e.g. stream:v3:dflix:slug-1x1) or no KV binding",
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
          TTL.catalog,
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
      const cached = await cacheGet(`meta:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      try {
        const result = await getMeta(id, tmdbKey, env);
        await cacheSet(`meta:${id}`, result, TTL.meta, env.STREAM_CACHE);
        return json(result);
      } catch (e) {
        return json({ meta: null, error: String(e) });
      }
    }

    const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (streamM) {
      const id = decodeURIComponent(streamM[2]);
      const cached = await cacheGet(`stream:v3:${id}`, env.STREAM_CACHE);
      if (cached) return json(cached);
      try {
        const { isDecoyUrl } = await import("./extractors");
        const result = await getStreams(id, env, request);
        result.streams = result.streams.filter(
          (st: { url?: string; externalUrl?: string }) =>
            !isDecoyUrl(st.url || st.externalUrl || "")
        );
        if (result.streams.length > 0)
          await cacheSet(
            `stream:v3:${id}`,
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
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
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
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
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
