export const DEBUG_TIMEOUT_MS = 45000;
export const DEBUG_CONCURRENCY = 3;

export type DebugCheck = {
  source: string;
  id: string;
  run: () => Promise<{ streams: any[] }>;
};

/** Tipo de un stream individual: external (🌐, no reproducible), mp4 o hls. */
export function debugTipoOf(st: any): "hls" | "mp4" | "external" {
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
export function debugServerOf(st: any): string {
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
export function debugClassify(streams: any[]) {
  const tipos = { hls: 0, mp4: 0, external: 0 };
  for (const st of streams || []) tipos[debugTipoOf(st)]++;
  return tipos;
}

/** Techo por fuente para que un site colgado no bloquee el chequeo completo. */
export function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${tag}: timeout ${ms}ms`)), ms)
    ),
  ]);
}

/** Ejecuta fn sobre items con un tope de concurrencia (resto en cola). */
export async function debugMapLimit<T, R>(
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
export async function debugRunOne(
  c: DebugCheck
): Promise<Record<string, any>> {
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
