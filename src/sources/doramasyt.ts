import { Env } from "../types";
import { CHROME_UA, decodeEntities, fetchHtml, fetchTmdb, netFetch, toMetaPreview } from "../utils";
import { extractHexload, extractMp4upload } from "../extractors";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

export const DORAMASYT_BASE = "https://www.doramasyt.com";

export function cleanDoramaYtTitle(s: string): string {
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

export function parseDoramaYtCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();

  const push = (slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${DORAMASYT_BASE}${rawPoster}`
      : "";
    results.push({
      id: `dyt:${slug}`,
      name: cleanDoramaYtTitle(rawName) || slug,
      poster,
    });
  };

  for (const m of html.matchAll(
    /\/dorama\/([a-z0-9-]+)"[\s\S]*?data-src="([^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi
  )) {
    push(m[1], m[2], m[3].trim());
  }

  for (const m of html.matchAll(
    /\/dorama\/([a-z0-9-]+)"[\s\S]*?alt="Ver\s+([^"]+?)\s+online[\s\S]*?data-src="([^"]+)"/gi
  )) {
    push(m[1], m[3], m[2].trim());
  }

  return results.slice(0, 100);
}

export async function getDoramaYtCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    let html = "";
    try {
      html = await fetchHtml(`${DORAMASYT_BASE}/buscar?q=${encodeURIComponent(q)}`, env);
    } catch {
      html = "";
    }
    if (!html || !html.includes("/dorama/")) {
      try {
        html = await fetchHtml(`${DORAMASYT_BASE}/doramas`, env);
      } catch {
        html = "";
      }
    }
    const cards = parseDoramaYtCards(html);
    const filtered = q
      ? cards.filter(
          (c) =>
            c.name.toLowerCase().includes(q.toLowerCase()) ||
            c.id.toLowerCase().includes(q.toLowerCase())
        )
      : cards;
    return { metas: (filtered.length > 0 ? filtered : cards).map(toMetaPreview) };
  }

  const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
  const path = page > 1 ? `${DORAMASYT_BASE}/doramas?p=${page}` : `${DORAMASYT_BASE}/doramas`;
  let html = "";
  try {
    html = await fetchHtml(path, env);
  } catch {
    html = "";
  }
  return {
    metas: parseDoramaYtCards(html).map(toMetaPreview),
  };
}

export async function getDoramaYtMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const slug = id.replace("dyt:", "");
  let html = "";
  try {
    html = await fetchHtml(`${DORAMASYT_BASE}/dorama/${slug}`, env);
  } catch {
    return { meta: null };
  }

  const name =
    cleanDoramaYtTitle(
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
        html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;

  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/data-src=["'](https?:\/\/[^"'\s]+\/thumbs\/imagen\/[^"'\s]+)["']/i)?.[1] ||
    "";

  const description = decodeEntities(
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const ep1Match = html.match(/\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i);
  const baseEpSlug = ep1Match ? ep1Match[1] : `${slug.replace(/-sub-espanol$/, "")}-episodio-`;

  const tmdb = await fetchTmdb(name, tmdbKey);
  const epCount = tmdb?.year ? 24 : 32;

  const videos = [];
  for (let i = 1; i <= epCount; i++) {
    videos.push({
      id: `dyt:${baseEpSlug}${i}`,
      title: `T1 · Episodio ${i}`,
      season: 1,
      episode: i,
    });
  }

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
      videos,
    },
  };
}

export async function resolveDytEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: "dyt",
      searchSeries: (title) =>
        (async () => {
          const slugs = new Set<string>();
          for (const v of searchVariants(title)) {
            let html = "";
            try {
              html = await fetchHtml(`${DORAMASYT_BASE}/buscar?q=${encodeURIComponent(v)}`, env);
            } catch {
              html = "";
            }
            for (const m of html.matchAll(/\/dorama\/([a-z0-9-]+)/gi))
              slugs.add(m[1]);
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          let html = "";
          try {
            html = await fetchHtml(`${DORAMASYT_BASE}/dorama/${seriesSlug}`, env);
          } catch {
            html = "";
          }
          const ep1Match = html.match(/\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i);
          const base = ep1Match ? ep1Match[1] : `${seriesSlug.replace(/-sub-espanol$/, "")}-episodio-`;
          const episodes: { s: number; e: number; epSlug: string }[] = [];
          for (let i = 1; i <= 32; i++) {
            episodes.push({ s: 1, e: i, epSlug: `${base}${i}` });
          }
          return episodes;
        })(),
    },
    epSlug,
    env
  );
}

export async function getDoramaYtStreams(
  rawId: string,
  env: Env,
  request: Request
) {
  const epSlug = rawId.replace("dyt:", "");
  let html = "";
  try {
    html = await fetchHtml(`${DORAMASYT_BASE}/ver/${epSlug}`, env);
  } catch {
    html = "";
  }
  if (!html) return { streams: [] };

  const playerTokens: { token: string; server: string }[] = [];
  for (const m of html.matchAll(/<button[^>]*data-player="([^"]+)"[^>]*>(.*?)<\/button>/gi)) {
    playerTokens.push({ token: m[1], server: m[2].trim() });
  }

  if (playerTokens.length === 0) return { streams: [] };

  const denoBase = (env.FETCH_PROXY_URL || "")
    .trim()
    .replace(/\/fetch\/?$/, "")
    .replace(/\/$/, "");

  const embeds = await Promise.all(
    playerTokens.map(async (p) => {
      try {
        const r = await netFetch("direct", `${DORAMASYT_BASE}/reproductor?video=${encodeURIComponent(p.token)}`, {
          headers: {
            "User-Agent": CHROME_UA,
            Referer: `${DORAMASYT_BASE}/ver/${epSlug}`,
          },
          signal: AbortSignal.timeout(9000),
        });
        if (!r.ok) return null;
        const pageHtml = await r.text();
        const iframeSrc = pageHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
        if (!iframeSrc) return null;
        let url = iframeSrc.trim();
        if (url.startsWith("//")) url = `https:${url}`;
        return /^https?:\/\//i.test(url) ? url : null;
      } catch {
        return null;
      }
    })
  );

  const streams: any[] = [];
  const seenUrl = new Set<string>();
  const add = (s: any) => {
    const k = s.url || s.externalUrl;
    if (k && !seenUrl.has(k)) {
      seenUrl.add(k);
      streams.push(s);
    }
  };

  for (const embed of embeds) {
    if (!embed) continue;
    const host =
      embed.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] || "host";
    const ext = () =>
      add({
        externalUrl: embed,
        name: "DoramasYT 🌐",
        title: `🌐 ${host} — DoramasYT`,
      });

    if (
      /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|do7go|playmogo/i.test(
        embed
      )
    ) {
      if (denoBase)
        add({
          url: `${denoBase}/streamwish?url=${encodeURIComponent(embed)}`,
          name: "DoramasYT HLS",
          title: `▶ streamwish — DoramasYT`,
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.m3u8`,
            bingeGroup: "dyt-streamwish",
          },
        });
      else ext();
      continue;
    }

    if (/savefiles\.com|streamhls\.to/i.test(embed)) {
      const code = embed
        .split(/savefiles\.com\/|streamhls\.to\//)
        .pop()
        ?.replace(/^e\//, "")
        .replace(/^embed-/, "")
        .replace(/\.html$/, "")
        .split(/[/?]/)[0]
        ?.trim();
      if (denoBase && code && code.length > 3)
        add({
          url: `${denoBase}/savefiles?code=${encodeURIComponent(code)}`,
          name: "DoramasYT HLS",
          title: "▶ savefiles — DoramasYT",
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.m3u8`,
            bingeGroup: "dyt-savefiles",
          },
        });
      else ext();
      continue;
    }

    if (embed.includes("mp4upload.com")) {
      const u = await extractMp4upload(embed);
      if (u) {
        add({
          url: u,
          name: "DoramasYT MP4",
          title: "▶ mp4upload — DoramasYT",
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.mp4`,
            bingeGroup: "dyt-mp4upload",
          },
        });
        continue;
      }
    }

    if (embed.includes("hexload.com")) {
      const u = await extractHexload(embed);
      if (u) {
        add({
          url: u,
          name: "DoramasYT MP4",
          title: "▶ hexload — DoramasYT",
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.mp4`,
            bingeGroup: "dyt-hexload",
          },
        });
        continue;
      }
    }

    ext();
  }

  return { streams };
}
