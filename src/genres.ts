// ─── Géneros: lista canónica maestra ────────────────────────────────────────
// Un único registro por género con su slug en cada fuente que lo soporta.
// Los slugs NO son portables entre sitios: cada tema (DooPlay, WStream,
// doramasyt) usa su propia taxonomía — por eso el registro guarda un slug
// por fuente, extraído in-vivo (oct. 2026) y validado contra cada sitio.
//
// Criterio de inclusión (decisión del usuario, "Opción B"): un género se
// expone cuando EXISTE como término upstream — su archivo de género responde
// 200 y es un género real, no una pseudo-categoría — aunque hoy devuelva 0
// series. Si el upstream etiqueta series mañana, el filtro se llena solo,
// sin tocar código. No se fabrican slugs: cada uno viene del registro propio
// del sitio (WP REST /wp-json/wp/v2/genres en DooPlay, listGenres GraphQL en
// dflix, /api/v1/value-lists/genres en pandrama, menú en dyt/tudorama).
//
// Cobertura de fuentes:
//   dorama (DoramasLat)  → /genero/{slug}/page/N/  (27/31 términos del
//              registry; descartados: descargar-peliculas, peliculas-anime,
//              series-anime, series-turcas). Archivo de género MIXTO
//              (tvshows+peliculas, 60 posts/página): parseDoramaCards ya
//              filtra solo /tvshows/ → cada página devuelve el subconjunto
//              de series. Validado in-vivo (comedia: 2/2 fichas con
//              /genero/comedia/). Dato upstream: romance va solo a
//              películas hoy (0 tvshows etiquetados) →dropdown honesto
//              vacío hasta que etiqueten series.
//   dsub (DoramasSub)    → /genre/{slug}/page/N/   (24/39 términos; sin
//              emision/proximamente, dups EN colapsados al ES). Mixto igual
//              que dorama. Validado in-vivo (comedia: 2/2 fichas con tag).
//   kplay (KDramasPlay)  → /genero/{slug}/ (21/33 términos; sin
//              canales/series/peliculas, dups EN colapsados). SIN
//              paginación real: ?page=2 repite página 1 (verificado
//              romance y comedia) → el branch ignora skip y sirve siempre
//              página 1 (parse filtra a /series/; el archivo mezcla
//              series+peliculas). Validado in-vivo (comedia: 2/2 fichas).
//   dyt      → /genero/{slug}?p=N   (12 géneros, 24 cards/página — 12/12 ok)
//   tud      → /genres/{slug}/page/N/  (10 géneros verificados con cards)
//   pandrama → API /explorar con filters JSON b64: {mainTypes:[2]}, {genres:[id],
//              hasAll} — 20 géneros (fila de la UI, subconjunto curado del
//              sitio; ids vía /api/v1/value-lists/genres). "Adult +18" NO es
//              género (es un toggle {"key":"adult","value":true}) y queda
//              fuera. Ids canónicos: Acción=35, Aventura=11,
//              Acción y aventura=12 (el 12 es "Acción y aventura", NO
//              "Acción"). Validado in-vivo: romance/boys-love/animación
//              devuelven catálogos propios (BL → "Mr. Fanboy", anim →
//              "Violet Evergarden").
//   dflix    → GraphQL paginationDorama(filter:{genreSlug, isTVShow:false},
//              page/limit 24) — LA MISMA query que usa su propia página
//              /generos/{slug}; slugs de listGenres (API). Validado in-vivo
//              con la BD: romance 1658, drama 2451, comedia 1059…
//              western y news existen en la API con count=0 → expuestos
//              por la Opción B (dropdown vacío hoy, se llena solo si
//              upstream etiqueta series).

type GenreSourceName =
  | "dorama"
  | "dsub"
  | "kplay"
  | "dflix"
  | "pandrama"
  | "tudorama"
  | "dyt";

interface GenreEntry {
  /** Label ES que ve el usuario en el dropdown de Stremio. */
  label: string;
  /** Slug de cada fuente que soporta este género. Fuente ausente = no lo
   * soporta (el catálogo consolidado la salta; su propio catálogo no declara
   * ese género). */
  slugs: Partial<Record<GenreSourceName, string>>;
}

// Orden del listado = orden del dropdown (curado: Romance y Comedia primero).
// Los slugs NO son idénticos entre sitios; cada valor fue confirmado contra el
// sitio específico (pandrama: id de su value-list API; DooPlay: término de su
// registry WP REST).
const MASTER_GENRES: GenreEntry[] = [
  { label: "Romance", slugs: 
    { 
      dorama: "romance", 
      dsub: "romance", 
      kplay: "romance", 
      dyt: "romance", 
      pandrama: "2", 
      dflix: "romance", 
    } 
  },
  { label: "Comedia", slugs:
    { 
      dorama: "comedia", 
      dsub: "comedia", 
      kplay: "comedia", 
      dyt: "comedia", 
      tudorama: "comedia", 
      pandrama: "4", 
      dflix: "comedia",
    }
  },
  { label: "Drama", slugs: 
    {
      dorama: "drama", 
      dsub: "drama", 
      kplay: "drama",
      dyt: "drama", 
      tudorama: "drama", 
      pandrama: "3", 
      dflix: "drama",
    } 
  },
  { label: "Acción", slugs: 
    {
      dorama: "accion", 
      dsub: "accion", 
      kplay: "accion",
      dyt: "accion", 
      tudorama: "accion", 
      pandrama: "35", 
      dflix: "accion",
    } 
  },
  { label: "Acción y aventura", slugs: 
    {
      dorama: "action-adventure",
      dsub: "action-adventure", 
      kplay: "action-adventure",
      pandrama: "12",
    } 
  },
  { label: "Aventura", slugs: 
    {
      dorama: "aventura", 
      dsub: "aventura", 
      kplay: "aventura",
      tudorama: "adventure", 
      pandrama: "11", 
      dflix: "aventura",
    } 
  },
  { label: "Misterio", slugs: 
    {
      dorama: "misterio", 
      dsub: "misterio", 
      kplay: "misterio",
      dyt: "misterio", 
      tudorama: "misterio",
      pandrama: "8", 
      dflix: "misterio",
    } 
  },
  { label: "Suspense", slugs: 
    {
      dorama: "suspense", 
      dsub: "suspense", 
      kplay: "suspense",
      pandrama: "16",
    } 
  },
  { label: "Thriller", slugs: 
    {
      dsub: "thriller", 
      kplay: "thriller",
      dflix: "thriller",
    } 
  },
  { label: "Crimen", slugs: 
    {
      dorama: "crimen", 
      dsub: "crimen", 
      kplay: "crimen",
      tudorama: "crimen", 
      pandrama: "13", 
      dflix: "crimen",
    } 
  },
  { label: "Terror", slugs: 
    {
      pandrama: "9", 
      dflix: "terror",
    } 
  },
  { label: "Horror", slugs: 
    { 
      dsub: "horror" 
    } 
  },
  { label: "Fantasía", slugs: 
    {
      dorama: "fantasia", 
      dsub: "fantasia", 
      kplay: "fantasy",
      dyt: "fantasia", 
      pandrama: "28", 
      dflix: "fantasia",
    } 
  },
  { label: "Ciencia ficción", slugs: 
    {
      dorama: "ciencia-ficcion", 
      dsub: "ciencia-ficcion", 
      kplay: "ciencia-ficcion",
      pandrama: "10", 
      dflix: "ciencia-ficcion",
    } 
  },
  { label: "Sci-Fi y fantasía", slugs: 
    {
      dorama: "sci-fi-fantasy",
      dsub: "sci-fi-fantasy",
      kplay: "sci-fi-fantasy",
      pandrama: "5",
    } 
  },
  { label: "Histórico", slugs: 
    {
      dorama: "historia", 
      dsub: "historia", 
      kplay: "historia",
      dyt: "historico", 
      dflix: "history",
    } 
  },
  { label: "Escolar", slugs: 
    { 
      dyt: "escolar"
    } 
  },
  { label: "Melodrama", slugs: 
    {
      dorama: "soap", 
      dsub: "soap",
      pandrama: "56", 
      dflix: "soap",
    } 
  },
  { label: "Guerra y política", slugs: 
    {
      dorama: "war-politics",
      dsub: "war-politics",
      kplay: "war-politics",
      pandrama: "7",
      dflix: "politica",
    }
  },
  { label: "Bélica", slugs:
    {
      dorama: "belica",
      dsub: "belica",
      dflix: "war",
    }
  },
  { label: "Western", slugs: 
    {
      dorama: "western",
      dflix: "western",
    } 
  },
  { label: "Noticias", slugs: 
    { 
    dflix: "news" 
    } 
  },
  { label: "Familia", slugs: 
    { 
      dorama: "familia", 
      dsub: "familia", 
      kplay: "familia",
      tudorama: "familia",
      pandrama: "6",
      dflix: "familia",
    }
  },
  { label: "Música", slugs: 
    {
      dorama: "musica", 
      dsub: "musica", 
      kplay: "music",
      pandrama: "14",
      dflix: "music",
    }
  },
  { label: "Documental", slugs: 
    {
      dorama: "documental", 
      dsub: "documental", 
      kplay: "documental",
      dflix: "documental",
    } 
  },
  { label: "Reality", slugs: 
    {
      dorama: "reality", 
      dsub: "reality", 
      kplay: "reality",
      tudorama: "reality", 
      dflix: "reality",
    } 
  },
  { label: "Talk", slugs: 
    { dsub: "talk" } 
  },
  { label: "Infantil", slugs: 
    {
      kplay: "kids",
      dflix: "kids",
    } 
  },
  { label: "Animación", slugs: 
    {
      dorama: "animacion", 
      dsub: "animacion",
      kplay: "animacion",
      pandrama: "33", 
      dflix: "animacion",
    } 
  },
  { label: "Negocios", slugs: 
    { 
      tudorama: "negocios" 
    }
  },
  { label: "Doramas cortos", slugs: 
    { 
      dorama: "dramas-cortos"
    }
  },
  { label: "Duanju", slugs: 
    { 
      dorama: "duanju"
    } 
  },
  { label: "Girls Love", slugs: 
    { 
      pandrama: "48"
    } 
  },
  { label: "Boys Love", slugs: 
    {
      dorama: "dramas-lgtb",
      pandrama: "1",
    } 
  },
  { label: "K-Drama", slugs: 
    { 
      dyt: "k-drama"
    } 
  },
  { label: "C-Drama", slugs: 
    { 
      dyt: "c-drama", 
      tudorama: "cdrama" 
    }
  },
  { label: "J-Drama", slugs:
    { 
      dyt: "j-drama"
    }
  },
  { label: "Thai", slugs:
    { 
      dyt: "thai-drama"
    }
  },
];

// Pre-indexed lookup maps for fast O(1) access
const SLUG_BY_SOURCE_LABEL = new Map<string, string>();
const LABEL_BY_SOURCE_SLUG = new Map<string, string>();
const OPTIONS_BY_SOURCE = new Map<string, string[]>();
const MASTER_LABELS = MASTER_GENRES.map((g) => g.label);

for (const g of MASTER_GENRES) {
  for (const [source, slug] of Object.entries(g.slugs)) {
    if (slug) {
      const slugKey = `${source}:${g.label}`;
      if (!SLUG_BY_SOURCE_LABEL.has(slugKey)) {
        SLUG_BY_SOURCE_LABEL.set(slugKey, slug);
      }

      const labelKey = `${source}:${slug}`;
      if (!LABEL_BY_SOURCE_SLUG.has(labelKey)) {
        LABEL_BY_SOURCE_SLUG.set(labelKey, g.label);
      }

      let opts = OPTIONS_BY_SOURCE.get(source);
      if (!opts) {
        opts = [];
        OPTIONS_BY_SOURCE.set(source, opts);
      }
      opts.push(g.label);
    }
  }
}

/** Labels de la lista maestra, en orden (dropdown del consolidado). */
export function masterGenreLabels(): string[] {
  return MASTER_LABELS;
}

/** Labels de la lista maestra que una fuente específica soporta, en orden
 * (dropdown de un catálogo individual). */
export function genreSourceOptions(source: string): string[] {
  return OPTIONS_BY_SOURCE.get(source) || [];
}

/** Slug de un género para una fuente, o undefined si la fuente no lo soporta.
 * Acepta `source` como string sin cast (los names de SOURCES en all.ts). */
export function genreSlug(
  source: string,
  label: string
): string | undefined {
  return SLUG_BY_SOURCE_LABEL.get(`${source}:${label}`);
}

/** Búsqueda inversa (slug → label) para el meta de una ficha: label canónico
 * de la lista maestra si el slug está registrado para esa fuente; si no, el
 * texto que pinta el propio sitio tal cual (decisión del usuario: los
 * géneros no registrados se muestran tal cual — p. ej. kplay "comedy" →
 * "Comedy"); último recurso, el slug humanizado ("war-politics" → "War
 * politics"). Acepta `source` como string sin cast (prefijos de id). */
export function genreLabelForMeta(
  source: string,
  slug: string,
  siteText?: string
): string {
  return (
    LABEL_BY_SOURCE_SLUG.get(`${source}:${slug}`) ||
    (siteText || "").trim() ||
    slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}
