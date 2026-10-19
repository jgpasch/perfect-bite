// A section's title, in the app's display face.
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="mb-6 flex items-end justify-between gap-4">
      <h1 className="text-[34px] leading-tight text-ink">{title}</h1>
      {children}
    </header>
  );
}
