import { Env } from "../lib/types";
import { cleanTitle, decodeEntities, denoBaseFromEnv, fetchHtml, fetchTmdb, makeStreamDeduper } from "../lib/utils";
import { buildMovieMeta, buildSeriesMeta, genresFromDooPlay, ogMetaFromHtml } from "../lib/dooplay";
import { addEmbedStreams } from "../lib/extractors";
import { SourceBase, SourceCard, SourceEpisode } from "../lib/sourceBase";

export const KISSKHORG_BASE = "https://kisskh.org";

export const KISSKHORG_BLOG_IDS = [
  "1057291146892246657",
  "7579509578995758860",
  "7770980406614294729",
];

export class KisskhOrgSource extends SourceBase {
  readonly prefix = "korg";
  readonly label = "KissKH.org";
  readonly catalogId = "kisskhorg";

  // Episodio = "korg:ep:{slug}-{s}x{e}" o "korg:movie:{slug}"
  readonly epIdPattern = "(?:ep:.+-\\d+x\\d+|movie:.+)";

  protected buildPageUrl(idSlug: string): string {
    return idSlug.startsWith("movie:")
      ? `${KISSKHORG_BASE}/movies/${idSlug.slice(6)}/`
      : `${KISSKHORG_BASE}/tvshows/${idSlug.replace(/^ep:/, "").replace(/-\d+x\d+$/, "")}/`;
  }

  protected buildSearchUrl(q: string): string {
    return `${KISSKHORG_BASE}/?s=${encodeURIComponent(q)}`;
  }

  protected buildListUrl(page: number): string {
    return page > 1
      ? `${KISSKHORG_BASE}/tvshows/page/${page}/`
      : `${KISSKHORG_BASE}/tvshows/`;
  }

  protected buildGenreUrl(gslug: string, page: number): string {
    return page > 1
      ? `${KISSKHORG_BASE}/genre/${encodeURIComponent(gslug)}/page/${page}/`
      : `${KISSKHORG_BASE}/genre/${encodeURIComponent(gslug)}/`;
  }

  protected override cardId(entry: SourceCard): string {
    return `${this.prefix}:${entry.type}:${entry.slug}`;
  }

  protected parseCards(html: string): SourceCard[] {
    const cards: SourceCard[] = [];
    const seen = new Set<string>();

    const pushCard = (type: "series" | "movie", slug: string, name: string, poster: string) => {
      const cleanSlug = slug.trim().replace(/^\/+|\/+$/g, "");
      if (!cleanSlug || seen.has(`${type}:${cleanSlug}`)) return;
      seen.add(`${type}:${cleanSlug}`);
      const cleanName = cleanTitle(decodeEntities(name)) || cleanSlug;
      cards.push({
        slug: cleanSlug,
        type,
        name: cleanName,
        poster: poster.startsWith("//") ? `https:${poster}` : poster,
      });
    };

    // 1. Selector de resultados de búsqueda: <div class="result-item">...
    for (const m of html.matchAll(/<div class="result-item">[\s\S]*?<\/article>/gi)) {
      const block = m[0];
      const linkM = block.match(/href=["']https?:\/\/kisskh\.org\/(tvshows|movies)\/([^\/"']+)\/?["']/i);
      const imgM = block.match(/<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/i) ||
                   block.match(/<img[^>]+alt=["']([^"']*)["'][^>]*src=["']([^"']+)["']/i);
      if (linkM) {
        const type = linkM[1].toLowerCase() === "movies" ? "movie" : "series";
        const slug = linkM[2];
        const poster = imgM ? (imgM[1].startsWith("http") ? imgM[1] : (imgM[2].startsWith("http") ? imgM[2] : imgM[1])) : "";
        const title = imgM ? (imgM[1].startsWith("http") ? imgM[2] : imgM[1]) : slug;
        pushCard(type, slug, title, poster);
      }
    }

    // 2. Selector DooPlay estándar de items: <article id="post-..." class="item ...">
    for (const m of html.matchAll(/<article[^>]*class=["'][^"']*item[^"']*["'][^>]*>[\s\S]*?<\/article>/gi)) {
      const block = m[0];
      const linkM = block.match(/href=["']https?:\/\/kisskh\.org\/(tvshows|movies)\/([^\/"']+)\/?["']/i);
      if (!linkM) continue;
      const type = linkM[1].toLowerCase() === "movies" ? "movie" : "series";
      const slug = linkM[2];
      const imgM = block.match(/<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/i) ||
                   block.match(/<img[^>]+alt=["']([^"']*)["'][^>]*src=["']([^"']+)["']/i);
      const titleM = block.match(/<h3><a[^>]*>([\s\S]*?)<\/a><\/h3>/i);
      const title = (titleM ? titleM[1] : (imgM ? (imgM[1].startsWith("http") ? imgM[2] : imgM[1]) : slug));
      const poster = imgM ? (imgM[1].startsWith("http") ? imgM[1] : (imgM[2].startsWith("http") ? imgM[2] : imgM[1])) : "";
      pushCard(type, slug, title, poster);
    }

    return cards;
  }

  // ── Helper: obtener el contenido crudo de los episodios desde Blogger ──
  protected async fetchBloggerPostContent(postId: string, env?: Env): Promise<string> {
    for (const blogId of KISSKHORG_BLOG_IDS) {
      try {
        const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;
        const resText = await fetchHtml(feedUrl, env, { allowShort: true });
        if (!resText) continue;
        const data = JSON.parse(resText);
        const content = data?.entry?.content?.["$t"];
        if (typeof content === "string" && content.trim()) {
          return content.trim();
        }
      } catch {}
    }
    return "";
  }

  // ── Meta ──
  async getMeta(id: string, tmdbKey: string, env?: Env): Promise<{ meta: unknown }> {
    const parts = id.split(":");
    if (parts.length < 3) return { meta: null };
    const type = parts[1]; // "series" or "movie"
    const slug = parts[2];

    const pageUrl = type === "movie"
      ? `${KISSKHORG_BASE}/movies/${slug}/`
      : `${KISSKHORG_BASE}/tvshows/${slug}/`;

    let html = "";
    try {
      html = await fetchHtml(pageUrl, env);
    } catch {
      return { meta: null };
    }
    if (!html) return { meta: null };

    const og = ogMetaFromHtml(html, slug);
    const genres = genresFromDooPlay(html, "genre", this.prefix);
    const tmdb = await fetchTmdb(og.name, tmdbKey);

    if (type === "movie") {
      return buildMovieMeta({
        id,
        slug,
        name: og.name,
        poster: og.poster,
        description: og.description,
        genres,
        tmdb,
      });
    }

    // Series: buscar data-post-id para consultar el feed de Blogger
    const postIdMatch = html.match(/data-post-id=["'](\d+)["']/i);
    const postId = postIdMatch?.[1] || "";

    const videos: { id: string; season: number; episode: number; thumbnail: string; title?: string }[] = [];

    if (postId) {
      const rawContent = await this.fetchBloggerPostContent(postId, env);
      if (rawContent) {
        // Cada episodio está separado por ';' y comienza con la url del video
        const sections = rawContent.split(";").map((s) => s.trim()).filter((s) => s.startsWith("http"));
        for (let idx = 0; idx < sections.length; idx++) {
          const epNum = idx + 1;
          videos.push({
            id: `${this.prefix}:ep:${slug}-1x${epNum}`,
            season: 1,
            episode: epNum,
            thumbnail: og.poster,
            title: `Episodio ${epNum}`,
          });
        }
      }
    }

    // Fallback si no hubo episodios en Blogger: extraer la cantidad de episodios de los custom_fields
    if (videos.length === 0) {
      const totalEpMatch = html.match(/<b class="variante">Episodes<\/b>\s*<span class="valor">(\d+)<\/span>/i);
      const totalEps = totalEpMatch ? parseInt(totalEpMatch[1], 10) : 1;
      for (let i = 1; i <= Math.min(totalEps, 150); i++) {
        videos.push({
          id: `${this.prefix}:ep:${slug}-1x${i}`,
          season: 1,
          episode: i,
          thumbnail: og.poster,
          title: `Episodio ${i}`,
        });
      }
    }

    return buildSeriesMeta({
      id,
      name: og.name,
      poster: og.poster,
      description: og.description,
      genres,
      tmdb,
      videos,
    });
  }

  // ── Fan-out de streams (registry) ──
  override async toEpSlug(rawId: string, _env?: Env): Promise<string> {
    const parts = rawId.split(":");
    if (parts[1] === "ep") return parts.slice(2).join(":");
    if (parts[1] === "movie") return `${parts.slice(2).join(":")}-1x1`;
    return parts.slice(1).join(":");
  }

  buildId(epSlug: string): string {
    return `${this.prefix}:ep:${epSlug}`;
  }

  protected extractEmbeds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── Streams (override getStreams) ──
  async getStreams(rawId: string, env: Env): Promise<{ streams: any[] }> {
    // rawId puede ser:
    //  - korg:ep:{slug}-1x{N} (serie)
    //  - korg:movie:{slug} (película)
    const withoutPrefix = rawId.replace(/^korg:/, "");
    const isMovie = withoutPrefix.startsWith("movie:");
    const slug = isMovie
      ? withoutPrefix.slice(6)
      : withoutPrefix.replace(/^ep:/, "").replace(/-\d+x\d+$/, "");

    const mEp = withoutPrefix.match(/-(\d+)x(\d+)$/);
    const epNum = mEp ? parseInt(mEp[2], 10) : 1;

    const pageUrl = isMovie
      ? `${KISSKHORG_BASE}/movies/${slug}/`
      : `${KISSKHORG_BASE}/tvshows/${slug}/`;

    let html = "";
    try {
      html = await fetchHtml(pageUrl, env);
    } catch (e) {
      console.error(`[kisskhorg] error fetching ${pageUrl}: ${e}`);
      return { streams: [] };
    }
    if (!html) return { streams: [] };

    const denoBase = denoBaseFromEnv(env);
    const { add, streams } = makeStreamDeduper();

    if (isMovie) {
      // Película: extraer iframe jwplayer u opciones dooplay
      // 1. Iframe directo: /jwplayer/?source=...
      const jwMatch = html.match(/src=["'](?:https?:\/\/kisskh\.org)?\/jwplayer\/\?source=([^&"']+)/i);
      if (jwMatch) {
        const sourceUrl = decodeURIComponent(jwMatch[1]);
        if (/^https?:\/\//i.test(sourceUrl)) {
          this.addMediaStream({
            url: sourceUrl,
            label: "KissKH.org",
            epSlug: `${slug}-movie`,
            denoBase,
            add,
          });
        }
      }

      // 2. Extraer otros embeds e iframes
      for (const m of html.matchAll(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/gi)) {
        const embedUrl = m[1].trim();
        if (!/youtube\.com|google\.com|facebook\.com|kisskh\.org\/jwplayer/i.test(embedUrl)) {
          await addEmbedStreams({
            embed: embedUrl,
            epSlug: `${slug}-movie`,
            label: "KissKH.org",
            prefix: "korg",
            denoBase,
            add,
            env,
          });
        }
      }

      return { streams };
    }

    // Serie: buscar data-post-id para consultar el feed de Blogger
    const postIdMatch = html.match(/data-post-id=["'](\d+)["']/i);
    const postId = postIdMatch?.[1] || "";
    if (!postId) return { streams: [] };

    const rawContent = await this.fetchBloggerPostContent(postId, env);
    if (!rawContent) return { streams: [] };

    const sections = rawContent.split(";").map((s) => s.trim()).filter((s) => s.startsWith("http"));
    if (epNum < 1 || epNum > sections.length) {
      return { streams: [] };
    }

    const section = sections[epNum - 1];
    const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return { streams: [] };

    // Línea 1: URL|Languages|
    const header = lines[0];
    const videoUrl = header.split("|")[0].trim();

    // Subtítulos en las siguientes líneas
    const subTracks: {
      id: string;
      url: string;
      lang: string;
      label: string;
    }[] = [];

    for (const line of lines.slice(1)) {
      const subUrlMatch = line.match(/(https?:\/\/[^\s,;]+)/);
      if (!subUrlMatch) continue;
      const subUrl = subUrlMatch[1];
      const filename = subUrl.split("/").pop() || "";
      const isSpanish = /spanish|spa|esp/i.test(filename) || /spanish|español/i.test(line);
      const isEnglish = /english|eng/i.test(filename) || /english/i.test(line);
      const lang = isSpanish ? "es" : isEnglish ? "en" : "xx";
      const label = isSpanish ? "Español" : isEnglish ? "English" : filename.replace(/\.vtt$/, "");

      subTracks.push({
        id: `korg-sub-${subTracks.length + 1}-${lang}`,
        url: subUrl,
        lang,
        label,
      });
    }

    // Priorizar subtítulo en español primero, luego inglés
    subTracks.sort((a, b) => {
      const prio = (l: string) => (l === "es" ? 0 : l === "en" ? 1 : 2);
      return prio(a.lang) - prio(b.lang);
    });

    if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
      this.addMediaStream({
        url: videoUrl,
        label: "KissKH.org",
        epSlug: `${slug}-1x${epNum}`,
        denoBase,
        add,
        subtitles: subTracks.slice(0, 5),
      });
    }

    return { streams };
  }

  private addMediaStream({
    url,
    label,
    epSlug,
    denoBase,
    add,
    subtitles,
  }: {
    url: string;
    label: string;
    epSlug: string;
    denoBase: string;
    add: (st: any) => void;
    subtitles?: { id: string; url: string; lang: string; label: string }[];
  }) {
    const isHls = /\.m3u8/i.test(url);
    const isZudrama = /zudrama\.top/i.test(url);

    if (isHls && denoBase) {
      add({
        url: `${denoBase}/hls?u=${encodeURIComponent(url)}&r=${encodeURIComponent(
          "https://kisskh.org/"
        )}`,
        name: `${label} HLS`,
        title: `▶ ${label} — HLS`,
        behaviorHints: {
          notWebReady: false,
          filename: `${epSlug}.m3u8`,
          bingeGroup: `korg-hls`,
        },
        ...(subtitles?.length ? { subtitles } : {}),
      });
    } else if (isHls) {
      add({
        externalUrl: url,
        name: `${label} 🌐`,
        title: `🌐 HLS — ${label}`,
      });
    } else if (isZudrama && denoBase) {
      // zudrama.top requiere Referer: https://kisskh.org/ para entregar el video
      add({
        url: `${denoBase}/mp4?url=${encodeURIComponent(url)}&r=${encodeURIComponent(
          "https://kisskh.org/"
        )}`,
        name: `${label} MP4`,
        title: `▶ ${label} — directo`,
        behaviorHints: {
          notWebReady: false,
          filename: `${epSlug}.mp4`,
          bingeGroup: `korg-mp4`,
        },
        ...(subtitles?.length ? { subtitles } : {}),
      });
    } else {
      // rumble.cloud u otros CDNs abiertos sin hotlink protection
      add({
        url,
        name: `${label} MP4`,
        title: `▶ ${label} — directo`,
        behaviorHints: {
          notWebReady: false,
          filename: `${epSlug}.mp4`,
          bingeGroup: `korg-mp4`,
        },
        ...(subtitles?.length ? { subtitles } : {}),
      });
    }
  }
}

export const kisskhOrgSource = new KisskhOrgSource();
