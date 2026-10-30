# Análisis Comparativo y Propuestas de Mejora para `stremio-doramas`

Este documento presenta una comparativa técnica profunda entre el proyecto actual (**stremio-doramas**) y seis addons destacados de la comunidad Stremio, detallando mejoras concretas y aplicables para enriquecer el addon sin comprometer su arquitectura serverless basada en **Cloudflare Workers** y **Deno Deploy**.

---

## 1. Resumen de los Proyectos Analizados

| Proyecto | Enfoque Principal | Pila Tecnológica / Arquitectura | Características Destacables |
|---|---|---|---|
| **stremio-doramas** *(Actual)* | Doramas en español / subtitulados | Cloudflare Workers + Deno Deploy (HLS Relay / Proxy) + Cloudflare KV | Arquitectura serverless de latencia ultra baja, proxying selectivo para hosts IP-bound, anti-SSRF, scraping regex + GraphQL, slug-mapping cross-site con matching difuso. |
| **qwertyuiop8899/streamvix** | Películas, series, anime, deportes y Live TV | Node.js / Express + Python resolvers + Docker | Integración unificada de MediaFlow Proxy (MFP), soporte anime multicanal (TMDB/Cinemeta/Kitsu), rotación de proxies SOCKS5/WARP por proveedor, scheduler de directos y eventos en background. |
| **qwertyuiop8899/tvvoo** | Canales de TV en directo por países (Vavoo) | Node.js / Express + TypeScript + Docker / BeamUp | Página `/configure` interactiva, rutas dinámicas `/:cfg/manifest.json`, reescritura de firmas IP (`addonSig`), rotación de logos y EPG enriquecido. |
| **newman2x/WebStreamrMBG** | Extracción web multilingüe (películas/series) | Node.js / Express 5 + TypeScript + SQLite / Keyv | Panel de configuración visual muy pulido, soporte nativo de MediaFlow Proxy (MFP) para resolver hosters bloqueados por IP (FileLions, Streamtape, VOE), mutex con `async-mutex` para evitar *cache stampedes*, soporte FlareSolverr y proxies por patrón minimatch de dominio. |
| **kunolabs/yukistreams-addon** | Anime, dramas asiáticos, películas y series | Servicio alojado (Closed Source / Edge) | Filtrado por perfiles de usuario (Direct, Debrid: Real-Debrid / TorBox, P2P, MediaFlow), reducción de ruido en títulos de streams, preservación de identidad show/episodio, soporte Bring-Your-Own-Credentials. |
| **dudu-martins/brazilcam4-nuvio** | Câmaras ao vivo CAM4 Brasil | Node.js + Express + Stremio Addon SDK + Render | Catálogo con ordenaciones dinámicas vía `extra: [{ name: "genre", options: [...] }]` (Em destaque, Mais Espectadores, Menos Espectadores), proxy local de miniaturas con validación de cabecera mágica JPEG, paginación por lotes de 5 requests concurrentes. |
| **Pigamer37/animeflv-stremio-addon** *(AnimES)* | Anime en español (AnimeFLV, TioAnime, Latanime...) | Node.js + Express + Vercel / Alwaysdata | Compatibilidad nativa con Kitsu/AniList/MAL vía `relations.yuna.moe`, soporte de calendario Stremio (`released` con fecha ISO en episodios para tags "UPCOMING"), fallback entre TMDB y Cinemeta, opción configurable de streams externos. |

---

## 2. Comparativa Detallada Frente al Proyecto Actual

### A. Experiencia de Usuario y Configuración (UI / Manifest Dinámico)
* **Situación actual**:
  - El manifest está hardcodeado en `src/manifest.ts`. Se despliega con una configuración fija.
  - El usuario instala la URL directa (`https://<worker>.workers.dev/manifest.json`). No hay página `/configure`.
  - No se puede activar o desactivar fuentes, cambiar el orden de servidores o filtrar tipos de streams (por ejemplo, ocultar enlaces `externalUrl` que no reproducen directamente en la app de Stremio).
* **Lo que hacen los proyectos de referencia**:
  - `WebStreamrMBG`, `tvvoo`, `yukistreams` y `animeflv-stremio-addon` exponen una página interactiva en `/configure`.
  - Permiten al usuario seleccionar sus fuentes favoritas, excluir sitios caídos o lentos, y generar un manifest dinámico codificado en la URL: `https://<addon>/<config-base64>/manifest.json` o `/cfg-<params>/manifest.json`.
  - `yukistreams` y `WebStreamrMBG` permiten al usuario configurar opcionalmente su propia clave de **Real-Debrid**, **TorBox** o su URL y contraseña de **MediaFlow Proxy**.

---

### B. Gestión de Hosts IP-Bound y Proxies de Streaming (MediaFlow Proxy y Debrid)
* **Situación actual**:
  - La arquitectura actual resuelve hosts IP-bound (StreamWish, SaveFiles/StreamHLS, Dood) delegándolos a la instancia de Deno Deploy (`deno/fetch.ts`) con reescritura de playlists HLS (`/proxy/m3u8` y `/proxy/seg`).
  - Para los hosts que no se pueden resolver o están protegidos por Cloudflare con tokens atados a la IP del cliente (Mixdrop, StreamTape, VOE, etc.), el addon recurre a un stream con `externalUrl` (abrir en navegador web con icono 🌐).
* **Lo que hacen los proyectos de referencia**:
  - **Integración con MediaFlow Proxy (MFP)** (`streamvix`, `WebStreamrMBG`, `yukistreams`):
    MediaFlow Proxy es el estándar de facto actual en Stremio para retransmitir streams con cabeceras estrictas (`Referer`, `Origin`, `User-Agent`) y resolver hosts bloqueados o atados a IP (como VOE, Mixdrop, Streamtape, FileLions, LuluStream, DoodStream). En lugar de enviar un enlace `externalUrl`, envían la URL envuelta en MFP (`/proxy/stream?url=...&api_password=...`), permitiendo reproducción fluida directa dentro del reproductor de Stremio en Android TV, FireStick y PC.
  - **Soporte de Debrid (Real-Debrid / TorBox)** (`yukistreams`, `WebStreamrMBG`):
    Muchos servidores de streaming (o enlaces directos de descarga) pueden ser desbloqueados instantáneamente si el usuario vincula su cuenta de Real-Debrid o TorBox, transformándolos en streams CDN ultra rápidos y estables sin depender de relays propios.

---

### C. Metadatos, Calendario de Emisión y Relaciones de Contenido
* **Situación actual**:
  - El addon soporta metadatos mediante TMDB para episodios cuando se consultan prefijos de series.
  - No se inyecta la fecha de emisión en formato estándar en los episodios, por lo que Stremio no puede mostrar las insignias de "Próximamente" ni añadir los episodios al Calendario de Stremio.
  - Para series en emisión, si un episodio no ha salido, no se conoce de antemano la fecha de salida.
* **Lo que hacen los proyectos de referencia**:
  - `Pigamer37/animeflv-stremio-addon`:
    1. Resuelve fechas de emisión estimadas o de APIs y añade la propiedad `released: new Date(...).toISOString()` a los episodios de la lista de metas. Esto hace que Stremio active de forma automática las etiquetas **UPCOMING** y coloque los estrenos en la pestaña **Calendar** de los usuarios.
    2. Enriquece los episodios con miniaturas y descripciones (`overview`) con fallback multinivel (TMDB -> Cinemeta -> Scraper local).
  - `dudu-martins/brazilcam4-nuvio`:
    Implementa un proxy interno para las imágenes/miniaturas (`/imagem/:id.jpg`) con validación de cabeceras mágicas y reescritura de cabeceras (`Referer`), solucionando problemas de hotlinking en clientes como Stremio Web.

---

### D. Concurrencia, Prevención de Fallos y Optimización de Caché
* **Situación actual**:
  - Usa Cloudflare KV (`STREAM_CACHE`) con TTLs configurados por tipo de recurso (`TTL.stream = 6h`, `TTL.catalog = 10m`, etc.).
  - Cuando expira una clave de un dorama muy popular, múltiples peticiones concurrentes de Stremio golpean al unísono las 7+ fuentes a la vez (problema clásico de **Cache Stampede** / efecto estampida).
* **Lo que hacen los proyectos de referencia**:
  - `WebStreamrMBG` y `streamvix`:
    - Emplean **Mutex por ID** (`async-mutex`): cuando un recurso no está en caché y se está procesando, las demás peticiones entrantes para ese mismo ID esperan a que la primera resuelva y lea de la caché recién generada, reduciendo drásticamente el uso de CPU, ancho de banda y llamadas subrequest de Cloudflare.
    - Manejo de fallos con reintentos exponenciales suaves (`axios-retry` o backoff configurable) y descarte inmediato ante códigos de error definitivos (404/410).
  - `brazilcam4-nuvio`:
    - Agrupación de peticiones concurrentes en lotes (chunks) de tamaño controlado (5 en 5 con `Promise.all`), evitando agotar sockets o caer en límites de subrequests simultáneas.

---

### E. Catálogos, Filtros Avanzados y Clasificación
* **Situación actual**:
  - El catálogo actual ofrece filtro por género (`genre`) mediante `withGenre(...)` y búsqueda (`search`).
  - No hay opciones para filtrar por estado (En emisión vs. Finalizados), año o criterio de ordenación (Más populares, Más valorados, Recién agregados).
* **Lo que hacen los proyectos de referencia**:
  - `brazilcam4-nuvio`:
    Utiliza el selector de `genre` del manifest de Stremio de forma ingeniosa para ofrecer ordenaciones: `["Em destaque", "Mais Espectadores", "Menos Espectadores"]`.
  - `Pigamer37/animeflv-stremio-addon` y `yukistreams`:
    Ofrecen catálogos separados dedicados:
    1. *Dramas en Emisión (On Air / Simulcast)*: series con episodios saliendo semanalmente.
    2. *Dramas Populares / Tendencias*: basado en rankings de vistas del sitio origen o de TMDB.
    3. *Filtros por Estado*: opción de filtrar series completas para maratonear o series en curso.

---

### F. Presentación y Limpieza de Streams en Stremio
* **Situación actual**:
  - Los streams se muestran con el formato del servidor, por ejemplo `[dlat] StreamWish` o `[dflix] Fembed`.
  - Aparecen mezclados streams reproducibles directamente con streams que tienen icono de globo `🌐` (enlaces externos que abren el navegador).
* **Lo que hacen los proyectos de referencia**:
  - `yukistreams`:
    Filosofía *"Made for signal, not clutter"*: agrupa y clasifica los streams con badges limpios de calidad (`1080p`, `720p`), idioma del audio/subtítulo (`[Sub ESP]`, `[Latino]`) y origen sin saturar la pantalla.
  - `WebStreamrMBG`:
    Permite configurar un switch `Hide external streams` para que en dispositivos de salón (Android TV, Apple TV, Chromecast) no aparezcan streams que no se pueden reproducir en pantalla.

---

## 3. Catálogo Detallado de Mejoras Propuestas (Roadmap)

Basado en las mejores prácticas observadas en los proyectos de referencia, a continuación se detallan las mejoras técnicas ordenadas por impacto y viabilidad dentro del entorno de Cloudflare Workers y Deno Deploy:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   MAPA DE MEJORAS RECOMENDADAS                         │
├────────────────────────┬───────────────────────────────────────────────┤
│ Prioridad Alta (P1)    │ • Página de Configuración /configure          │
│                        │ • Filtrado configurable de streams externos   │
│                        │ • Soporte para MediaFlow Proxy (MFP)          │
├────────────────────────┼───────────────────────────────────────────────┤
│ Prioridad Media (P2)   │ • Integración de Calendario Stremio (released)│
│                        │ • Proxy de imágenes contra hotlink protection │
│                        │ • Catálogo de "En Emisión" (Airing / On-Air)  │
├────────────────────────┼───────────────────────────────────────────────┤
│ Prioridad Baja (P3)    │ • Soporte Debrid (Real-Debrid / TorBox)       │
│                        │ • Mutex / In-flight request deduplication     │
│                        │ • Limpieza y formateo de títulos de stream    │
└────────────────────────┴───────────────────────────────────────────────┘
```

---

### Mejora 1: Página Interactiva de Configuración (`/configure`) y Manifest Dinámico
- **Inspiración**: `WebStreamrMBG`, `tvvoo`, `yukistreams`, `animeflv-stremio-addon`.
- **Beneficio**: Los usuarios pueden elegir qué fuentes habilitar (por ejemplo, desmarcar sitios si están caídos o si solo quieren doramas en latino), si desean ver enlaces externos `externalUrl` o solo reproducibles, y configurar servicios opcionales.
- **Implementación sugerida para Cloudflare Workers**:
  1. Servir una página HTML/CSS/JS estática o embebida en `GET /configure`.
  2. La página genera una URL con los parámetros codificados (ya sea formato base64 o query params):
     `https://<worker>.workers.dev/:config/manifest.json`
  3. En `src/index.ts`, capturar `/:config/manifest.json` y decodificar las preferencias del usuario para pasarlas en el contexto de las rutas (`catalogRoute`, `streamRoute`).
  4. En `src/manifest.ts`, añadir en el manifest raíz `"behaviorHints": { "configurable": true }` para que Stremio muestre la rueda de engranaje de configuración en la app.

---

### Mejora 2: Soporte para MediaFlow Proxy (MFP)
- **Inspiración**: `streamvix`, `WebStreamrMBG`, `yukistreams`.
- **Beneficio**: Convierte streams que hoy son `externalUrl` (como Mixdrop, Streamtape, VOE, FileLions) en streams reproducibles de alta compatibilidad en Stremio Android TV, PC y móvil.
- **Implementación sugerida**:
  1. A través de la configuración (`/configure`), el usuario puede ingresar su `MFP_URL` y `MFP_API_PASSWORD` (o variables de entorno en self-hosting).
  2. Crear una utilidad `wrapMediaFlowUrl(streamUrl, headers, mfpConfig)`:
     ```typescript
     // Ejemplo conceptual:
     function wrapMediaFlowUrl(mediaUrl: string, headers: Record<string, string>, config: MFPConfig) {
       const params = new URLSearchParams({
         url: mediaUrl,
         api_password: config.password,
         headers: JSON.stringify(headers)
       });
       return `${config.url}/proxy/stream?${params.toString()}`;
     }
     ```
  3. Para extractores que devuelven vídeo directo con restricción de Referer o IP, si MFP está configurado, generar la URL proxied en lugar de degradar a `externalUrl`.

---

### Mejora 3: Opción de Ocultar Enlaces Externos (`hideExternalStreams`)
- **Inspiración**: `WebStreamrMBG`, `animeflv-stremio-addon`.
- **Beneficio**: En reproductores de TV (Android TV, Fire TV, Tizen) hacer clic en un enlace externo abre un navegador web o muestra un error de no reproducible, lo que empeora la experiencia del usuario.
- **Implementación sugerida**:
  1. Permitir activar en la configuración `/configure` la opción `hideExternalStreams=true`.
  2. En `src/routes/stremio.ts` (`streamRoute`), al filtrar los streams resultantes:
     ```typescript
     if (userConfig.hideExternalStreams) {
       result.streams = result.streams.filter(s => !s.externalUrl && s.url);
     }
     ```

---

### Mejora 4: Calendario de Stremio y Fecha de Emisión (`released`)
- **Inspiración**: `Pigamer37/animeflv-stremio-addon`.
- **Beneficio**: Permite a Stremio mostrar cuándo se estrenará el próximo episodio de un dorama en emisión y sincronizarlo con la sección de Calendario de Stremio.
- **Implementación sugerida**:
  1. En las fuentes donde se conozca la fecha de publicación del episodio (o extrayéndola de los metadatos de TMDB para doramas en emisión), incluir en el objeto `episode`:
     ```typescript
     {
       id: "...",
       title: "Episodio 5",
       season: 1,
       episode: 5,
       released: "2026-11-05T12:00:00.000Z" // Formato ISO 8601
     }
     ```
  2. Si la fecha es futura respecto a `Date.now()`, Stremio añade automáticamente el tag `UPCOMING` y la fecha de estreno estimada.

---

### Mejora 5: Proxy de Miniaturas para Esquivar Hotlink Protection (`tudorama`)
- **Inspiración**: `brazilcam4-nuvio`.
- **Beneficio**: Resuelve el problema conocido documentado en `README.md` donde `tudorama.com` bloquea peticiones de imágenes por `Referer` (`https://app.stremio.com` da 403 en Stremio Web).
- **Implementación sugerida**:
  1. Crear un endpoint ligero en el Worker o en Deno Deploy: `GET /proxy/img?url=<encoded_url>`.
  2. Comprobar que la URL pertenezca a los dominios autorizados de tudorama para evitar abusos o SSRF (usando `safeProxyUrl`).
  3. Realizar el fetch de la imagen enviando `Referer: https://tudorama.com/` y cachear con `Cache-Control: public, max-age=86400`.
  4. En `src/sources/tudorama.ts`, transformar las URLs de pósters y miniaturas para pasar por este endpoint cuando se sirvan al cliente web.

---

### Mejora 6: Catálogos Especializados ("En Emisión" y "Más Populares")
- **Inspiración**: `Pigamer37/animeflv-stremio-addon`, `brazilcam4-nuvio`.
- **Beneficio**: Los aficionados a los doramas buscan frecuentemente seguir las series semana a semana (dramas en emisión / simulcast).
- **Implementación sugerida**:
  1. En `src/manifest.ts`, añadir un nuevo catálogo:
     ```typescript
     {
       type: "series",
       id: "doramas-en-emision",
       name: "Doramas — En Emisión",
       extra: [{ name: "skip", isRequired: false }]
     }
     ```
  2. Conectar este catálogo con las secciones "En emisión" de sitios como `doramasflix`, `doramasyt` o `pandrama` que ya cuentan con esta categorización en su frontend.

---

### Mejora 7: Deduplicación de Solicitudes Concurrentes en Vuelo (*SingleFlight* / *In-flight Promise Sharing*)
- **Inspiración**: `WebStreamrMBG` (`async-mutex`).
- **Beneficio**: En Cloudflare Workers no se puede usar SQLite local ni persistir mutexes tradicionales, pero sí se puede implementar un patrón *SingleFlight* en memoria durante el ciclo de vida de la instancia del Worker:
- **Implementación sugerida**:
  ```typescript
  const inFlightStreams = new Map<string, Promise<any>>();

  export async function getDeduplicatedStreams(id: string, env: Env) {
    if (inFlightStreams.has(id)) {
      return inFlightStreams.get(id)!;
    }
    const promise = (async () => {
      try {
        return await getStreams(id, env);
      } finally {
        inFlightStreams.delete(id);
      }
    })();
    inFlightStreams.set(id, promise);
    return promise;
  }
  ```
  Esto evita que múltiples peticiones simultáneas del mismo usuario (o de varios usuarios en el mismo PoP de Cloudflare) disparen 7 llamadas de red paralelas duplicadas al mismo tiempo.

---

### Mejora 8: Soporte Debrid (Real-Debrid / TorBox)
- **Inspiración**: `kunolabs/yukistreams-addon`.
- **Beneficio**: Si algún hoster soportado por Real-Debrid o TorBox aparece en las fuentes (por ejemplo servidores Mega, 1Fichier, Rapidgator, Pixeldrain, etc.), el addon puede convertir enlaces caídos o lentos en descargas directas a velocidad Gigabit sin pasar por proxies ni consumir ancho de banda de Cloudflare/Deno.
- **Implementación sugerida**:
  1. Integración en `/configure` de un campo para ingresar la API Key de Real-Debrid o TorBox.
  2. Módulo `src/lib/debrid.ts` que consulte `/unrestrict/link` con la URL del hoster extraído.

---

## 4. Comparativa de Puntos Fuertes: ¿En qué destaca ya tu proyecto?

Es importante resaltar que **stremio-doramas** posee fortalezas técnicas que superan a varios de los proyectos analizados:

1. **Arquitectura Serverless y Coste Cero**:
   Mientras que `streamvix`, `tvvoo`, `WebStreamrMBG` y `brazilcam4-nuvio` dependen de servidores Node.js/Docker siempre activos (con coste de VPS o riesgo de suspensión en plataformas free como Render/Baby-BeamUp), tu addon corre en **Cloudflare Workers** (edge distribuido globalmente con latencia menor a 20ms) y **Deno Deploy**, lo que ofrece alta disponibilidad y escalabilidad automática sin coste de mantenimiento de servidor.
2. **Slug Mapping y Resolución Cruzada Inteligente (`src/lib/slugmap.ts`)**:
   Tu sistema de reconciliación de slugs mediante puntuación de tokens, stopwords y cache de mapeo cruzado supera la lógica de matching de la mayoría de addons comunitarios, permitiendo encontrar episodios en WordPress DooPlay aunque el usuario haya entrado desde otra fuente o desde un ID IMDb.
3. **Mapeo IMDb Nativo (`tt...`)**:
   Soporte completo para resolver IDs de IMDb directamente a episodios de doramas, facilitando la integración con los catálogos principales de Stremio (Cinemeta).
4. **Proxy HLS Seguro con Anti-SSRF**:
   El mecanismo `safeProxyUrl` en `src/lib/utils.ts` y el proxy Deno con allowlist estricta ofrecen una seguridad frente a ataques SSRF mucho más robusta que la vista en proyectos que hacen fetch ciego de URLs pasadas por parámetro.

---

## 5. Conclusión y Recomendación de Siguientes Pasos

Las mejoras que aportarían un **mayor salto de calidad inmediato con menor fricción** a tu proyecto son:

1. **Crear la interfaz web de configuración `/configure` con manifest dinámico**: Permite a los usuarios elegir qué fuentes quieren y habilitar/deshabilitar streams de navegador (`externalUrl`).
2. **Añadir compatibilidad con MediaFlow Proxy (MFP)**: Permitirá a los usuarios que tengan una instancia de MFP reproducir casi la totalidad de servidores que hoy día quedan como enlaces externos 🌐.
3. **Inyectar fechas `released` en los episodios**: Para activar el soporte de Calendario oficial de Stremio.
4. **Proxy de imágenes para `tudorama`**: Para solventar definitivamente el bug visual de miniaturas en Stremio Web.
