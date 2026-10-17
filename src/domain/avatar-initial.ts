/**
 * The letter in a round avatar: the first letter or digit of a name or email, upper-cased; "?" when
 * there isn't one.
 */
export function avatarInitial(text: string | null | undefined): string {
  const match = (text ?? '').match(/[\p{L}\p{N}]/u);
  return match ? match[0].toLocaleUpperCase() : '?';
}
