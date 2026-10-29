# Comparativa de Proyectos y Propuestas de Mejora para `stremio-doramas`

Este documento analiza en detalle las características, arquitectura y soluciones técnicas de 6 proyectos de addons de Stremio de la comunidad y los compara con `stremio-doramas`. A partir de esta comparativa, se sugieren mejoras específicas adaptables a la arquitectura de `stremio-doramas` (Cloudflare Workers + Deno Deploy Proxy).

---

## 1. Resumen Ejecutivo de Proyectos Comparados

| Proyecto | Enfoque Principal | Arquitectura / Stack | Puntos Fuertes Destacables |
|---|---|---|---|
| **`stremio-doramas`** *(Este proyecto)* | Doramas en español (sub/latino) | Cloudflare Worker + Deno Deploy Proxy | Serverless Edge ultrarrápido, resolución/fan-out multifuente, mapeo inteligente de slugs entre sitios (`slugmap`). |
| **[streamvix](https://github.com/qwertyuiop8899/streamvix)** | Cine, Series, Anime e IPTV/Deportes | Node.js + Python + MediaFlow Proxy | Wrapper MFP unificado, proxies específicos por sitio (WARP/SOCKS5), auto-refresh programado de eventos live. |
| **[tvvoo](https://github.com/qwertyuiop8899/tvvoo)** | Canales de TV en Vivo (IPTV multi-país) | Node.js / Docker + landing /configure | Página `/configure` interactiva con selección de países/filtros, reescritura de firmas IP-bound para la IP del cliente. |
| **[WebStreamrMBG](https://github.com/newman2x/WebStreamrMBG)** | Películas y Series de sitios web streaming | Node.js + SQLite cache + MediaFlow Proxy | Integración opcional de FlareSolverr para retos CF, deshabilitación configurable de extractores/fuentes, SQLite local cache. |
| **[yukistreams-addon](https://github.com/kunolabs/yukistreams-addon)** | Anime, Asian Drama, Películas y Series | Servicio Hosted / Perfiles configurables | Perfiles personalizados de reproducción, soporte de Debrid (Real-Debrid, TorBox), filtrado inteligente de filas de streams (Quality/Lang clean tags). |
| **[brazilcam4-nuvio](https://github.com/dudu-martins/brazilcam4-nuvio)** | Cándidas / Live cams específicas | Node.js + Express | Catálogo dinámico con opciones de ordenación (`sort`), paginado nativo, UI limpia y directa sin dependencias complejas. |
| **[animeflv-stremio-addon (AnimES)](https://github.com/Pigamer37/animeflv-stremio-addon)** | Anime en español (AnimeFLV, TioAnime, etc.) | Node.js + Express + APIs externas | Conversión masiva de IDs (IMDB/TMDB/Kitsu/AniList/MAL vía `relations.yuna.moe`), calendario de estrenos en Stremio, filtro multi-género. |

---

## 2. Análisis Detallado por Proyecto vs. `stremio-doramas`

---

### A. [Pigamer37/animeflv-stremio-addon (AnimES)](https://github.com/Pigamer37/animeflv-stremio-addon)

#### ¿Cómo funciona?
- **Soporte de Múltiples IDs de Metadatos**: Además de sus IDs nativos (slugs del sitio), acepta IDs de **Cinemeta (IMDB `tt...`)**, **TMDB (`tmdb:...`)**, **Kitsu (`kitsu:...`)**, **AniList (`anilist:...`)**, **MyAnimeList (`mal:...`)** y **AniDB (`anidb:...`)**.
- **Mapeo entre APIs de Metadatos**: Utiliza la API pública `https://relations.yuna.moe/api/v2` para traducir automáticamente entre IDs de Kitsu/AniList/MAL y resolver la serie correcta.
- **Integración con Calendario de Stremio**: Al enviar metadatos de episodios futuros con fechas de estreno exactas (`released`), los próximos episodios aparecen automáticamente en la pestaña **Calendar** de Stremio.
- **Catálogos "En Emisión" y Filtros por Género**: Expone catálogos de contenido en emisión y permite búsquedas/filtros por géneros exactos usando la barra de búsqueda/filtros de Stremio.

#### Posibles Mejoras para `stremio-doramas`:
1. **Soporte de IDs de Kitsu / AniList / IMDB**: Actualmente `stremio-doramas` soporta TMDB e IDs nativos (`dlat:`, `dplay:`, `kplay:`, `dflix:`, `tudorama:`, `pandrama:`, `dyt:`, `dsub:`). Al integrar soporte para IDs de Kitsu o Cinemeta (IMDB) resolviéndolos hacia TMDB o títulos en español, los usuarios podrían ver streams de doramas usando addons de catálogo generales de Stremio como Kitsu o Cinemeta.
2. **Calendario de Estrenos en Stremio**: Incluir fechas de lanzamiento en los metadatos de episodios para que los doramas en emisión aparezcan en el calendario nativo del usuario en Stremio.
3. **Filtros por Género y Estado (En Emisión / Finalizados)** en los catálogos del manifiesto.

---

### B. [kunolabs/yukistreams-addon](https://github.com/kunolabs/yukistreams-addon)

#### ¿Cómo funciona?
- **Líneas de Reproducción Adaptativas por Perfil de Usuario**: Permite al usuario configurar qué vías de reproducción prefiere en su instalación (Directo HTTP/HLS, Debrid como Real-Debrid/TorBox, P2P, o Proxy MediaFlow).
- **Formatos Limpios en los Títulos de Stream**: Organiza la respuesta de streams con etiquetas claras (Calidad, Idioma, Servidor, Latencia/Caché), eliminando duplicados innecesarios y ruido visual en la interfaz del reproductor.
- **Fallback Conservador de Metadatos**: Cuando un proveedor de metadatos falla temporalmente, mantiene una caché de respaldo de identidades y portadas sin romper las filas de reproducción.

#### Posibles Mejoras para `stremio-doramas`:
1. **Estandarización y Formateo Limpio de Nombres de Stream**: Unificar el formato del título/descripción de los streams devueltos por `stremio-doramas` (ejemplo: `[LATINO] StreamWish • 1080p` o `[SUB] MP4Upload • HD`), aprovechando que Stremio exige no duplicar `title` y `description`.
2. **Filtrado de Calidad / Fuentes en Preferencias**: Opción para que el usuario elija sus servidores preferidos (ej. priorizar HLS sobre enlaces externos `externalUrl`).
3. **Soporte Opcional de Debrid**: Aunque los doramas se sirven por HLS/MP4 desde cyberlockers/embeds, permitir resolver enlaces de servidores que soporten Debrid (o archivadores en torrent) daría streams más estables.

---

### C. [qwertyuiop8899/streamvix](https://github.com/qwertyuiop8899/streamvix) & [qwertyuiop8899/tvvoo](https://github.com/qwertyuiop8899/tvvoo)

#### ¿Cómo funciona?
- **Página Landing de Configuración `/configure`**: Ofrecen una interfaz web donde el usuario selecciona opciones antes de instalar el addon en Stremio, generando un Manifest URL parametrizado (ej. `https://addon.com/cfg-opciones/manifest.json`).
- **MediaFlow Proxy Unificado**: Utilizan MediaFlow Proxy (MFP) para encapsular transmisiones que requieren cabeceras HTTP específicas (`Referer`, `User-Agent`) o que aplican bloqueo geográfico/IP.
- **Estrategia de Proxies Dedicados por Host**: Permite definir proxies independientes por dominio (ejemplo `AU_PROXY`, `AS_PROXY`, `PROXY=socks5h://warp:1080`), permitiendo derivar el tráfico de sitios que bloquean IPs de datacenters a través de Cloudflare WARP o SOCKS5.
- **Diagnóstico y Reload en Caliente**: Endpoints administrativos como `/live/reload`, `/static/reload`, `/health` para actualizar listas y cachés sin reiniciar el proceso.

#### Posibles Mejoras para `stremio-doramas`:
1. **UI Web de Configuración (`/configure`)**: Implementar una página web interactiva sencilla (servida directamente desde Cloudflare Worker) que permita al usuario personalizar la instalación (activar/desactivar fuentes específicas como `dflix`, `kplay`, `pandrama`, etc.).
2. **Configuración de Proxy Personalizado / MediaFlow**: Permitir que usuarios con instancias propias de MediaFlow Proxy o proxies SOCKS5/HTTP pasen sus credenciales en la URL de configuración para resolver embeds con geobloqueo o IP-locking.
3. **Optimización de Firma / Forwarding IP**: En el proxy Deno Deploy, explorar el uso de cabeceras forwarding para mejorar la compatibilidad con CDN restrictivas.

---

### D. [newman2x/WebStreamrMBG](https://github.com/newman2x/WebStreamrMBG)

#### ¿Cómo funciona?
- **Desactivación Configurable de Fuentes y Extractores**: Permite deshabilitar extractores o fuentes defectuosas mediante variables de entorno (ej. `DISABLED_SOURCES=kplay`, `DISABLED_EXTRACTORS=mixdrop`).
- **Integración con FlareSolverr**: Cuando un dominio activa retos duros de Cloudflare, reenvía la petición a una instancia de FlareSolverr para resolver las cookies Turnstile/CF.
- **Configuración de Proxy Basada en Patrones (Minimatch)**: Mapeo fino de proxies por dominio (`PROXY_CONFIG=dood.to:http://...,*:socks5://...`).

#### Posibles Mejoras para `stremio-doramas`:
1. **Interruptores de Fuentes (Source Toggles)**: Permitir deshabilitar fuentes problemáticas a nivel de Worker (mediante KV o parámetros en la URL de instalación `/cfg-disabled=kplay/manifest.json`). De este modo, si una fuente está caída o ralentiza la respuesta, el usuario puede apagarla.
2. **Fallback Dinámico de Reintento de Proxies**: Mejorar la cascada de proxies en `fetchHtml` registrando métricas de fallo en KV para saltar temporalmente proxies o métodos de renderizado caídos.

---

### E. [dudu-martins/brazilcam4-nuvio](https://github.com/dudu-martins/brazilcam4-nuvio)

#### ¿Cómo funciona?
- **Ordenación del Catálogo Dinámica (`Extra Options`)**: Ofrece opciones en el manifest para ordenar catálogos dentro de Stremio (`sort: "Mais Espectadores" | "Menos Espectadores" | "Em Destaque"`).
- **Paginación Simplificada por Lotes**: Peticiones paginadas con concurrencia controlada para no saturar el servidor upstream.

#### Posibles Mejoras para `stremio-doramas`:
1. **Catálogos con Parámetros de Ordenación y Filtro**: Añadir filtros en el manifiesto (`extra: [{ name: "genre" }, { name: "sort" }]`) para permitir ordenar doramas por "Populares", "Recientes" o "Por Género" directamente desde la pestaña **Descubrir** de Stremio.

---

## 3. Matriz Comparativa de Características

| Característica | `stremio-doramas` | `streamvix` | `tvvoo` | `WebStreamrMBG` | `yukistreams` | `animeflv-addon` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Serverless / Edge Ready (Workers/Deno)** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Mapeo de Slugs entre Fuentes (`slugmap`)** | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Bypass Cloudflare (Browser Render / Proxy)** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Página de Configuración Interactive `/configure`** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Mapeo de IDs Externos (Kitsu / AniList / MAL)** | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Integración con Calendario de Stremio** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Filtrado / Ordenación en Catálogo por Géneros** | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Desactivación Selección de Fuentes en UI** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Compatibilidad con MediaFlow Proxy** | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## 4. Propuestas Detalladas de Modificaciones para `stremio-doramas`

Basándonos en los hallazgos de los proyectos analizados, a continuación se detallan las posibles modificaciones que podrían implementarse en `stremio-doramas`, clasificadas por áreas clave:

### 💡 1. Mapeo de Metadatos Interoperable (Kitsu, AniList y Calendario)
*Inspirado en `animeflv-stremio-addon` y `yukistreams-addon`*

- **Soporte de Prefijos de ID Adicionales en el Manifest**:
  Añadir prefijos de ID como `kitsu:`, `anilist:` o `tt` (IMDB) a las declaraciones de `resources` (`stream`, `meta`).
- **Traductor de IDs vía API `relations.yuna.moe` o Kitsu API**:
  Cuando el cliente Stremio solicita un stream para `kitsu:12345` o `anilist:67890`, resolver el ID hacia el título en inglés/romaji o TMDB ID, y luego invocar el motor de búsqueda `slugmap` existente para hallar los streams en las fuentes de doramas (`dlat`, `dflix`, etc.).
- **Fechas de Lanzamiento en Metadatos de Episodios para el Calendario**:
  Poblar el campo `released` (formato ISO 8601 `YYYY-MM-DDTHH:mm:ss.sssZ`) en las respuestas de metadatos de episodios. Esto activará la integración nativa con la pestaña **Calendario** en Stremio para doramas en emisión.

---

### 💡 2. Interfaz Web de Configuración (`/configure`) y URLs Parametrizadas
*Inspirado en `tvvoo`, `streamvix` y `yukistreams-addon`*

- **Página Web `/configure` Servida desde el Worker**:
  Crear una ruta GET `/configure` que devuelva un HTML/JS liviano (UI responsive).
- **Ajustes Personalizables por el Usuario**:
  - **Activar/Desactivar Fuentes**: Permitir al usuario seleccionar qué fuentes desea consultar (ej. activar solo `dflix` y `pandrama` si prefiere mayor velocidad).
  - **Prioridad de Servidores**: Permitir priorizar reproductores directos (HLS / MP4) sobre enlaces externos (`externalUrl`).
  - **Proxy Personalizado**: Permitir ingresar una URL de proxy propio (MediaFlow Proxy / Deno Proxy personalizado).
- **Generación de Manifest Dinámico**:
  La interfaz generará una URL de instalación parametrizada como `/cfg-[opciones]/manifest.json` que el Worker leerá para ajustar los recursos servidos.

---

### 💡 3. Mejora de Catálogos: Filtros por Género, Estado y Ordenación
*Inspirado en `brazilcam4-nuvio` y `animeflv-stremio-addon`*

- **Filtros por Género en Manifest (`catalogs.extra`)**:
  Declarar la propiedad `extra: [{ name: "genre", options: ["Romance", "Comedia", "Drama", "Acción", "Misterio"], isRequired: false }]` en las definiciones de catálogo de `manifest.ts`.
- **Filtro de Estado ("En Emisión" / "Finalizados")**:
  Añadir un catálogo o filtro especial `onair` para listar doramas que se están transmitiendo actualmente.
- **Soporte de Búsqueda Integrada (`search`) en todos los Catálogos**:
  Garantizar que la barra de búsqueda global de Stremio redirija correctamente las consultas a las fuentes soportadas (`dflix`, `dlat`, `pandrama`, etc.).

---

### 💡 4. Formateo Limpio y Estandarizado de Streams
*Inspirado en `yukistreams-addon`*

- **Formato Visual Estandarizado en Títulos de Stream**:
  Aprovechar la regla existente de Stremio (*usar `title` o `description`, no ambos*) para mostrar etiquetas estructuradas y comprensibles:
  ```
  [LATINO] 🎥 StreamWish • HLS 1080p
  [SUB ESP] ⚡ MP4Upload • Directo
  ```
- **Filtro de Enlaces Caídos o Incompatibles**:
  Añadir un indicador claro para los enlaces que requieren apertura en navegador externo (🌐 *Abrir en navegador*), separándolos de los reproductores nativos integrados en Stremio.

---

### 💡 5. Resiliencia de Infraestructura y Proxies
*Inspirado en `streamvix` y `WebStreamrMBG`*

- **Sincronización Automática de Allowlist entre Worker y Proxy Deno**:
  Consolidar en un único módulo compartido o configuración la lista de regex de hosts permitidos (`STREAMWISH_HOSTS_RE`, `DOOD_HOSTS_RE`), reduciendo el riesgo de desalineación entre el Worker y Deno Deploy.
- **Soporte para Encapsulamiento Opcional en MediaFlow Proxy**:
  Para entornos o usuarios que utilicen MediaFlow Proxy en servidores locales/VPS, permitir formatear las URLs de stream con el patrón de envoltorio de MFP (`/proxy/hls?url=...&headers=...`).

---

## 5. Hoja de Ruta Sugerida de Implementación

Si en el futuro se decide llevar a cabo estas modificaciones, el orden de prioridad recomendado es:

1. **Fase 1 (Experiencia de Usuario y Catálogo)**:
   - Implementar la página `/configure` con selección de fuentes dinámicas.
   - Añadir filtros por Género y Estado ("En Emisión") en los catálogos del manifiesto.
2. **Fase 2 (Metadatos e Integración)**:
   - Integrar la conversión de IDs de Kitsu / AniList a TMDB/Slugs.
   - Poblar las fechas `released` en metadatos para habilitar el calendario de Stremio.
3. **Fase 3 (Calidad de Stream y Formato)**:
   - Refinar las etiquetas y nombres de las filas de stream (`yukistreams` style).
   - Unificar allowlists entre Worker y Deno Proxy.
