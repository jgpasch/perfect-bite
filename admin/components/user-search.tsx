"use client";

// The Users search box: typing waits 300 ms, then puts the search in `?q=` (back to page 1).
// The server matches email or name, or the user id exactly when it's pasted in.
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { usersHref } from "@/lib/users";

const DEBOUNCE_MS = 300;

export function UserSearch({ query }: { query: string }) {
  const router = useRouter();
  const [value, setValue] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function onChange(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next.trim() !== query) router.replace(usersHref(next, 1), { scroll: false });
    }, DEBOUNCE_MS);
  }

  return (
    <div className="relative w-full max-w-md">
      <Search
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-tertiary"
      />
      <Input
        type="search"
        aria-label="Search users"
        placeholder="Search by email, name or user id"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 bg-surface pl-9 text-[15px]"
        autoFocus
      />
    </div>
  );
}
