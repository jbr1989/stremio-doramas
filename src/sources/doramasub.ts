import { Env } from "../types";
import { genreSlug } from "../genres";
import {
  cleanTitle,
  decodeEntities,
  denoBaseFromEnv,
  fetchHtml,
  fetchTmdb,
  makeStreamDeduper,
  toMetaPreview,
} from "../utils";
import { addEmbedStreams } from "../extractors";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

const DORAMASUB_BASE = "https://www.doramasub.com";

export function canonicalDoramaSubSlug(slug: string): string {
  if (/-\d+x\d+$/.test(slug)) return slug;
  // e.g. 2026/10/el-escandalo-capitulo-08 -> el-escandalo-1x8
  const pathPart = slug.split("/").pop() || slug;
  const m = pathPart.match(/^(.*?)-capitulo-(\d+)$/i);
  if (!m) return slug;
  return `${m[1]}-1x${parseInt(m[2], 10)}`;
}

function parseFeedEntryCard(entry: any) {
  const titleRaw = entry?.title?.$t || "";
  const links = entry?.link || [];
  const altLink =
    links.find((l: any) => l?.rel === "alternate")?.href || "";
  if (!altLink || !altLink.includes("doramasub.com")) return null;

  const categories: string[] = (entry?.category || []).map(
    (c: any) => c?.term || ""
  );
  if (
    categories.includes("capitulos") ||
    /cap[ií]tulo/i.test(titleRaw) ||
    /cap[ií]tulo/i.test(altLink)
  ) {
    return null;
  }

  const slug = altLink
    .replace(/^https?:\/\/(www\.)?doramasub\.com\//i, "")
    .replace(/\.html$/i, "");
  if (!slug) return null;

  let poster = entry?.media$thumbnail?.url || "";
  if (!poster || /nth\.png/i.test(poster)) {
    const content = entry?.content?.$t || "";
    const m = content.match(/src=["']([^"']+)["']/i);
    if (m) poster = m[1];
  }
  if (poster.startsWith("//")) poster = `https:${poster}`;

  const cleanName = cleanTitle(titleRaw.replace(/\s*\(\d{4}\).*$/, "")) || titleRaw;

  return {
    id: `dsub:${slug}`,
    name: cleanName,
    poster,
  };
}

export async function getDoramaSubCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  const g = (extra.genre || "").trim();

  let feedUrl = "";
  if (q) {
    feedUrl = `${DORAMASUB_BASE}/feeds/posts/default?alt=json&q=${encodeURIComponent(
      q
    )}&max-results=50`;
  } else if (g) {
    const gslug = genreSlug("dsub", g) || g.toLowerCase();
    const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
    const startIndex = (page - 1) * 24 + 1;
    feedUrl = `${DORAMASUB_BASE}/feeds/posts/default/-/${encodeURIComponent(
      gslug
    )}?alt=json&start-index=${startIndex}&max-results=24`;
  } else {
    const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
    const startIndex = (page - 1) * 24 + 1;
    feedUrl = `${DORAMASUB_BASE}/feeds/posts/default/-/series?alt=json&start-index=${startIndex}&max-results=24`;
  }

  let htmlOrJson = "";
  try {
    htmlOrJson = await fetchHtml(feedUrl, env);
  } catch {
    htmlOrJson = "";
  }

  if (!htmlOrJson) return { metas: [] };

  try {
    const data = JSON.parse(htmlOrJson);
    const entries = data?.feed?.entry || [];
    const results = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const card = parseFeedEntryCard(entry);
      if (card && !seen.has(card.id)) {
        seen.add(card.id);
        results.push(card);
      }
    }

    if (q && results.length === 0) {
      // Fallback si la búsqueda en Blogger feed requiere palabras exactas
      const altFeedUrl = `${DORAMASUB_BASE}/feeds/posts/default/-/series?alt=json&start-index=1&max-results=50`;
      try {
        const altJson = await fetchHtml(altFeedUrl, env);
        const altData = JSON.parse(altJson);
        for (const entry of altData?.feed?.entry || []) {
          const card = parseFeedEntryCard(entry);
          if (
            card &&
            !seen.has(card.id) &&
            card.name.toLowerCase().includes(q.toLowerCase())
          ) {
            seen.add(card.id);
            results.push(card);
          }
        }
      } catch {}
    }

    return { metas: results.map(toMetaPreview) };
  } catch {
    return { metas: [] };
  }
}

export async function getDoramaSubMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const slug = id.replace(/^dsub:/, "");
  const pageUrl = `${DORAMASUB_BASE}/${slug}.html`;

  let html = "";
  try {
    html = await fetchHtml(pageUrl, env);
  } catch {
    return { meta: null };
  }

  const rawTitle =
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
    slug;
  const name = cleanTitle(rawTitle.replace(/\s*\(\d{4}\).*$/, "")) || rawTitle;

  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    "";

  const description = decodeEntities(
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Buscar episodios vía Blogger Feed API filtrando por nombre de la serie
  const epMap = new Map<number, { slug: string; title: string; thumb: string }>();

  try {
    const feedUrl = `${DORAMASUB_BASE}/feeds/posts/default?alt=json&q=${encodeURIComponent(
      name
    )}&max-results=150`;
    const feedRes = await fetchHtml(feedUrl, env);
    const feedData = JSON.parse(feedRes);
    for (const entry of feedData?.feed?.entry || []) {
      const links = entry?.link || [];
      const altLink =
        links.find((l: any) => l?.rel === "alternate")?.href || "";
      if (!altLink || !altLink.includes("capitulo")) continue;

      const epSlug = altLink
        .replace(/^https?:\/\/(www\.)?doramasub\.com\//i, "")
        .replace(/\.html$/i, "");
      const epTitle = entry?.title?.$t || "";
      const epNumM =
        epTitle.match(/cap[ií]tulo\s*(\d+)/i) ||
        epSlug.match(/capitulo-(\d+)/i);
      if (!epNumM) continue;

      const epNum = parseInt(epNumM[1], 10);
      let thumb = entry?.media$thumbnail?.url || "";
      if (!thumb || /nth\.png/i.test(thumb)) {
        const content = entry?.content?.$t || "";
        const m = content.match(/src=["']([^"']+)["']/i);
        if (m) thumb = m[1];
      }
      if (thumb.startsWith("//")) thumb = `https:${thumb}`;

      if (!epMap.has(epNum)) {
        epMap.set(epNum, {
          slug: epSlug,
          title: `T1 · Episodio ${epNum}`,
          thumb: thumb || poster,
        });
      }
    }
  } catch {}

  // Fallback: escanear enlaces en el HTML de la página de serie
  for (const m of html.matchAll(
    /href=["'](https?:\/\/(?:www\.)?doramasub\.com\/([^"']*?capitulo[^"']*?)\.html)["']/gi
  )) {
    const epSlug = m[2];
    const epNumM = epSlug.match(/capitulo-(\d+)/i);
    if (epNumM) {
      const epNum = parseInt(epNumM[1], 10);
      if (!epMap.has(epNum)) {
        epMap.set(epNum, {
          slug: epSlug,
          title: `T1 · Episodio ${epNum}`,
          thumb: poster,
        });
      }
    }
  }

  const sortedEpNums = [...epMap.keys()].sort((a, b) => a - b);
  const tmdb = await fetchTmdb(name, tmdbKey);

  const videos = sortedEpNums.map((epNum) => {
    const ep = epMap.get(epNum)!;
    return {
      id: `dsub:${ep.slug}`,
      title: ep.title,
      season: 1,
      episode: epNum,
      thumbnail: ep.thumb || tmdb?.poster || poster,
    };
  });

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
      genres: [],
      videos,
    },
  };
}

async function resolveDoramaSubEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: "dsub",
      searchSeries: (title) =>
        (async () => {
          const slugs = new Set<string>();
          for (const v of searchVariants(title)) {
            try {
              const feedUrl = `${DORAMASUB_BASE}/feeds/posts/default?alt=json&q=${encodeURIComponent(
                v
              )}&max-results=20`;
              const feedRes = await fetchHtml(feedUrl, env);
              const data = JSON.parse(feedRes);
              for (const entry of data?.feed?.entry || []) {
                const card = parseFeedEntryCard(entry);
                if (card) {
                  slugs.add(card.id.replace(/^dsub:/, ""));
                }
              }
            } catch {}
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          const metaRes = await getDoramaSubMeta(
            `dsub:${seriesSlug}`,
            "",
            env
          );
          const episodes: { s: number; e: number; epSlug: string }[] = [];
          for (const v of metaRes?.meta?.videos || []) {
            episodes.push({
              s: v.season,
              e: v.episode,
              epSlug: v.id.replace(/^dsub:/, ""),
            });
          }
          return episodes;
        })(),
    },
    epSlug,
    env
  );
}

export async function getDoramaSubStreams(rawId: string, env: Env) {
  let slug = rawId.replace(/^dsub:/, "");
  let pageUrl = "";

  if (slug.includes("/") && /capitulo/i.test(slug)) {
    pageUrl = `${DORAMASUB_BASE}/${slug}.html`;
  }

  let html = "";
  if (pageUrl) {
    try {
      html = await fetchHtml(pageUrl, env);
    } catch {
      html = "";
    }
  }

  if (!html) {
    const resolved = await resolveDoramaSubEpisodeSlug(slug, env);
    if (resolved && resolved !== slug) {
      console.log(`[dsub] slug resuelto: ${slug} → ${resolved}`);
      slug = resolved;
      try {
        html = await fetchHtml(`${DORAMASUB_BASE}/${slug}.html`, env);
      } catch {
        html = "";
      }
    }
  }

  if (!html) return { streams: [] };

  const embedUrls = new Set<string>();

  // Extract from script variables like _duSub = [...], _duDub = [...], _du = [...]
  for (const m of html.matchAll(/_du(?:Sub|Dub)?\s*=\s*(\[[^\]]+\])/g)) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) {
        for (const u of arr) {
          if (typeof u === "string" && /^https?:\/\//i.test(u)) {
            embedUrls.add(u.trim());
          }
        }
      }
    } catch {}
  }

  // Extract any direct iframes or known player embeds in HTML
  for (const m of html.matchAll(
    /<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/gi
  )) {
    if (!/about:blank|facebook|google/i.test(m[1])) {
      embedUrls.add(m[1].trim());
    }
  }

  if (embedUrls.size === 0) return { streams: [] };

  const denoBase = denoBaseFromEnv(env);
  const { add, streams } = makeStreamDeduper();

  for (const embed of embedUrls) {
    await addEmbedStreams({
      embed,
      epSlug: canonicalDoramaSubSlug(slug),
      label: "DoramaSub",
      prefix: "dsub",
      denoBase,
      add,
    });
  }

  return { streams };
}
