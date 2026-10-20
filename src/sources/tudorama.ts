import { Env } from "../types";
import { CHROME_HEADERS, CHROME_UA, decodeEntities, fetchTmdb, netFetch, toMetaPreview } from "../utils";
import { extractMp4upload } from "../extractors";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

export const TUDORAMA_BASE = "https://tudorama.com";
export const TUDORAMA_LABEL = "TuDorama";
export const TUDORAMA_PREFIX = "tudorama";

export async function fetchTudorama(
  url: string,
  env?: Env,
  timeoutMs = 12000
): Promise<string> {
  const proxyBase = env?.FETCH_PROXY_URL?.trim();
  const pull = async (name: string, r: Promise<Response>) => {
    const res = await r;
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const txt = await res.text();
    if (txt.length < 300)
      throw new Error(`${name}: too short (${txt.length}b)`);
    return txt;
  };
  const racers: Promise<string>[] = [
    pull(
      "direct",
      netFetch("direct", url, {
        headers: CHROME_HEADERS,
        signal: AbortSignal.timeout(8000),
      })
    ),
  ];
  if (proxyBase) {
    racers.push(
      pull(
        "relay",
        netFetch("proxy", `${proxyBase}?url=${encodeURIComponent(url)}`, {
          headers: { "User-Agent": CHROME_UA },
          signal: AbortSignal.timeout(timeoutMs),
        })
      )
    );
  }
  return Promise.any(racers);
}

export function cleanTudoramaTitle(s: string): string {
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

export function parseTudoramaCards(html: string) {
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
      name: cleanTudoramaTitle(rawName) || slug,
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
    cleanTudoramaTitle(
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
  // preferencia data-src + nunca "data:" (igual que doramas.ts)
  const imgFromTag = (attrs: string): string =>
    [attrs.match(/data-src=["']([^"']+)["']/i)?.[1] || "",
     attrs.match(/(?:^|\s)src=["']([^"']+)["']/i)?.[1] || ""]
      .find((u) => u && !u.startsWith("data:")) || "";
  for (const m of html.matchAll(
    /<img\b([^>]*)>[\s\S]{0,420}?href=["'](?:https?:\/\/tudorama\.com)?\/ver\/([a-z0-9-]+)-s(\d+)x(\d+)\/["']/gi
  )) {
    const raw = imgFromTag(m[1]);
    if (raw) pushThumb(`${m[2]}-s${m[3]}x${m[4]}`, raw);
  }

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

export async function resolveTudoramaEpisodeSlug(
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
  env: Env,
  request: Request
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

  const denoBase = (env.FETCH_PROXY_URL || "")
    .trim()
    .replace(/\/fetch\/?$/, "")
    .replace(/\/$/, "");

  const streams: any[] = [];
  const seenUrl = new Set<string>();

  const add = (s: any) => {
    const k = s.url || s.externalUrl;
    if (k && !seenUrl.has(k)) {
      seenUrl.add(k);
      streams.push(s);
    }
  };

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

    const host =
      embed.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] || item.name || "host";

    const ext = () =>
      add({
        externalUrl: embed,
        name: `${TUDORAMA_LABEL} 🌐`,
        title: `🌐 ${host} — ${TUDORAMA_LABEL}`,
      });

    if (
      /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|do7go|playmogo/i.test(
        embed
      )
    ) {
      if (denoBase) {
        add({
          url: `${denoBase}/streamwish?url=${encodeURIComponent(embed)}`,
          name: `${TUDORAMA_LABEL} HLS`,
          title: `▶ streamwish — ${TUDORAMA_LABEL}`,
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.m3u8`,
            bingeGroup: `${TUDORAMA_PREFIX}-streamwish`,
          },
        });
      } else {
        ext();
      }
      continue;
    }

    if (embed.includes("mp4upload.com")) {
      const u = await extractMp4upload(embed);
      if (u) {
        add({
          url: u,
          name: `${TUDORAMA_LABEL} MP4`,
          title: `▶ mp4upload — ${TUDORAMA_LABEL}`,
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.mp4`,
            bingeGroup: `${TUDORAMA_PREFIX}-mp4upload`,
          },
        });
        continue;
      }
    }

    ext();
  }

  return { streams };
}
