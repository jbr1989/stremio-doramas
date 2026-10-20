import {
  CHROME_UA,
  fetchHtml,
  hostFromEmbed,
  netFetch,
  STREAMWISH_HOSTS_RE,
} from "./utils";

export function unpackPacker(source: string): string | null {
  const m = source.match(
    /}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\.split\('\|'\)/s
  );
  if (!m) return null;
  const base = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const words = m[4].split("|");
  const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const encode = (n: number): string =>
    (n < base ? "" : encode(Math.floor(n / base))) +
    ((n = n % base) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  const dict: Record<string, string> = {};
  for (let i = count - 1; i >= 0; i--) {
    const k = encode(i);
    dict[k] = words[i] || k;
  }
  return payload.replace(/\b\w+\b/g, (w) => dict[w] || w);
}

export async function extractMp4upload(embedUrl: string) {
  try {
    const html = await fetchHtml(embedUrl);
    const m =
      html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/) ||
      html.match(/src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/) ||
      html.match(/file:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function extractHexload(embedUrl: string) {
  try {
    const fileId = embedUrl.split("embed-").pop()?.split(/[/?]/)[0];
    if (!fileId) return null;
    const embedR = await netFetch("direct", embedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        Referer: "https://latanime.org/",
      },
      signal: AbortSignal.timeout(8000),
    });
    const cookies = embedR.headers.get("set-cookie") || "";
    const r = await netFetch("direct", "https://hexload.com/download", {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        Referer: embedUrl,
        Origin: "https://hexload.com",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: cookies,
      },
      body: new URLSearchParams({
        op: "download3",
        id: fileId,
        ajax: "1",
        method_free: "1",
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const data: any = await r.json();
    if (data.msg === "OK" && data.result?.url) return data.result.url;
    return null;
  } catch {
    return null;
  }
}

export async function extractSavefiles(embedUrl: string) {
  try {
    let fileCode: string | null = null;
    const sfMatch = embedUrl.match(/savefiles\.com\/(?:e\/)?([a-z0-9]+)/i);
    const shMatch = embedUrl.match(/streamhls\.to\/e\/([a-z0-9]+)/i);
    if (sfMatch) fileCode = sfMatch[1];
    else if (shMatch) fileCode = shMatch[1];
    if (!fileCode) return null;
    const embedPageUrl = `https://streamhls.to/e/${fileCode}`;
    const dlR = await netFetch("direct", `https://streamhls.to/dl`, {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        Referer: embedPageUrl,
        Origin: "https://streamhls.to",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      body: `op=embed&file_code=${fileCode}&auto=1&referer=https://savefiles.com/${fileCode}`,
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    const html = await dlR.text();
    const srcMatch = html.match(/sources:\s*\["([^"]+\.m3u8[^"]*)"\]/);
    if (srcMatch) return srcMatch[1];
    const m3u8Match = html.match(/https:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
    if (m3u8Match) return m3u8Match[0];
    return null;
  } catch {
    return null;
  }
}

export async function extractMixdrop(embedUrl: string): Promise<string | null> {
  try {
    const r = await netFetch("direct", embedUrl, {
      headers: { "User-Agent": CHROME_UA, Referer: "https://latanime.org/" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const unpacked = unpackPacker(await r.text());
    if (!unpacked) return null;
    const m = unpacked.match(/MDCore\.wurl\s*=\s*"([^"]+)"/);
    if (!m) return null;
    return m[1].startsWith("//") ? `https:${m[1]}` : m[1];
  } catch {
    return null;
  }
}

export async function extractStreamwish(embedUrl: string): Promise<string | null> {
  try {
    const embed = embedUrl.replace(/\/(?:f|d|v)\/([a-z0-9]+)/i, "/e/$1");
    const origin = (() => {
      try {
        return new URL(embed).origin;
      } catch {
        return "https://streamwish.top";
      }
    })();
    const r = await netFetch("direct", embed, {
      headers: { "User-Agent": CHROME_UA, Referer: `${origin}/` },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const unpacked = unpackPacker(html) || html;
    const m =
      unpacked.match(/"hls\d*"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
      unpacked.match(/file\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ||
      unpacked.match(/https?:\/\/[^"'\\ ]+\.m3u8[^"'\\ ]*/);
    return m ? m[1] || m[0] : null;
  } catch {
    return null;
  }
}

export function decodeVoe(encoded: string): { url: string; isHls: boolean } | null {
  try {
    let v = encoded.replace(/[a-zA-Z]/g, (c) => {
      const base = c <= "Z" ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
    for (const p of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"])
      v = v.split(p).join("_");
    v = v.replace(/_/g, "");
    v = atob(v);
    v = v
      .split("")
      .map((c) => String.fromCharCode(c.charCodeAt(0) - 3))
      .join("");
    v = atob(v.split("").reverse().join(""));
    const src = JSON.parse(v)?.source;
    if (typeof src === "string" && src.startsWith("http"))
      return { url: src, isHls: src.includes(".m3u8") };
  } catch {}
  return null;
}

const DECOY_RE =
  /big[_\-. ]?buck|test-videos\.co\.uk|sample-videos\.com|gtv-videos-bucket|commondatastorage\.googleapis\.com\/gtv|learningcontainer\.com|file-examples\.com|techslides\.com\/demos|download\.blender\.org\/peach|peach\.blender\.org/i;

export function isDecoyUrl(u: string): boolean {
  let d = u;
  try {
    d = decodeURIComponent(u);
  } catch {}
  return DECOY_RE.test(u) || DECOY_RE.test(d);
}

export function firstRealMatch(html: string, re: RegExp): string | null {
  for (const m of html.matchAll(
    new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  )) {
    if (!isDecoyUrl(m[0])) return m[0];
  }
  return null;
}

export function findMediaUrl(html: string): { url: string; isHls: boolean } | null {
  const jm = html.match(
    /<script\s+type="application\/json">([\s\S]*?)<\/script>/
  );
  if (jm) {
    const voe = decodeVoe(jm[1].trim());
    if (voe && !isDecoyUrl(voe.url)) return voe;
  }
  const m3u8 = firstRealMatch(
    html,
    /https?:\/\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*/
  );
  if (m3u8) return { url: m3u8, isHls: true };
  const mf = firstRealMatch(
    html,
    /https:\/\/download\d+\.mediafire\.com[^"'\s\\<>]+/
  );
  if (mf) return { url: mf, isHls: false };
  const mp4 = firstRealMatch(
    html,
    /https?:\/\/[^"'\s\\<>]+\.mp4[^"'\s\\<>]*/
  );
  if (mp4) return { url: mp4, isHls: false };
  return null;
}

// ─── clasificación de embeds compartida por las fuentes ─────────────────────

/** Clasifica un embed y añade el stream correspondiente al deduper compartido
 * (makeStreamDeduper en utils.ts). Cubre las ramas idénticas que antes estaban
 * copiadas en el loop de get{Source}Streams de tudorama / kdramasplay /
 * doramasyt / doramas(doramaslat, doramedplay) / doramasflix: streamwish
 * (HLS por el relay Deno), savefiles/streamhls, mp4upload, hexload, pixeldrain
 * y el fallback externalUrl final.
 *
 * Devuelve true si el embed matcheó un host conocido y se añadió su stream;
 * false si cayó al fallback externalUrl (embed desconocido o extractor sin
 * URL). pandrama NO la usa: su loop trae HLS directo y titles por serverName
 * propios. */
export async function addEmbedStreams(args: {
  /** URL del embed a clasificar. */
  embed: string;
  /** Slug del episodio — filename de los behaviorHints (xxx.mp4 / xxx.m3u8). */
  epSlug: string;
  /** Nombre de la fuente ("KDramas Play") para name/title de los streams. */
  label: string;
  /** Prefijo de la fuente ("kplay") para los bingeGroups. */
  prefix: string;
  /** Base del relay Deno ("" deshabilita las ramas /streamwish y /savefiles). */
  denoBase: string;
  /** Deduper compartido de la llamada en curso. */
  add: (s: any) => void;
  /** Fallback del host en el título external (tudorama usa item.name). */
  hostFallback?: string;
}): Promise<boolean> {
  const { embed, epSlug, label, prefix, denoBase, add, hostFallback } = args;
  const ext = () =>
    add({
      externalUrl: embed,
      name: `${label} 🌐`,
      title: `🌐 ${hostFromEmbed(embed, hostFallback)} — ${label}`,
    });

  // STREAMWISH_HOSTS_RE (mirrors de StreamWish): HLS por el relay Deno.
  if (STREAMWISH_HOSTS_RE.test(embed)) {
    if (denoBase) {
      add({
        url: `${denoBase}/streamwish?url=${encodeURIComponent(embed)}`,
        name: `${label} HLS`,
        title: `▶ streamwish — ${label}`,
        behaviorHints: {
          notWebReady: false,
          filename: `${epSlug}.m3u8`,
          bingeGroup: `${prefix}-streamwish`,
        },
      });
    } else {
      ext();
    }
    return true;
  }

  // savefiles/streamhls → HLS firmado al relay Deno. El strip de "embed-"/
  // ".html" lo necesita doramasyt; en los demás códigos es no-op.
  if (/savefiles\.com|streamhls\.to/i.test(embed)) {
    const code = embed
      .split(/savefiles\.com\/|streamhls\.to\//)
      .pop()
      ?.replace(/^e\//, "")
      .replace(/^embed-/, "")
      .replace(/\.html$/, "")
      .split(/[/?]/)[0]
      ?.trim();
    if (denoBase && code && code.length > 3) {
      add({
        url: `${denoBase}/savefiles?code=${encodeURIComponent(code)}`,
        name: `${label} HLS`,
        title: `▶ savefiles — ${label}`,
        behaviorHints: {
          notWebReady: false,
          filename: `${epSlug}.m3u8`,
          bingeGroup: `${prefix}-savefiles`,
        },
      });
    } else {
      ext();
    }
    return true;
  }

  if (embed.includes("mp4upload.com")) {
    const u = await extractMp4upload(embed);
    if (u) {
      add({
        url: u,
        name: `${label} MP4`,
        title: `▶ mp4upload — ${label}`,
        behaviorHints: {
          notWebReady: false,
          filename: `${epSlug}.mp4`,
          bingeGroup: `${prefix}-mp4upload`,
        },
      });
      return true;
    }
    ext();
    return false;
  }

  if (embed.includes("hexload.com")) {
    const u = await extractHexload(embed);
    if (u) {
      add({
        url: u,
        name: `${label} MP4`,
        title: `▶ hexload — ${label}`,
        behaviorHints: {
          notWebReady: false,
          filename: `${epSlug}.mp4`,
          bingeGroup: `${prefix}-hexload`,
        },
      });
      return true;
    }
    ext();
    return false;
  }

  // Directo conocido (solo kdramasplay lo tenía; inofensivo para las demás).
  if (embed.includes("pixeldrain.com")) {
    const idM = embed.match(/pixeldrain\.com\/(?:u|l)\/([a-zA-Z0-9]+)/);
    if (idM) {
      add({
        url: `https://pixeldrain.com/api/file/${idM[1]}`,
        name: `${label} MP4`,
        title: `▶ pixeldrain — ${label}`,
        behaviorHints: { notWebReady: false, filename: `${epSlug}.mp4` },
      });
      return true;
    }
    ext();
    return false;
  }

  ext();
  return false;
}
