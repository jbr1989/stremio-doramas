import { Env } from "../types";
import { CHROME_HEADERS, CHROME_UA, decodeEntities, fetchTmdb, netFetch, toMetaPreview } from "../utils";
import { extractMp4upload } from "../extractors";

export interface DoramaSource {
  prefix: string;
  base: string;
  label: string;
}

export const DORAMA_SOURCES: Record<string, DoramaSource> = {
  dorama: {
    prefix: "dorama",
    base: "https://doramaslat.com",
    label: "Doramas Latino",
  },
  dsub: {
    prefix: "dsub",
    base: "https://doramedplay.net",
    label: "Doramas Sub",
  },
};

export async function fetchDorama(
  url: string,
  env?: Env,
  timeoutMs = 12000
): Promise<string> {
  const proxyBase = env?.FETCH_PROXY_URL?.trim();
  const pull = async (name: string, r: Promise<Response>) => {
    const res = await r;
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const txt = await res.text();
    if (txt.length < 400)
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

export function cleanDoramaTitle(s: string): string {
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

export function parseDoramaCards(html: string, src: DoramaSource) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  const push = (slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${src.base}${rawPoster}`
      : "";
    results.push({
      id: `${src.prefix}:${slug}`,
      name: cleanDoramaTitle(rawName) || slug,
      poster,
    });
  };
  for (const m of html.matchAll(
    /<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"[\s\S]{0,220}?\/tvshows\/([a-z0-9-]+)\//gi
  )) {
    push(m[3], m[1], m[2]);
  }
  for (const m of html.matchAll(
    /\/tvshows\/([a-z0-9-]+)\/"[^>]*>[\s\S]{0,80}?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"/gi
  )) {
    push(m[1], m[2], m[3]);
  }
  return results.slice(0, 100);
}

export async function getDoramaCatalog(
  src: DoramaSource,
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    return {
      metas: parseDoramaCards(
        await fetchDorama(
          `${src.base}/?s=${encodeURIComponent(q)}`,
          env
        ),
        src
      ).map(toMetaPreview),
    };
  }
  const page = Math.floor(parseInt(extra.skip || "0", 10) / 45) + 1;
  const path =
    page > 1
      ? `${src.base}/tvshows/page/${page}/`
      : `${src.base}/tvshows/`;
  return {
    metas: parseDoramaCards(await fetchDorama(path, env), src).map(
      toMetaPreview
    ),
  };
}

export async function getDoramaMeta(
  src: DoramaSource,
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const slug = id.slice(src.prefix.length + 1);
  const html = await fetchDorama(`${src.base}/tvshows/${slug}/`, env);
  const name =
    cleanDoramaTitle(
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;
  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(
      /<div class="poster">\s*<img[^>]+(?:data-src|src)="([^"]+)"/i
    )?.[1] ||
    "";
  const description = decodeEntities(
    html.match(
      /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i
    )?.[1] ||
      html.match(
        /<div[^>]+itemprop="description"[^>]*>([\s\S]*?)<\/div>/i
      )?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const episodes: { slug: string; s: number; e: number }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /\/episodes\/([a-z0-9-]+-(\d+)x(\d+))\/?/gi
  )) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    episodes.push({
      slug: m[1],
      s: parseInt(m[2], 10),
      e: parseInt(m[3], 10),
    });
  }
  episodes.sort((a, b) => a.s - b.s || a.e - b.e);

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
        id: `${src.prefix}:${ep.slug}`,
        title: `T${ep.s} · Episodio ${ep.e}`,
        season: ep.s,
        episode: ep.e,
      })),
    },
  };
}

export async function resolveDoramaEmbed(
  src: DoramaSource,
  post: string,
  nume: string,
  type: string,
  env?: Env
): Promise<string | null> {
  try {
    const r = await netFetch("direct", `${src.base}/wp-admin/admin-ajax.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${src.base}/`,
        "User-Agent": CHROME_UA,
      },
      body: `action=doo_player_ajax&post=${encodeURIComponent(
        post
      )}&nume=${encodeURIComponent(nume)}&type=${encodeURIComponent(type)}`,
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    const embed = typeof data?.embed_url === "string" ? data.embed_url : "";
    if (!embed) return null;
    let embedSrc =
      embed.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1] || embed.trim();
    embedSrc = embedSrc.replace(/\\\//g, "/");
    if (embedSrc.startsWith("//")) embedSrc = `https:${embedSrc}`;
    return /^https?:\/\//i.test(embedSrc) ? embedSrc : null;
  } catch {
    return null;
  }
}

export async function getDoramaStreams(
  src: DoramaSource,
  rawId: string,
  env: Env,
  request: Request
) {
  const epSlug = rawId.slice(src.prefix.length + 1);
  if (!/-\d+x\d+$/.test(epSlug)) return { streams: [] };
  const html = await fetchDorama(`${src.base}/episodes/${epSlug}/`, env);

  const options: { post: string; nume: string; type: string }[] = [];
  for (const li of html.matchAll(/<li[^>]*dooplay_player_option[^>]*>/gi)) {
    const tag = li[0];
    const post = tag.match(/data-post=["']([^"']+)["']/i)?.[1];
    const nume = tag.match(/data-nume=["']([^"']+)["']/i)?.[1];
    const type = tag.match(/data-type=["']([^"']+)["']/i)?.[1] || "tv";
    if (post && nume) options.push({ post, nume, type });
  }
  if (options.length === 0) return { streams: [] };

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

  const embeds = await Promise.all(
    options.map((o) =>
      resolveDoramaEmbed(src, o.post, o.nume, o.type, env)
    )
  );
  for (const embed of embeds) {
    if (!embed) continue;
    const host =
      embed.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] || "host";
    const ext = () =>
      add({
        externalUrl: embed,
        name: `${src.label} 🌐`,
        title: `🌐 ${host} — ${src.label}`,
      });

    if (
      // Espejos de StreamWish admitidos — mantén sincronizado con deno/fetch.ts
      // (allowlist de /streamwish) y con las otras fuentes.
      /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|do7go|playmogo/i.test(
        embed
      )
    ) {
      if (denoBase)
        add({
          url: `${denoBase}/streamwish?url=${encodeURIComponent(embed)}`,
          name: `${src.label} HLS`,
          title: `▶ streamwish — ${src.label}`,
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.m3u8`,
            bingeGroup: `${src.prefix}-streamwish`,
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
          name: `${src.label} MP4`,
          title: `▶ mp4upload — ${src.label}`,
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.mp4`,
            bingeGroup: `${src.prefix}-mp4upload`,
          },
        });
        continue;
      }
    }
    ext();
  }
  return { streams };
}
