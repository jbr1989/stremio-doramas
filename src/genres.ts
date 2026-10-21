// ─── Géneros: lista canónica maestra ────────────────────────────────────────
// Un único registro por género con su slug en cada fuente que lo soporta.
// Los slugs NO son portables entre sitios: cada tema (DooPlay, WStream,
// doramasyt) usa su propia taxonomía — por eso el registro guarda un slug
// por fuente, extraído in-vivo (oct. 2026) y validado con cards reales.
//
// Cobertura actual (v1.4.0):
//   dyt      → /genero/{slug}?p=N   (12 géneros, 24 cards/página — 12/12 ok)
//   tud      → /genres/{slug}/page/N/  (10 géneros verificados con cards)
//   pandrama → API /explorar con filters JSON b64: {mainTypes:[2]}, {genres:[id],
//              hasAll} — 20 géneros (fila de la UI, subconjunto curado del
//              sitio; ids vía /api/v1/value-lists/genres). "Adult +18" NO es
//              género (es un toggle {"key":"adult","value":true}) y queda fuera.
//              Validado in-vivo: romance/boys-love/animación devuelven
//              catálogos propios (BL → "Mr. Fanboy", anim → "Violet Evergarden").
//   dflix    → GraphQL paginationDorama(filter:{genreSlug, isTVShow:false},
//              page/limit 24) — LA MISMA query que usa su propia página
//              /generos/{slug}; slugs listGenres (API). Validado in-vivo con
//              la BD: romance 1658, drama 2451, comedia 1059… western y news
//              están vacíos upstream (count=0) → fuera del dropdown.
//
// Excluidos a propósito (pruebas in-vivo documentadas): sus archivos
// de género listan PELÍCULAS, no series (queda documentado abajo) — fabricar
// el filtro devolvería películas o el directorio entero, no géneros.
//   dorama/dsub → /genero|x/ solo películas; ?genre= sobre /tvshows/ no
//                 filtra (fichas devueltas no llevan el tag pedido)
//   kplay       → /genero/{slug}/ películas fijas, p1=p2=p3 sin paginar
//   (dflix integrado vía GraphQL — ver arriba)

export type GenreSourceName =
  | "dorama"
  | "dsub"
  | "kplay"
  | "dflix"
  | "pandrama"
  | "tudorama"
  | "dyt";

export interface GenreEntry {
  /** Label ES que ve el usuario en el dropdown de Stremio. */
  label: string;
  /** Slug de cada fuente que soporta este género. Fuente ausente = no lo
   * soporta (el catálogo consolidado la salta; su propio catálogo no declara
   * ese género). */
  slugs: Partial<Record<GenreSourceName, string>>;
}

// Orden del listado = orden del dropdown (curado: Romance y Comedia primero).
// Los slugs NO son idénticos entre sitios; cada valor fue confirmado contra el
// sitio específico (pandrama: id de su value-list API).
export const MASTER_GENRES: GenreEntry[] = [
  { label: "Romance",       slugs: { dyt: "romance", pandrama: "2", dflix: "romance" } },
  { label: "Comedia",       slugs: { dyt: "comedia", tudorama: "comedia", pandrama: "4", dflix: "comedia" } },
  { label: "Drama",         slugs: { dyt: "drama", tudorama: "drama", pandrama: "3", dflix: "drama" } },
  { label: "Acción",        slugs: { dyt: "accion", tudorama: "accion", pandrama: "12", dflix: "accion" } },
  { label: "Misterio",      slugs: { dyt: "misterio", tudorama: "misterio", pandrama: "8", dflix: "misterio" } },
  { label: "Suspense",      slugs: { pandrama: "16" } },
  { label: "Thriller",      slugs: { dflix: "thriller" } },
  { label: "Terror",        slugs: { pandrama: "9", dflix: "terror" } },
  { label: "Fantasía",      slugs: { dyt: "fantasia", pandrama: "28", dflix: "fantasia" } },
  { label: "Ciencia ficción", slugs: { pandrama: "10", dflix: "ciencia-ficcion" } },
  { label: "Sci-Fi y fantasía", slugs: { pandrama: "5" } },
  { label: "Histórico",     slugs: { dyt: "historico", dflix: "history" } },
  { label: "Escolar",       slugs: { dyt: "escolar" } },
  { label: "Aventura",      slugs: { tudorama: "adventure", pandrama: "12", dflix: "aventura" } },
  { label: "Acción y aventura", slugs: { pandrama: "12" } },
  { label: "Crimen",        slugs: { tudorama: "crimen", pandrama: "13", dflix: "crimen" } },
  { label: "Familia",       slugs: { tudorama: "familia", pandrama: "6", dflix: "familia" } },
  { label: "Animación",     slugs: { pandrama: "33", dflix: "animacion" } },
  { label: "Bélica",        slugs: { dflix: "war" } },
  { label: "Guerra y política", slugs: { pandrama: "7", dflix: "politica" } },
  { label: "Música",        slugs: { pandrama: "14", dflix: "music" } },
  { label: "Documental",    slugs: { dflix: "documental" } },
  { label: "Reality",       slugs: { tudorama: "reality", dflix: "reality" } },
  { label: "Infantil",      slugs: { dflix: "kids" } },
  { label: "Negocios",      slugs: { tudorama: "negocios" } },
  { label: "Girls Love",    slugs: { pandrama: "48" } },
  { label: "Boys Love",     slugs: { pandrama: "1" } },
  { label: "Melodrama",     slugs: { pandrama: "56", dflix: "soap" } },
  { label: "K-Drama",       slugs: { dyt: "k-drama" } },
  { label: "C-Drama",       slugs: { dyt: "c-drama", tudorama: "cdrama" } },
  { label: "J-Drama",       slugs: { dyt: "j-drama" } },
  { label: "Thai",          slugs: { dyt: "thai-drama" } },
];

/** Labels de la lista maestra, en orden (dropdown del consolidado). */
export function masterGenreLabels(): string[] {
  return MASTER_GENRES.map((g) => g.label);
}

/** Labels de la lista maestra que una fuente específica soporta, en orden
 * (dropdown de un catálogo individual). */
export function genreSourceOptions(source: string): string[] {
  return MASTER_GENRES.filter((g) => genreSlug(source, g.label)).map(
    (g) => g.label
  );
}

/** Slug de un género para una fuente, o undefined si la fuente no lo soporta.
 * Acepta `source` como string sin cast (los names de SOURCES en all.ts). */
export function genreSlug(
  source: string,
  label: string
): string | undefined {
  return MASTER_GENRES.find((g) => g.label === label)?.slugs[
    source as GenreSourceName
  ];
}
