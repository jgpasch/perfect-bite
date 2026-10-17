/**
 * `recipes.photo_credit` (spec 4.5, 5): who to credit for a household's own photo that came from a
 * stock photo service. Only set with `photo_path`; null = no credit (a library or camera photo).
 */
export type PhotoCredit = {
  provider: 'pexels';
  /** The photographer's name, 1–200 characters. */
  author: string;
  /** The photographer's page, `https://`, at most 2048 characters. */
  authorUrl: string;
  /** The photo's page, `https://`, at most 2048 characters. */
  pageUrl: string;
};
