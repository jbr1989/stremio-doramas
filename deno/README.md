# Proxy de fetch/HLS de doramas — Deno Deploy

`fetch.ts` es el servicio auxiliar (no Cloudflare) del addon: además de relayar
el fetch de HTML, **resuelve y sirve HLS** de los hosts limitados por IP.
Los sitios de doramas bloquean el egress del Worker de Cloudflare, y los hosts
IP-bound (StreamWish, savefiles/streamhls) acuñan URLs firmadas atadas a la IP
del que resuelve — por eso la extracción y cada segmento se sirven desde esta
única IP estable de Deno Deploy (edge siempre cálido, sin cold starts).

## Rutas (todas con CORS `*`)

| Ruta | Qué hace | Allowlist |
|---|---|---|
| `/fetch?url=` | Relay de HTML de una página de dorama | Solo los 4 dominios integrados: `doramaslat.com`, `doramedplay.net`, `kdramasplay.com`, `doramasflix.in` |
| `/streamwish?url=` | Resuelve un embed de StreamWish/espejo a la playlist HLS master y la reescribe (referer/UA incluidos) | Hostname contra la allowlist canónica `/streamwish\|embedwish\|wishfast\|sfastwish\|swishsrv\|streamaly\|streamis\|flaswish\|do7go\|playmogo/i` — **idéntica** a la regex de las 3 fuentes del Worker; elízalas en el mismo commit |
| `/savefiles?code=` | Resuelve un código de savefiles/streamhls (POST a `streamhls.to/dl` con `op=embed`) a la playlist master reescrita | — |
| `/byse?url=` *(implementación en `byse.ts`)* | Resuelve la cadena anti-bot de la familia "byse" (attest ECDSA P-256 + PoW de hash propio + payload AES-256-GCM) al master HLS reescrito | **Por forma de API**, no por nombre: cualquier host público con embed `/e/<code>` (`localhost`/IPs privadas fuera). El sondeo `/api/videos/<code>/embed/details` confirma la familia (502 "no compatible" si no). Donde antes se va el CDN (`sprintcdn`) sirviendo variaciones/segmentos por `/hls` |
| `/hls?u=&r=` | Sirve variantes y segmentos HLS con el referer correcto | CDNs: `savefiles.com`, `streamhls.to`, `premilkyway.com`, `sprintcdn` (byse) |

Sin `url`, el servicio responde un JSON de uso con los 5 formatos. Los logs van
a consola con tags `[req]`, `[fetch]`, `[savefiles]`, `[streamwish]`, `[byse]`,
`[hls]`
(visibles en el dashboard de Deno Deploy). Timeouts de 11–15s por fetch.

## Deploy (integración GitHub — recomendado)

1. Ir a <https://dash.deno.com> → **New Project** → enlazar este repo de GitHub.
2. Fijar el **entry point** a `deno/fetch.ts`. Sin build step, sin variables de
   entorno.
3. Desplegar. Obtendrás una URL del tipo `https://<proyecto>.deno.net` (la
   instancia actual es `https://doramas-stremio.jbr1989.deno.net`).
4. Comprobación: abrir
   `https://<proyecto>.deno.net/fetch?url=https://doramaslat.com/` — debe
   devolver el HTML del sitio.
5. Apuntar el Worker: fijar `FETCH_PROXY_URL` en `../wrangler.toml` a
   `https://<proyecto>.deno.net/fetch` y hacer push (el Worker se redespliega).

Alternativa: pegar `fetch.ts` en un **playground de Deno Deploy** (setup sin
repo), o usar `deployctl deploy --entrypoint deno/fetch.ts`.

## Notas

- El free tier de Deno Deploy es generoso (muy por encima del tráfico de un addon
  personal) y no duerme, así que la latencia se mantiene plana (~1s por fetch).
- `deno.json` en la raíz del repo fija el entrypoint (`deploy.runtime.entrypoint`)
  para que Deno Deploy ejecute este archivo, no el Worker de `src/`.
- Cambiar la allowlist aquí requiere redeploy del proyecto en Deno Deploy, no
  basta con push del Worker.
