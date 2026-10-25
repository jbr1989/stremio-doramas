# Análisis Comparativo y Propuestas de Mejora para `stremio-doramas`

Este documento contiene un estudio comparativo entre **stremio-doramas** y cuatro proyectos de referencia del ecosistema de addons para Stremio:

1. [qwertyuiop8899 / streamvix](https://github.com/qwertyuiop8899/streamvix)
2. [qwertyuiop8899 / tvvoo](https://github.com/qwertyuiop8899/tvvoo)
3. [newman2x / WebStreamrMBG](https://github.com/newman2x/WebStreamrMBG)
4. [kunolabs / yukistreams-addon](https://github.com/kunolabs/yukistreams-addon)

---

## 1. Resumen Ejecutivo y Estado Actual de `stremio-doramas`

Actualmente, **stremio-doramas** es un addon especializado de alto rendimiento para contenido en español (doramas/kdramas/animes), construido sobre una arquitectura **serverless dual**:
- **Cloudflare Worker** (`src/index.ts`): Sirve el manifiesto, catálogos, metadatos y endpoints de debug.
- **Proxy Auxiliar Deno Deploy** (`deno/fetch.ts`): Utilizado para bypass de restricciones IP (egress de Cloudflare bloqueado), retransmisión de playlists HLS `.m3u8` IP-bound y cabeceras personalizadas.

### Fortalezas de `stremio-doramas`:
- **Serverless Edge ultrarrápido**: Tiempos de respuesta extremadamente bajos gracias al despliegue en el edge de Cloudflare + Deno.
- **Amplia cobertura de fuentes especializadas**: Soporta `dlat`, `dplay`, `kplay`, `dflix`, `tudorama`, `pandrama`, `dsub`, `kisskh`, etc.
- **Puntos de diagnóstico avanzados**: Rutas de prueba interna como `/debug-all`, `/debug-extractor`, `/debug-extract`, etc.

---

## 2. Análisis Detallado de los Proyectos Comparados

### A. StreamViX (`qwertyuiop8899/streamvix`)
* **Propósito**: Addon multipropósito (Películas, Series, Anime, Live TV, Deportes).
* **Arquitectura**: Servidor en Node.js/Python con integración de Docker/ElfHosted.
* **Aspectos Clave**:
  - **Wrap de MediaFlow Proxy (MFP)**: Integra directamente MediaFlow Proxy para retransmitir streams y evitar bloqueos geográficos o vencimiento de tokens.
  - **Soporte de Proxies SOCKS5/HTTP por dominio/proveedor**: Permite configurar variables como `AU_PROXY`, `AS_PROXY`, `AW_PROXY` o `PROXY=socks5h://warp:1080` (utilizando Cloudflare WARP en Docker) para enrutar tráfico de sitios protegidos por Cloudflare (403).
  - **Extracción diferida/perezosa (Lazy vs Eager)**: Configurable mediante flags como `STATIC_DADDY_LAZY=1` para no ralentizar la carga de catálogos y resolver los links directos únicamente al presionar Play.

### B. TvVoo (`qwertyuiop8899/tvvoo`)
* **Propósito**: Addon enfocado en Live TV internacional y canales por país.
* **Arquitectura**: Aplicación Node.js autosuficiente (Docker / HuggingFace / Koyeb).
* **Aspectos Clave**:
  - **URL de Manifiesto Configurable dinámicamente**: Permite generar la URL del manifiesto con parámetros codificados en el path (`/cfg-it-uk-fr/manifest.json` o `/manifest.json?include=it,uk`).
  - **Página de configuración (`/configure`)**: Interfaz gráfica en el navegador para que el usuario seleccione filtros, países o canales antes de instalar.
  - **Preservación e Inyección de IP del cliente**: Decodificación e inyección de firmas (`addonSig`) para priorizar la IP del usuario final sobre la del servidor.

### C. WebStreamrMBG (`newman2x/WebStreamrMBG`)
* **Propósito**: Fork de WebStreamr enfocado en scraping y resolución de streams HTTP/HLS de diversos hosters de video.
* **Arquitectura**: Servidor Node.js con base de datos SQLite para caché persistente.
* **Aspectos Clave**:
  - **Página UI de Configuración Personalizada**: Interfaz web moderna donde los usuarios pueden habilitar o deshabilitar fuentes/extractores específicos.
  - **Integración con FlareSolverr**: Permite sobrepasar retos Cloudflare / Turnstile conectándose a un contenedor FlareSolverr (`FLARESOLVERR_ENDPOINT`).
  - **Soporte de Proxies por Dominio (`PROXY_CONFIG`)**: Reglas tipo minimatch para enrutar hosters específicos mediante proxies dedicados (ej. `dood.to:http://user:pass@ip:port`).
  - **Soporte Debrid**: Integración opcional con servicios como TorBox / RealDebrid para reproducir streams sin buffering.
  - **Desactivación de Fuentes/Extractores vía ENV**: `DISABLED_SOURCES` y `DISABLED_EXTRACTORS`.

### D. Yukistreams (`kunolabs/yukistreams-addon`)
* **Propósito**: Addon enfocado en Anime, Drama Asiático y Películas con enfoque "Clean UX".
* **Arquitectura**: Servicio alojado con perfiles de configuración dinámicos.
* **Aspectos Clave**:
  - **Filtrado y Organización Limpia ("Clean stream rows")**: Elimina duplicados ruidosos y presenta la información de calidad, idioma, fuente y caché de forma estandarizada y legible.
  - **Perfiles de usuario personalizables**: El usuario elige fuentes, calidad preferida, debrid activado, P2P opcional y MediaFlow proxy en una UI guiada.
  - **Manejo de Errores Resiliente**: Fallbacks conservadores cuando un servidor falla, evitando filas muertas o bloqueos en la interfaz de Stremio.
  - **Caché Inteligente de Metadatos y Artwork**: Minimiza pausados durante la navegación de catálogos pesados.

---

## 3. Matriz Comparativa

| Característica / Funcionalidad | `stremio-doramas` (Actual) | `streamvix` | `tvvoo` | `WebStreamrMBG` | `yukistreams-addon` |
|---|---|---|---|---|---|
| **Plataforma/Deployment** | Cloudflare Workers + Deno Deploy | Docker / Node.js / Python | Docker / Node.js | Node.js (SQLite) | Cloud Service |
| **Página de Configuración (`/configure`)** | ❌ No (URL estática) | ⚠️ Básica | ✅ Sí (Landing UI) | ✅ Sí (UI completa) | ✅ Sí (UI guiada) |
| **Manifiesto Dinámico (Parámetros)** | ❌ No | ⚠️ Vía envs | ✅ Sí (`/cfg-...`) | ✅ Sí (Filtros fuentes) | ✅ Sí (Perfiles) |
| **Integración MediaFlow Proxy (MFP)** | ❌ No (Proxy Deno propio) | ✅ Sí | ✅ Sí | ✅ Sí | ✅ Sí |
| **Integración con Debrid (RealDebrid/TorBox)** | ❌ No | ❌ No | ❌ No | ✅ Sí | ✅ Sí |
| **Bypass Anti-Bot / Cloudflare** | ⚠️ Básico (Proxy Deno + CF Browser Rendering) | ✅ WARP / SOCKS5 | ❌ No | ✅ FlareSolverr | ✅ Proxy / Direct |
| **Formateo de Filas ("Clean Stream Rows")** | ⚠️ Estándar (`[Servidor] Nombre`) | ⚠️ Estándar | ⚠️ Estándar | ⚠️ Detallado | ✅ Excelente (Limpio) |
| **Desactivación de Fuentes/Extractores** | ❌ No (Todas activas) | ❌ No | ❌ No | ✅ Sí (`DISABLED_SOURCES`) | ✅ Sí (Vía UI) |

---

## 4. Propuestas Detalladas de Mejora para `stremio-doramas`

A continuación se detallan las mejoras arquitectónicas y de funcionalidades que se podrían implementar en `stremio-doramas`, tomando lo mejor de los cuatro proyectos analizados.

---

### MEJORA 1: Página Web de Configuración (`/configure`) y Manifiesto Dinámico
*Inspirado en: WebStreamrMBG, TvVoo y Yukistreams*

#### Descripción:
Actualmente, `stremio-doramas` ofrece un único enlace fijo de manifiesto (`/manifest.json`). No es posible para el usuario seleccionar qué fuentes activar (ej. solo `dlat` y `dflix`), ni configurar opciones como calidad preferida o servidores de proxy personales.

#### Modificaciones propuestas:
1. **Endpoint `/configure`**:
   - Crear una interfaz HTML/JS servida desde el Cloudflare Worker.
   - Permitir al usuario seleccionar:
     - Fuentes activas (checkboxes para `DoramasLat`, `DoramasFlix`, `Pandrama`, `Tudorama`, `KissKH`, etc.).
     - Orden de prioridad de los servidores de video (StreamWish, SaveFiles, MP4Upload, Pixeldrain, etc.).
     - Opción de incluir/excluir mirrors o fuentes externas.
     - Configuración opcional de un servidor MediaFlow Proxy o Debrid propio.
2. **Generación de URL de Manifiesto encriptada o por parámetros**:
   - Soporte para URLs tipo `/cfg/<base64_config>/manifest.json` o `/manifest.json?sources=dlat,dflix&quality=720p`.
   - El Worker leerá esta configuración en cada solicitud `/stream/` o `/catalog/` para filtrar fuentes no deseadas.

---

### MEJORA 2: Integración con MediaFlow Proxy (MFP) y Debrid
*Inspirado en: StreamViX y WebStreamrMBG*

#### Descripción:
Algunos reproductores de Stremio (especialmente en Android TV / Fire TV) sufren problemas con playlists HLS con redirecciones o tokens de corta duración. Además, ciertos hosters aplican bloqueos severos por IP.

#### Modificaciones propuestas:
1. **Soporte opcional de MediaFlow Proxy (MFP)**:
   - Permitir pasar `MFP_URL` y `MFP_PASSWORD` en la configuración del addon.
   - Si está activo, el addon puede envolver las URLs HLS o directas en el formato de MediaFlow Proxy (`https://mfp.domain.com/proxy/hls?url=...&api_password=...`).
2. **Soporte de Descompresión/Streaming mediante Debrid (TorBox / Real-Debrid)**:
   - Para fuentes que ofrecen enlaces de descarga directa en MP4 (ej. Pixeldrain, Savefiles, Hexload), permitir enviar el enlace a un proveedor Debrid si el usuario ingresó su API Key en la página de configuración.

---

### MEJORA 3: Limpieza y Estandarización de Filas de Stream ("Clean Stream Rows")
*Inspirado en: Yukistreams*

#### Descripción:
En la actualidad, cuando un episodio está disponible en múltiples sitios, se pueden generar bastantes filas con nombres repetidos o con etiquetas poco descriptivas.

#### Modificaciones propuestas:
1. **Agrupación y Desduplicación Inteligente**:
   - Identificar cuando dos fuentes devuelven exactamente el mismo servidor o la misma URL de video y combinarlas o mostrar la de mayor velocidad/resolución.
2. **Formato Estándar de Títulos de Stream**:
   - Incluir badges informativos estandarizados:
     - 🇪🇸 `[LAT]` / `[SUB]` (Audio Latino vs Subtitulado en Español).
     - ⚡ `[HLS 1080p]` / `[MP4Directo]` / `[Deno Proxy]`.
     - 🏷️ `[DoramasFlix]` / `[DoramasLat]` (Indicador de fuente primaria).
3. **Filtros de Servidores Problemáticos**:
   - Opción para ocultar automáticamente enlaces externos (🌐 `externalUrl`) que no se pueden reproducir nativamente en Stremio si el usuario prefiere solo reproducciones directas.

---

### MEJORA 4: Resiliencia Avanzada y Manejo de Cloudflare / Anti-Bot
*Inspirado en: StreamViX y WebStreamrMBG*

#### Descripción:
Sitios como `kdramasplay.com` o servidores como `do7go.com` / `playmogo.com` imponen retos de Cloudflare. Actualmente `stremio-doramas` utiliza Cloudflare Browser Rendering o el proxy Deno.

#### Modificaciones propuestas:
1. **Soporte para FlareSolverr / SOCKS5 externo en Deno Proxy**:
   - Extender `deno/fetch.ts` para aceptar un endpoint secundario de `FLARESOLVERR_ENDPOINT` o soporte para proxies SOCKS5 (ej. Cloudflare WARP local `socks5h://warp:1080`).
   - Si el proxy Deno recibe un 403 con reto de Cloudflare, reintentar automáticamente a través de FlareSolverr o la ruta SOCKS5 configurada.
2. **Modo "Lazy Extraction" (Resolución al reproducir)**:
   - Implementar un endpoint de resolución dinámica `/resolve?url=...` que difiera la extracción de embeddings pesados hasta el momento justo en que el usuario le da a "Play" en Stremio, reduciendo los tiempos de respuesta del endpoint `/stream/`.

---

### MEJORA 5: Selección de Fuentes y Extractores vía Variables de Entorno / KV
*Inspirado en: WebStreamrMBG*

#### Descripción:
Permitir deshabilitar fuentes o extractores específicos temporalmente en producción sin modificar código ni volver a desplegar el Worker.

#### Modificaciones propuestas:
1. **Variables de Entorno `DISABLED_SOURCES` y `DISABLED_EXTRACTORS`**:
   - Permitir definir en `wrangler.toml` o Cloudflare KV listas como:
     - `DISABLED_SOURCES="tudorama,kplay"`
     - `DISABLED_EXTRACTORS="hexload,pixeldrain"`
   - El registro de fuentes (`src/registry.ts`) filtrará automáticamente los módulos deshabilitados.

---

## 5. Plan Recomendado de Implementación por Fases

Si en el futuro se decide ejecutar estas mejoras en el código de `stremio-doramas`, se recomienda seguir el siguiente orden de desarrollo:

### **Fase 1: Configuración y Manifiesto Dinámico (Prioridad Alta)**
- Implementar la ruta `/configure` en Cloudflare Workers con UI web.
- Permitir al usuario seleccionar fuentes activas y preferencias de idioma (Sub / Latino).
- Parsear parámetros de configuración desde la URL del manifiesto.

### **Fase 2: Formateo y Calidad de Respuesta ("Clean Stream Rows") (Prioridad Alta)**
- Estandarizar las etiquetas de los streams (Idioma, Calidad, Servidor, Fuente).
- Añadir desduplicación de enlaces idénticos.
- Permitir ocultar reproducciones externas (`externalUrl`).

### **Fase 3: Integración de MediaFlow Proxy & Debrid (Prioridad Media)**
- Añadir opciones de MFP (URL + Password) en la UI `/configure`.
- Modificar la construcción de URLs de reproducción para envolver HLS/MP4 con MFP si está configurado.

### **Fase 4: Bypasses Avanzados e Integración de FlareSolverr (Prioridad Media/Baja)**
- Añadir soporte de FlareSolverr en `deno/fetch.ts`.
- Implementar la variable `DISABLED_SOURCES` / `DISABLED_EXTRACTORS` desde KV.

---

## Conclusión

El proyecto **stremio-doramas** ya posee una arquitectura serverless sumamente eficiente y ligera. Al incorporar una **interfaz de configuración (`/configure`)**, **formateo de streams más limpio**, **soporte para MediaFlow Proxy** y **sistemas de bypass resilientes**, el addon alcanzará el nivel de madurez y versatilidad de los proyectos más avanzados de la comunidad de Stremio.
