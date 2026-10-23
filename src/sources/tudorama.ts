import { Env } from "../types";
import { genreSlug } from "../genres";
import { CHROME_UA, cleanTitle, decodeEntities, denoBaseFromEnv, fetchTmdb, makeStreamDeduper, netFetch, racerFetch, toMetaPreview } from "../utils";
import { addEmbedStreams } from "../extractors";
import { genresFromListItems, imgFromTag } from "./dooplay";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

const TUDORAMA_BASE = "https://tudorama.com";
const TUDORAMA_LABEL = "TuDorama";
const TUDORAMA_PREFIX = "tudorama";

async function fetchTudorama(
  url: string,
  env?: Env,
  timeoutMs = 12000
): Promise<string> {
  return racerFetch(url, env, { minLen: 300, proxyTimeoutMs: timeoutMs });
}

function parseTudoramaCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();

  const push = (slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${TUDORAMA_BASE}${rawPoster}`
      : "";
    results.push({
      id: `${TUDORAMA_PREFIX}:${slug}`,
      name: cleanTitle(rawName) || slug,
      poster,
    });
  };

  // Cards format in TuDorama: <article class="ipst"> ... <a href="https://tudorama.com/serie/{slug}/"> <img src="..." alt="{title}">
  for (const m of html.matchAll(
    /href=["'](?:https?:\/\/tudorama\.com)?\/serie\/([a-z0-9-]+)\/["'][^>]*>[\s\S]{0,300}?<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/gi
  )) {
    push(m[1], m[2], m[3]);
  }

  // Alternative ordering in html
  for (const m of html.matchAll(
    /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][\s\S]{0,300}?href=["'](?:https?:\/\/tudorama\.com)?\/serie\/([a-z0-9-]+)\/["']/gi
  )) {
    push(m[3], m[1], m[2]);
  }

  return results.slice(0, 100);
}

export async function getTudoramaCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    return {
      metas: parseTudoramaCards(
        await fetchTudorama(`${TUDORAMA_BASE}/?s=${encodeURIComponent(q)}`, env)
      ).map(toMetaPreview),
    };
  }

  // Género (label ES → slug vía la lista maestra canónica, src/genres.ts).
  // Archivo /genres/{slug}/ — es la base que el propio sitio usa en sus fichas
  // (su directorio vive en /genero/series/, distinta taxonomía) — paginado con
  // /page/N/. Solo se exponen los slugs verificados con cards upstream; el
  // catch devuelve vacío en vez de un error para Stremio.
  const g = (extra.genre || "").trim();
  if (g) {
    const slug = genreSlug("tudorama", g);
    if (!slug) return { metas: [] };
    const gpage = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
    const gpath =
      gpage > 1
        ? `${TUDORAMA_BASE}/genres/${slug}/page/${gpage}/`
        : `${TUDORAMA_BASE}/genres/${slug}/`;
    let ghtml = "";
    try {
      ghtml = await fetchTudorama(gpath, env);
    } catch {
      ghtml = "";
    }
    return { metas: ghtml ? parseTudoramaCards(ghtml).map(toMetaPreview) : [] };
  }

  const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
  const path =
    page > 1
      ? `${TUDORAMA_BASE}/genero/series/page/${page}/`
      : `${TUDORAMA_BASE}/genero/series/`;

  return {
    metas: parseTudoramaCards(await fetchTudorama(path, env)).map(toMetaPreview),
  };
}

export async function getTudoramaMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const slug = id.slice(TUDORAMA_PREFIX.length + 1);
  const html = await fetchTudorama(`${TUDORAMA_BASE}/serie/${slug}/`, env);

  const name =
    cleanTitle(
      html.match(/<meta[^>]+property="og:title"[^>]+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;

  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<picture[^>]*>\s*<img[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
    "";

  const description = decodeEntities(
    html.match(/<meta[^>]+property="og:description"[^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<p[^>]+class=["']hero__overview["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const episodes: { slug: string; s: number; e: number }[] = [];
  const seen = new Set<string>();

  // TuDorama episode links: href="https://tudorama.com/ver/{seriesSlug}-s{season}x{episode}/"
  for (const m of html.matchAll(
    /\/ver\/([a-z0-9-]+)-s(\d+)x(\d+)\/?/gi
  )) {
    const epKey = `${m[1]}-s${m[2]}x${m[3]}`;
    if (seen.has(epKey)) continue;
    seen.add(epKey);
    episodes.push({
      slug: epKey,
      s: parseInt(m[2], 10),
      e: parseInt(m[3], 10),
    });
  }

  // Secondary regex fallback for /ver/{slug}/
  if (episodes.length === 0) {
    for (const m of html.matchAll(/\/ver\/([a-z0-9-]+)\/?/gi)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const sxeM = m[1].match(/-s?(\d+)x(\d+)$/i);
      const s = sxeM ? parseInt(sxeM[1], 10) : 1;
      const e = sxeM ? parseInt(sxeM[2], 10) : 1;
      episodes.push({ slug: m[1], s, e });
    }
  }

  episodes.sort((a, b) => a.s - b.s || a.e - b.e);

  // Miniaturas de episodio. Cada <li class="lep"> va:
  // <div class="lep__thumbnail"><img src="thumb"></div><div class="lep__body">…
  // <div class="lep__play">… <a href=".../ver/{slug}-s{S}x{E}/"> — la <img> del
  // propio <li> precede al href (≤ ~390 chars entre spans y botón de play).
  const thumbs = new Map<string, string>();
  const pushThumb = (epSlug: string, raw: string) => {
    if (thumbs.has(epSlug)) return;
    const thumb = raw.startsWith("http")
      ? raw
      : raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
      ? `${TUDORAMA_BASE}${raw}`
      : "";
    if (thumb) thumbs.set(epSlug, thumb);
  };
  // preferencia data-src + nunca "data:" → imgFromTag (dooplay.ts)
  for (const m of html.matchAll(
    /<img\b([^>]*)>[\s\S]{0,420}?href=["'](?:https?:\/\/tudorama\.com)?\/ver\/([a-z0-9-]+)-s(\d+)x(\d+)\/["']/gi
  )) {
    const raw = imgFromTag(m[1]);
    if (raw) pushThumb(`${m[2]}-s${m[3]}x${m[4]}`, raw);
  }

  // Géneros de la ficha: <li><a href="…/genres/{slug}/"> del sitio (las
  // anclas sueltas son géneros de las cards "similares" — excluidas por
  // exigir <li>; verificado in-vivo 3 vs 20). Label canónico (src/genres.ts)
  // o texto del sitio tal cual (dooplay.ts).
  const genres = genresFromListItems(html, "genres", TUDORAMA_PREFIX);

  const tmdb = await fetchTmdb(name, tmdbKey);
  return {
    meta: {
      id,
      type: "series",
      name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || poster,
      description: tmdb?.description || description,
      posterShape: "poster",
      releaseInfo: tmdb?.year || "",
      genres,
      videos: episodes.map((ep) => ({
        id: `${TUDORAMA_PREFIX}:${ep.slug.replace(/-s(\d+)x(\d+)$/, "-$1x$2")}`,
        title: `T${ep.s} · Episodio ${ep.e}`,
        season: ep.s,
        episode: ep.e,
        thumbnail: thumbs.get(ep.slug) || poster,
      })),
    },
  };
}

async function resolveTudoramaEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: TUDORAMA_PREFIX,
      searchSeries: async (title) => {
        const slugs = new Set<string>();
        for (const v of searchVariants(title)) {
          const html = await fetchTudorama(
            `${TUDORAMA_BASE}/?s=${encodeURIComponent(v)}`,
            env
          );
          for (const m of html.matchAll(/\/serie\/([a-z0-9-]+)\//gi)) {
            slugs.add(m[1]);
          }
        }
        return [...slugs];
      },
      fetchEpisodes: async (seriesSlug) => {
        const html = await fetchTudorama(
          `${TUDORAMA_BASE}/serie/${seriesSlug}/`,
          env
        );
        const episodes: { s: number; e: number; epSlug: string }[] = [];
        const seen = new Set<string>();
        for (const m of html.matchAll(
          /\/ver\/([a-z0-9-]+)-s(\d+)x(\d+)\/?/gi
        )) {
          const rawSlug = `${m[1]}-s${m[2]}x${m[3]}`;
          if (seen.has(rawSlug)) continue;
          seen.add(rawSlug);
          episodes.push({
            epSlug: `${m[1]}-1x${m[3]}`,
            s: parseInt(m[2], 10),
            e: parseInt(m[3], 10),
          });
        }
        return episodes;
      },
    },
    epSlug,
    env
  );
}

export async function getTudoramaStreams(
  rawId: string,
  env: Env
) {
  let epSlug = rawId.slice(TUDORAMA_PREFIX.length + 1);

  // Normalize SxE slug format: {series}-1x1 -> {series}-s1x1 if needed
  let pageSlug = epSlug;
  const sxeMatch = epSlug.match(/-(?:s)?(\d+)x(\d+)$/i);
  if (sxeMatch) {
    const seriesBase = epSlug.replace(/-(?:s)?\d+x\d+$/i, "");
    pageSlug = `${seriesBase}-s${sxeMatch[1]}x${sxeMatch[2]}`;
  }

  let html = "";
  try {
    html = await fetchTudorama(`${TUDORAMA_BASE}/ver/${pageSlug}/`, env);
  } catch {
    html = "";
  }

  if (!html) {
    const resolved = await resolveTudoramaEpisodeSlug(epSlug, env);
    if (resolved && resolved !== epSlug) {
      const resSxe = resolved.match(/-(?:s)?(\d+)x(\d+)$/i);
      if (resSxe) {
        const base = resolved.replace(/-(?:s)?\d+x\d+$/i, "");
        pageSlug = `${base}-s${resSxe[1]}x${resSxe[2]}`;
      } else {
        pageSlug = resolved;
      }
      try {
        html = await fetchTudorama(`${TUDORAMA_BASE}/ver/${pageSlug}/`, env);
      } catch {
        html = "";
      }
    }
  }

  if (!html) return { streams: [] };

  // Extract post_id and nonce for corvus_get_servers AJAX call
  const postId = html.match(/data-id=["'](\d+)["']/i)?.[1];
  const nonce = html.match(/data-nonce=["']([a-z0-9]+)["']/i)?.[1];

  let serverItems: { url: string; name: string; type: string }[] = [];

  if (postId && nonce) {
    try {
      const res = await netFetch("direct", `${TUDORAMA_BASE}/wp-admin/admin-ajax.php`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": CHROME_UA,
          Referer: `${TUDORAMA_BASE}/ver/${pageSlug}/`,
        },
        body: `action=corvus_get_servers&post_id=${encodeURIComponent(
          postId
        )}&nonce=${encodeURIComponent(nonce)}`,
        signal: AbortSignal.timeout(9000),
      });
      if (res.ok) {
        const data: any = await res.json();
        if (Array.isArray(data)) {
          serverItems = data.map((item) => ({
            url: item.url || item.link || "",
            name: item.name || item.server || "server",
            type: item.type || "embed",
          }));
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback if AJAX didn't return or failed: scrape links inside HTML
  if (serverItems.length === 0) {
    for (const m of html.matchAll(/https?:\/\/cdn\.tudorama\.com\/stream\/[^\s"']+/gi)) {
      serverItems.push({ url: m[0], name: "server", type: "embed" });
    }
  }

  const denoBase = denoBaseFromEnv(env);
  const { add, streams } = makeStreamDeduper();

  // Resolve cdn.tudorama.com wrapper links if necessary
  const resolvedEmbeds = await Promise.all(
    serverItems.map(async (item) => {
      let embedUrl = item.url;
      if (embedUrl.includes("cdn.tudorama.com/stream/")) {
        try {
          const r = await netFetch("direct", embedUrl, {
            headers: {
              Referer: `${TUDORAMA_BASE}/`,
              "User-Agent": CHROME_UA,
            },
            signal: AbortSignal.timeout(8000),
          });
          const pageHtml = await r.text();
          const iframeSrc = pageHtml.match(/iframe\.src\s*=\s*["']([^"']+)["']/i)?.[1] ||
                            pageHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
          if (iframeSrc) embedUrl = iframeSrc;
        } catch {
          // keep original
        }
      }
      return { ...item, embedUrl };
    })
  );

  for (const item of resolvedEmbeds) {
    const embed = item.embedUrl;
    if (!embed) continue;
    await addEmbedStreams({
      embed,
      epSlug,
      label: TUDORAMA_LABEL,
      prefix: TUDORAMA_PREFIX,
      denoBase,
      add,
      hostFallback: item.name,
      env,
    });
  }

  return { streams };
}
