// ─── Géneros: lista canónica maestra ────────────────────────────────────────
// Un único registro por género con su slug en cada fuente que lo soporta.
// Los slugs NO son portables entre sitios: cada tema (DooPlay, WStream,
// doramasyt) usa su propia taxonomía — por eso el registro guarda un slug
// por fuente, extraído in-vivo (oct. 2026) y validado con cards reales.
//
// Cobertura actual (v1):
//   dyt  → /genero/{slug}?p=N   (12 géneros, 24 cards/página — 12/12 ok)
//   tud  → /genres/{slug}/page/N/  (10 géneros verificados con cards)
//
// Excluidos a propósito (pruebas in-vivo documentadas): sus archivos
// de género listan PELÍCULAS, no series (queda documentado abajo) — fabricar
// el filtro devolvería películas o el directorio entero, no géneros.
//   dorama/dsub → /genero|x/ solo películas; ?genre= sobre /tvshows/ no
//                 filtra (fichas devueltas no llevan el tag pedido)
//   kplay       → /genero/{slug}/ películas fijas, p1=p2=p3 sin paginar
//   dflix/pandrama → fase 2 (dflix: parser SSR /generos/{slug} pendiente;
//   pandrama: clave de filtro de género por confirmar)

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
// Fuente de verdad a la fecha: las palabras clave coinciden con lo que el
// sitio tiene poblado — géneros con archivo 404 o vacío upstream NO van aquí.
export const MASTER_GENRES: GenreEntry[] = [
  { label: "Romance",    slugs: { dyt: "romance" } },
  { label: "Comedia",    slugs: { dyt: "comedia", tudorama: "comedia" } },
  { label: "Drama",      slugs: { dyt: "drama", tudorama: "drama" } },
  { label: "Acción",     slugs: { dyt: "accion", tudorama: "accion" } },
  { label: "Misterio",   slugs: { dyt: "misterio", tudorama: "misterio" } },
  { label: "Fantasía",   slugs: { dyt: "fantasia" } },
  { label: "Histórico",  slugs: { dyt: "historico" } },
  { label: "Escolar",    slugs: { dyt: "escolar" } },
  { label: "Aventura",   slugs: { tudorama: "adventure" } },
  { label: "Crimen",     slugs: { tudorama: "crimen" } },
  { label: "Familia",    slugs: { tudorama: "familia" } },
  { label: "Reality",    slugs: { tudorama: "reality" } },
  { label: "Negocios",   slugs: { tudorama: "negocios" } },
  { label: "K-Drama",    slugs: { dyt: "k-drama" } },
  { label: "C-Drama",    slugs: { dyt: "c-drama", tudorama: "cdrama" } },
  { label: "J-Drama",    slugs: { dyt: "j-drama" } },
  { label: "Thai",       slugs: { dyt: "thai-drama" } },
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
