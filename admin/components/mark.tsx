// The app's mark, the cloche, in the header gold: a flat drawing of assets/images/splash-cloche.png.
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" fill="var(--gold)">
      <circle cx="16" cy="8.5" r="2.2" />
      <rect x="15" y="10" width="2" height="2.5" rx="0.5" />
      <path d="M5 22a11 10 0 0 1 22 0z" />
      <rect x="2" y="22.5" width="28" height="2.5" rx="1.25" />
    </svg>
  );
}
