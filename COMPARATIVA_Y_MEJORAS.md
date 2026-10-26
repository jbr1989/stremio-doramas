# Comparativa de `stremio-doramas` y Propuestas de Mejora

Este documento analiza el proyecto **`stremio-doramas`** en comparación con 5 proyectos de la comunidad de Stremio / Nuvio:

1. [qwertyuiop8899/streamvix](https://github.com/qwertyuiop8899/streamvix)
2. [qwertyuiop8899/tvvoo](https://github.com/qwertyuiop8899/tvvoo)
3. [newman2x/WebStreamrMBG](https://github.com/newman2x/WebStreamrMBG)
4. [kunolabs/yukistreams-addon](https://github.com/kunolabs/yukistreams-addon)
5. [dudu-martins/brazilcam4-nuvio](https://github.com/dudu-martins/brazilcam4-nuvio)

El objetivo es identificar arquitecturas, funcionalidades y patrones de diseño utilizados en estos repositorios que se podrían adaptar a `stremio-doramas` para mejorar el rendimiento, la resiliencia contra bloqueos (Cloudflare/IP-lock), la experiencia del usuario y la flexibilidad de configuración.

---

## 1. Contexto Actual de `stremio-doramas`

Actualmente, `stremio-doramas` es un addon basado en **Cloudflare Workers** con un proxy auxiliar en **Deno Deploy**:
- **Fuentes soportadas**: WordPress DooPlay (`dlat`, `dplay`, `kplay`), GraphQL (`dflix`), Laravel/React (`pandrama`), Blogger (`dsub`), y WStream (`tudorama`).
- **Resolución de Streams**: Extractores personalizados para StreamWish, SaveFiles, Mp4Upload, Hexload, Pixeldrain, etc.
- **Relay / Proxying**: Utiliza Deno Deploy (`FETCH_PROXY_URL`) para evitar bloqueos por IP de datacenter de Cloudflare Worker y resolver reproductores IP-bound.
- **Herramientas de diagnóstico internas**: Rutas como `/_health`, `/debug`, `/debug-all`, `/debug-extract`, `/debug-extractor`.

---

## 2. Análisis Comparativo por Proyecto

### 2.1. `qwertyuiop8899/streamvix`

#### Qué aporta este proyecto:
- **Estructura Híbrida y Fallbacks**: Utiliza un sistema multi-capa donde intenta primero envolver streams a través de **MediaFlow Proxy (MFP)** y cuenta con extractores TypeScript como fallback de seguridad.
- **Enrutamiento de Proxy por Proveedor (`PROXIES`)**: Permite asignar proxies SOCKS5/HTTPS independientes para cada fuente o dominio (`AU_PROXY`, `AS_PROXY`, `PROXY`), permitiendo derivar solo el tráfico bloqueado por Cloudflare a través de infraestructuras específicas (como instancias de Cloudflare WARP local o Proxies SOCKS5).
- **Ejecución y Mantenimiento Programado**: Incluye schedulers en background (`Live.py`) con endpoints administrativos para purgar cache (`/live/purge`), forzar actualización (`/live/update`) y recargar catálogos (`/live/reload`).

#### Posibles mejoras a implementar en `stremio-doramas`:
1. **Configuración de Proxies Específicos por Fuente**:
   - *Idea*: Extender la configuración del proxy en Deno Deploy o en el Worker para definir proxies por origen (ej. `KPLAY_PROXY_URL`, `TUDORAMA_PROXY_URL`). Si solo `kdramasplay` o `doramasyt` activan retos TLS/Cloudflare, se puede enrutar solo ese tráfico a un servidor dedicado o VPN/WARP sin afectar al resto de fuentes.
2. **Soporte Opcional para MediaFlow Proxy (MFP)**:
   - *Idea*: Permitir que el usuario configure la URL de su propio MediaFlow Proxy en la instalación para que streams IP-bound o con headers restrictivos (como LuluStream o StreamWish) sean procesados por su propia instancia MFP.
3. **Pertenencia y Etiquetas Estructuradas en Streams**:
   - *Idea*: Adoptar un sistema de nombrado de streams estandarizado que indique el origen, la velocidad/calidad estimada y si requiere o no proxy cliente-side (`[Directo]`, `[Proxy Deno]`, `[MFP]`).

---

### 2.2. `qwertyuiop8899/tvvoo`

#### Qué aporta este proyecto:
- **Página de Configuración Interactiva (`/configure`)**: Cuenta con una interfaz web integrada que genera enlaces dinámicos de manifiesto basados en las selecciones del usuario (inclusión/exclusión de países, servidores, etc.).
- **Manifiesto Dinámico por URL**: Admite rutas parametrizadas como `/cfg-it-uk/manifest.json` o `/manifest.json?include=dflix,pandrama&exclude=tudorama`, adaptando el manifiesto y los catálogos en tiempo real según las opciones del manifiesto cargado por el cliente.
- **Forwarding Inteligente de IP**: Decodifica y reescribe la firma del stream priorizando la IP pública del espectador para evitar bloqueos por expiración de tokens IP-lock.

#### Posibles mejoras a implementar en `stremio-doramas`:
1. **Interfaz Web de Configuración (`/configure`)**:
   - *Idea*: Crear una vista web responsiva e interactiva donde el usuario pueda personalizar su instalación antes de agregar el addon a Stremio.
2. **Toggles de Fuentes y Catálogos en la URL del Manifiesto**:
   - *Idea*: Implementar rutas dinámicas como `/cfg-dflix-pandrama/manifest.json` o `/manifest.json?sources=dflix,dlat`. Si un usuario prefiere no ver fuentes que dan problemas de hotlink (como `tudorama` en Stremio Web) o prefiere excluir ciertas páginas, puede desactivarlas desde la configuración sin tocar código.
3. **Decodificación y Forwarding de IP Cliente**:
   - *Idea*: Para los reproductores con tokens atados a la IP (como StreamWish o LuluStream), permitir la reescritura de tokens utilizando la cabecera `Client-IP` o `X-Forwarded-For` solicitada desde el cliente de Stremio.

---

### 2.3. `newman2x/WebStreamrMBG`

#### Qué aporta este proyecto:
- **Integración con FlareSolverr (`FLARESOLVERR_ENDPOINT`)**: Permite conectar una instancia externa de FlareSolverr para resolver automáticamente los desafíos JS / Cloudflare Turnstile de las webs fuente.
- **Desactivación Granular de Fuentes y Extractores**: Mediante variables de entorno o parámetros (`DISABLED_SOURCES`, `DISABLED_EXTRACTORS`), el administrador o usuario puede deshabilitar en caliente un extractor con fallos sin necesidad de desplegar cambios en el código principal.
- **Documentación de Limitaciones de Reproductores**: Mantiene un registro explícito de limitaciones conocidas por plataforma de Stremio (ej. comportamiento de cabeceras `Referer` en Android vs Desktop).

#### Posibles mejoras a implementar en `stremio-doramas`:
1. **Soporte para Endpoint de Bypass de Cloudflare / FlareSolverr**:
   - *Idea*: Agregar compatibilidad con un endpoint configurable de FlareSolverr o Cloudflare Browser Rendering en `fetchHtml`. Si un sitio como `dsvplay.com`, `do7go.com` o `playmogo.com` devuelve challenge 403, el Worker o Deno Deploy puede consultar automáticamente la instancia de FlareSolverr.
2. **Desactivación Dinámica de Extractores o Fuentes por Variable KV**:
   - *Idea*: Utilizar el KV Storage de Cloudflare para almacenar una lista negra de fuentes o extractores temporalmente caídos (`DISABLED_SOURCES = ["tudorama", "dsub"]`). De este modo, si un sitio fuente cambia su layout o se cae, se puede desactivar remotamente en tiempo real sin desplegar de nuevo el Worker.
3. **Documentación Extendida de Compatibilidad por Cliente de Stremio**:
   - *Idea*: Enriquecer el README con recomendaciones específicas por plataforma (Stremio Web vs Stremio Desktop vs Android TV) para anticipar problemas de cabeceras HLS o CORS.

---

### 2.4. `kunolabs/yukistreams-addon`

#### Qué aporta este proyecto:
- **Soporte para Servicios Debrid (Real-Debrid, TorBox, etc.)**: Permite a los usuarios integrar sus propias claves API de servicios Debrid para resolver enlaces HLS/MP4 o torrents a máxima velocidad.
- **Presets de Configuración y Perfiles de Usuario**: Ofrece perfiles preconfigurados (ej. "Directo", "Debrid", "Solo Latino", etc.) para simplificar la instalación a usuarios novatos.
- **Filtrado y Formateo Consistente de Filas de Stream**: Elimina ruido visual en las etiquetas de los streams (múltiples duplicados del mismo servidor) y presenta de forma clara resolución, idioma del audio, subtítulos y tipo de servidor.
- **Resiliencia en Búsqueda de Metadatos**: Búsqueda inteligente con fallbacks conservadores ante fallos temporales de proveedores de metadatos (TMDB/Kitsu).

#### Posibles mejoras a implementar en `stremio-doramas`:
1. **Formateo Limpio y Deduplicación de Streams**:
   - *Idea*: Agrupar y deduplicar las opciones devueltas por los servidores. Si una fuente devuelve 3 enlaces a StreamWish con distintas URL de iframe pero la misma calidad y audio, mostrar solo la de menor latencia o combinarlas limpiamente.
2. **Compatibilidad con Real-Debrid / TorBox**:
   - *Idea*: Para sitios que ofrecen enlaces directos de descarga o almacenamiento en la nube (como Mega, Pixeldrain, SaveFiles, Hexload), permitir que el usuario añada opcionalmente su token de Real-Debrid / TorBox para desrestriccionar y reproducir sin límite de ancho de banda o buffer.
3. **Presets Recomendados**:
   - *Idea*: En la pantalla de configuración web, proveer botones de 1 clic:
     - *Preset "Rápido"*: Activa solo fuentes GraphQL/Laravel (`dflix`, `pandrama`) que responden en < 500ms.
     - *Preset "Completo"*: Activa todas las fuentes incluyendo las basadas en WordPress.
     - *Preset "Sub Latino" / "Audio Latino"*: Filtra catálogos y streams por idioma del contenido.

---

### 2.5. `dudu-martins/brazilcam4-nuvio`

#### Qué aporta este proyecto:
- **Modos de Ordenación en Catálogo**: Ofrece selectores de ordenación directamente en la interfaz de Stremio ("Em destaque", "Mais Espectadores", "Menos Espectadores").
- **Estructura Sencilla y Enfoque Directo**: Prioriza la experiencia en pantalla con miniaturas enriquecidas, contadores y paginación rápida con cache local corto (60s).

#### Posibles mejoras a implementar en `stremio-doramas`:
1. **Opciones de Ordenación en Catálogos de Doramas**:
   - *Idea*: Agregar opciones de filtro y orden en los manifiestos de catálogo de Stremio:
     - *Por Fecha de Actualización* (Últimos episodios añadidos).
     - *Por Idioma* (Sub Español vs Latino).
     - *Por Popularidad / En Tendencia*.
2. **Paginación Consistente y Cache Multinivel en Catálogos**:
   - *Idea*: Estandarizar la paginación de catálogos entre todas las fuentes (`skip=0`, `skip=20`, etc.) utilizando la caché KV para almacenar los resultados del catálogo por 5-15 minutos y agilizar la navegación en Stremio.

---

## 3. Matriz Resumen de Posibles Modificaciones

| Categoría | Posible Modificación | Proyectos de Referencia | Dificultad Estimada | Impacto / Beneficio |
|---|---|---|---|---|
| **Configuración / UI** | Crear página web `/configure` interactiva para personalizar fuentes y parámetros. | `tvvoo`, `yukistreams-addon`, `WebStreamrMBG` | Media | 🌟 Muy Alto: Facilita la instalación y permite a los usuarios personalizar el addon. |
| **Filtros por URL** | Permitir activar/desactivar fuentes vía URL de manifiesto (`/cfg-dflix-pandrama/manifest.json`). | `tvvoo`, `streamvix` | Baja | 🌟 Alto: Permite omitir fuentes lentas o con problemas de imágenes según el cliente. |
| **Bypass / Proxies** | Soporte para FlareSolverr / Cloudflare Browser Rendering y proxies SOCKS5 por proveedor. | `WebStreamrMBG`, `streamvix` | Media | 🌟 Alto: Recupera acceso a fuentes con protecciones anti-bot de Cloudflare (`do7go`, `playmogo`). |
| **MediaFlow Proxy** | Integración opcional de cliente MediaFlow Proxy para enrutar streams IP-bound o con headers restrictivos. | `streamvix`, `WebStreamrMBG`, `yukistreams-addon` | Media | 🌟 Alto: Evita congelamientos o error 403 en dispositivos Android / Smart TV. |
| **Debrid** | Integración opcional de Real-Debrid / TorBox para desrestriccionar enlaces directos (Pixeldrain, Hexload, Mega). | `yukistreams-addon`, `WebStreamrMBG` | Media | 🚀 Medio/Alto: Mejora la velocidad de reproducción y elimina límites de ancho de banda. |
| **Gestión de Streams** | Deduplicación de enlaces idénticos y formateo unificado de etiquetas (`[Directo]`, `[Proxy]`, calidad, idioma). | `yukistreams-addon`, `streamvix` | Baja | 🎨 Alto: Interfaz más limpia sin duplicados ni etiquetas confusas en Stremio. |
| **Gestión de Fuentes** | Blacklist dinámica de fuentes/extractores mediante KV Storage sin redeploy (`DISABLED_SOURCES`). | `WebStreamrMBG` | Baja | 🛠️ Alto: Mantenimiento inmediato sin interrumpir el servicio total. |
| **Catálogos** | Opciones de ordenación en el catálogo de Stremio (Últimos agregados, Latino, Subtitulado). | `brazilcam4-nuvio`, `yukistreams-addon` | Baja | 🎨 Medio: Facilita el descubrimiento de nuevos doramas. |

---

## 4. Conclusión y Hoja de Ruta Sugerida

El proyecto `stremio-doramas` cuenta con una base sólida gracias al uso de Cloudflare Workers y Deno Deploy. Sin embargo, basándonos en el análisis de estos 5 proyectos, se identifican 3 fases principales de mejora recomendadas:

1. **Fase 1: Experiencia de Usuario y Personalización (Inspirado en `tvvoo` y `yukistreams-addon`)**:
   - Implementar la ruta `/configure` con una interfaz amigable.
   - Soportar manifiestos dinámicos parametrizados por URL para habilitar/deshabilitar fuentes individualmente.
   - Formatear y deduplicar las etiquetas de los streams para una lista más clara.

2. **Fase 2: Resiliencia contra Bloqueos y Redes (Inspirado en `WebStreamrMBG` y `streamvix`)**:
   - Integrar un conector configurable con FlareSolverr o Cloudflare Browser Rendering para dominios desafiados.
   - Permitir la configuración opcional de MediaFlow Proxy para usuarios con problemas de IP-lock en Smart TVs.
   - Permitir la desactivación remota de fuentes mediante KV Storage (`DISABLED_SOURCES`).

3. **Fase 3: Expandibilidad y Rendimiento (Inspirado en `yukistreams-addon` y `brazilcam4-nuvio`)**:
   - Agregar resolución opcional vía Real-Debrid / TorBox para hosts compatibles.
   - Agregar opciones de filtrado e idioma en las solicitudes de catálogo.
