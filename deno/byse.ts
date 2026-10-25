// ─── Byse (familia n1mwq) HLS ───────────────────────────────────────────────
// Host con puerta de clic + cadenas anti-bot equivalentes a un "captcha":
// challenge/attest (ECDSA P-256) → PoW (hash propio sobre `nonce:contador`,
// 16 bits de cero) → playback (payload AES-256-GCM con key_parts ofuscadas).
// Todo replicable con fetch + WebCrypto nativo de Deno (verificado PoC 1080p).
//
// Detalles verificados (octubre 2026):
//  - El dominio público ROTARÁ: el embed llega como https://<hosp>/e/<code> y
//    los requests van al dominio interno dado por /api/videos/<code>/embed/details
//    (embed_frame_url) — nunca cachear el dominio ni el slug (cambia por request).
//  - Toda llamada exige la cabecera X-Embed-Parent: <embed url> — sin ella la
//    API responde {error: embedding not allowed} (403).
//  - El token del m3u8 va ligado al ASN/IP del que lo resolvió y expira (e=10800,
//    3 h). Por eso la resolución Y todo el playback pasan por /hls en esta
//    misma instancia, como savefiles.
//
// Los helpers compartidos del servidor (cors/logging/rewriteM3u8) viven en
// fetch.ts y se inyectan por parámetro (ByseHelpers) para no duplicar código
// ni extraer un módulo común aún.

const BYSE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

// Fingerprint del "client" que exige el attest. El servidor puntúa más que
// nada por presencia de campos (conf 0.9 con estos valores falsos verificados);
// los *_hash son sha256-base64url falsificados, nadie los valida contra reales.
const BYSE_CLIENT: Record<string, unknown> = {
  architecture: "x86",
  bitness: "64",
  brand_full_versions: [
    { brand: "Google Chrome", version: "155.0.8059.85" },
    { brand: "Chromium", version: "155.0.8059.85" },
    { brand: "Not(A:Brand", version: "24.0.0.0" },
  ],
  canvas_hash: "pAt-BD-5qquzmxTeIm1bP0AUV7JdRDvdOdlWmIiiu_I",
  audio_hash: "MJveI3vpd34iGuvYDlAu2IULlxJjuY7ADfx6jWxQzGE",
  codecs_hash: "qJye5DfMLC0co_nw835Vyx_VcUOEnA01Coov9OtwHZs",
  color_depth: 24,
  device_memory: 16,
  extra: { vendor: "Google Inc.", appVersion: "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36" },
  fonts_hash: "A3NvW7_xc4imEb2Z_dU5M6k6vDZTjWR7YiuZjLqys2o",
  hardware_concurrency: 12,
  languages: ["es-ES", "es"],
  media_devices: "ai1ao1vi1",
  model: "",
  pixel_ratio: 1,
  platform: "Windows",
  platform_version: "19.0.0",
  pointer_type: "fine,hover",
  screen_height: 1080,
  screen_width: 1920,
  timezone: "Europe/Madrid",
  touch_points: 0,
  ua_full_version: "155.0.8059.85",
  webgl_params_hash: "BIoy8SYxo8-2WtAM5ui9D8sDkpzLPvGjVdblDUiGQ-c",
  webgl_renderer: "ANGLE (AMD, AMD Radeon RX 9060 XT (0x00007590) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  webgl_vendor: "Google Inc. (AMD)",
};

/** Helpers compartidos del servidor (fetch.ts) que este módulo necesita. */
export interface ByseHelpers {
  cors: (body: BodyInit | null, init?: ResponseInit) => Response;
  jsonError: (msg: string, status: number) => Response;
  rewriteM3u8: (text: string, sourceUrl: string, selfBase: string, referer: string) => string;
  log: (tag: string, msg: string) => void;
  logErr: (tag: string, msg: string) => void;
  ms: (t0: number) => string;
  errText: (e: unknown) => string;
  trunc: (s: string, max?: number) => string;
}

function byseB64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\//g, "_").replace(/\+/g, "-").replace(/=+$/, "");
}

function byseUnb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Solver del PoW, transcripción verbatim de pow-*.js (hash propietario tipo
// xxhash sobre <pow_nonce>:<contador>; cuenta bits de cero, dificultad ~16).
// Deno secuencial tarda ~0.5-3 s en resolver; se puede afinar con workers.
function solveBysePow(nonce: string, difficulty: number): string {
  const re = (t: number, e: number) => (t << e | t >>> (32 - e)) >>> 0;
  const ht = (t: number, e: number) => Math.imul(t, e) >>> 0;
  function avalanche(t: Uint32Array): void {
    t[0] = t[0] + t[1] >>> 0;
    t[3] = re(t[3] ^ t[0], 16);
    t[2] = t[2] + t[3] >>> 0;
    t[1] = re(t[1] ^ t[2], 12);
    t[0] = t[0] + t[1] >>> 0;
    t[3] = re(t[3] ^ t[0], 8);
    t[2] = t[2] + t[3] >>> 0;
    t[1] = re(t[1] ^ t[2], 7);
  }
  const byseHash = (input: Uint8Array): Uint32Array => {
    const e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
    for (let i = 0; i < input.length; i++) {
      e[0] = e[0] + input[i] >>> 0;
      e[0] = re(e[0], 7);
      avalanche(e);
    }
    for (let i = 0; i < 8; i++) avalanche(e);
    const table = new Uint32Array(512);
    for (let i = 0; i < 512; i++) {
      avalanche(e);
      table[i] = (e[0] ^ e[2]) >>> 0;
    }
    for (let round = 0; round < 2; round++) {
      for (let s = 0; s < 512; s++) {
        const a = table[s] & 511;
        let c = table[s] + table[a] >>> 0;
        c = re(c, 13);
        c = (c ^ ht(table[(s + 1) & 511], 2654435761)) >>> 0;
        table[s] = c;
        e[0] = (e[0] ^ c) >>> 0;
        avalanche(e);
      }
    }
    const out = new Uint32Array(8);
    const chunk = 512 / 8;
    for (let i = 0; i < 8; i++) {
      avalanche(e);
      let s = e[0];
      for (let c = 0; c < chunk; c++) {
        const d = table[i * chunk + c];
        s = s + d >>> 0;
        s = re(s, 5);
        s = (s ^ ht(d, 2246822519)) >>> 0;
      }
      out[i] = (s ^ e[2]) >>> 0;
    }
    return out;
  };
  const leadZeroBits = (words: Uint32Array): number => {
    let n = 0;
    for (const w of words) {
      if (w === 0) { n += 32; continue; }
      return n + Math.clz32(w);
    }
    return n;
  };
  const prefix = nonce + ":";
  const utf8 = new TextEncoder();
  for (let s = 0; ; s++) {
    const words = byseHash(utf8.encode(prefix + s));
    if (leadZeroBits(words) >= difficulty) return String(s);
  }
}

// Cadena completa challenge→attest→captcha→verify→playback → master m3u8.
async function resolveByse(embedUrl: string, H: ByseHelpers): Promise<string | null> {
  const { logErr, log, ms, trunc, errText } = H;
  const t0 = performance.now();
  const m = embedUrl.match(/\/e\/([a-z0-9]+)/i);
  const code = m ? m[1] : "";
  if (!code) {
    logErr("byse", `embed sin /e/<code>: ${trunc(embedUrl, 120)}`);
    return null;
  }
  const parentOrigin = (() => { try { return new URL(embedUrl).origin; } catch { return ""; } })();
  let frameOrigin = "";
  let frameUrl = "";
  const jar = new Map<string, string>();
  const cookieHeader = () => jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  const saveCookies = (r: Response): void => {
    const list = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    for (const c of list) {
      const kv = c.split(";")[0];
      const eq = kv.indexOf("=");
      if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  };
  const hdrs = (captchaToken?: string): Record<string, string> => {
    const h: Record<string, string> = {
      "User-Agent": BYSE_UA,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Embed-Parent": embedUrl,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    if (frameOrigin) {
      h["Origin"] = frameOrigin;
      h["Referer"] = frameUrl;
    } else {
      h["Origin"] = parentOrigin || "https://bysevepoin.com";
      h["Referer"] = parentOrigin || "https://bysevepoin.com/";
    }
    if (captchaToken) h["X-Captcha-Token"] = captchaToken;
    const c = cookieHeader();
    if (c) h["Cookie"] = c;
    return h;
  };
  try {
    // 1. dominio interno real (rota): embed_frame_url
    const detailsRes = await fetch(`https://${new URL(embedUrl).hostname}/api/videos/${code}/embed/details`, {
      headers: hdrs(),
      signal: AbortSignal.timeout(12000),
    });
    saveCookies(detailsRes);
    if (!detailsRes.ok) {
      logErr("byse", `details FAIL ${code} → ${detailsRes.status}, host no compatible con la plataforma byse? (${ms(t0)})`);
      return null;
    }
    const frame = new URL((await detailsRes.json()).embed_frame_url as string);
    // El inner JS declara Origin/Referer = frame interno (no el parent);
    // X-Embed-Parent es la que autoriza el embed — verificado en devtools.
    frameOrigin = frame.origin;
    frameUrl = frame.href;

    // 2. attest: challenge → keypair efímero → firma del nonce
    const post = (path: string, body: unknown, tok?: string): Promise<Response> =>
      fetch(`${frameOrigin}/api/videos/${path}`, {
        method: "POST",
        headers: hdrs(tok),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    const ch = await (await post("access/challenge", {})).json();
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(ch.nonce));
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const rndId = (label: string) => {
      const a = new Uint8Array(14);
      crypto.getRandomValues(a);
      return label + byseB64u(a).replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);
    };
    const viewerId = jar.get("byse_viewer_id") || rndId("st");
    const deviceId = jar.get("byse_device_id") || rndId("dv");
    const attest = await (await post("access/attest", {
      viewer_id: viewerId,
      device_id: "",
      challenge_id: ch.challenge_id,
      nonce: ch.nonce,
      signature: byseB64u(new Uint8Array(sig)),
      public_key: { crv: "P-256", ext: true, key_ops: ["verify"], kty: "EC", x: jwk.x, y: jwk.y },
      client: { ...BYSE_CLIENT, user_agent: BYSE_UA },
      storage: { cookie: viewerId, local_storage: viewerId, indexed_db: `${viewerId}:${deviceId}`, cache_storage: `${viewerId}:${deviceId}` },
      attributes: { entropy: "high" },
    })).json();
    if (!attest?.token) {
      logErr("byse", `attest FAIL ${code} (sin token): ${trunc(JSON.stringify(attest), 200)} (${ms(t0)})`);
      return null;
    }
    // 3. PoW + verify
    const fp = { token: attest.token, viewer_id: attest.viewer_id, device_id: attest.device_id, confidence: attest.confidence };
    const captcha = await (await post(`${code}/embed/captcha`, { fingerprint: fp })).json();
    const solution = solveBysePow(captcha.pow_nonce, captcha.pow_difficulty);
    const verify = await (await post(`${code}/embed/captcha/verify`, { pow_token: captcha.pow_token, solution, fingerprint: fp })).json();
    if (verify?.status !== "ok" || !verify?.token) {
      logErr("byse", `verify FAIL ${code}: ${trunc(JSON.stringify(verify), 200)} (${ms(t0)})`);
      return null;
    }

    // 4. playback → payload cifrado → master
    const playback = await (await post(`${code}/embed/playback`, { fingerprint: fp }, verify.token)).json();
    const pb = playback?.playback ?? playback;
    if (!pb?.payload || !pb?.iv || !Array.isArray(pb?.key_parts)) {
      logErr("byse", `playback FAIL ${code}: ${trunc(JSON.stringify(playback), 200)} (${ms(t0)})`);
      return null;
    }
    const v = Number(pb.version);
    const sel = v >= 1 && v <= 20
      ? [pb.key_parts[v - 1], pb.key_parts[31 - v - 1]]
      : pb.key_parts;
    const keyMaterial = sel
      .map((s: string) => byseUnb64u(s))
      .reduce((a: Uint8Array, b: Uint8Array) => {
        const merged = new Uint8Array(a.length + b.length);
        merged.set(a);
        merged.set(b, a.length);
        return merged;
      }, new Uint8Array(0));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: byseUnb64u(pb.iv) },
      await crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["decrypt"]),
      byseUnb64u(pb.payload),
    );
    const pbJson = JSON.parse(new TextDecoder().decode(plain));
    const master = pbJson?.sources?.[0]?.url;
    if (!master) {
      logErr("byse", `playback sin sources: ${trunc(JSON.stringify(pbJson), 200)} (${ms(t0)})`);
      return null;
    }
    log("byse", `resolve ${embedUrl} → ${frame.host} → master ${trunc(master, 120)} (${ms(t0)})`);
    return master;
  } catch (e) {
    logErr("byse", `resolve THROW ${embedUrl} → ${errText(e)} (${ms(t0)})`);
    return null;
  }
}

/** Detección por FORMA de API, no por nombre: embed público
 * https://<host>/e/<code> (código [a-z0-9-]{6,20}). Otras familias usan /e/
 * también — la confirmación real la hace resolveByse sondeando
 * /api/videos/<code>/embed/details (502 "no compatible" si no es la familia).
 * Hosts prohibidos: locales/privados (cierre básico ante abuso del proxy).
 * Mantener sincronizada con BYSE_SHAPE_RE en src/lib/utils.ts. */
function byseAllowlisted(embedUrl: string): boolean {
  if (!/^https?:\/\/[^/"']+\/e\/[a-z0-9-]{6,20}(?:$|\/|\?|#)/i.test(embedUrl)) {
    return false;
  }
  const h = (() => { try { return new URL(embedUrl).hostname; } catch { return ""; } })();
  if (!h || !h.includes(".")) return false;
  if (/^(localhost|127\.|0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[::1\])/i.test(h)) return false;
  return true;
}

// GET /byse?url=<embed /e/<code>> → resuelve la cadena anti-bot y sirve el
// master reescrito (todo el playback por /hls mismo IP: token ASN-bound).
export async function handleByse(
  embedUrl: string,
  selfBase: string,
  H: ByseHelpers
): Promise<Response> {
  const { cors, jsonError, log, logErr, ms, trunc, errText, rewriteM3u8 } = H;
  if (!byseAllowlisted(embedUrl)) {
    logErr("byse", `url sin forma /e/<code> o host local: ${trunc(embedUrl, 160)}`);
    return jsonError("host not allowed", 403);
  }
  const master = await resolveByse(embedUrl, H);
  if (!master) return jsonError("could not resolve byse embed", 502);
  const t0 = performance.now();
  try {
    // El CDN no exige Referer (verificado); pasamos el origin del embed por
    // cortesía y caemos a sin cabeceras si se queja.
    const embed = new URL(embedUrl);
    const frame = `https://${embed.hostname}/`;
    let masterRes = await fetch(master, {
      headers: { "User-Agent": BYSE_UA, "Referer": frame, "Origin": embed.origin },
      signal: AbortSignal.timeout(12000),
    });
    if (!masterRes.ok) {
      logErr("byse", `master con referer → ${masterRes.status}; reintento limpio (${ms(t0)})`);
      masterRes = await fetch(master, { headers: { "User-Agent": BYSE_UA }, signal: AbortSignal.timeout(12000) });
    }
    if (!masterRes.ok) {
      logErr("byse", `master FAIL → ${masterRes.status} (${ms(t0)})`);
      return jsonError(`upstream ${masterRes.status}`, 502);
    }
    const text = await masterRes.text();
    log("byse", `master → ${masterRes.status}, ${text.length}B reescrito (${ms(t0)})`);
    return cors(rewriteM3u8(text, master, selfBase, frame), {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    logErr("byse", `master THROW → ${errText(e)} (${ms(t0)})`);
    return jsonError(String(e), 502);
  }
}
