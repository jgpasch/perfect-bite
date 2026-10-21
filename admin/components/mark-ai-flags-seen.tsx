"use client";

import { useEffect } from "react";

import { markAiFlagsSeen } from "@/lib/ai-call-actions";

// Marks the flagged calls seen once the Flagged tab is on screen. On mount, not while rendering,
// so a prefetch of the tab doesn't clear the badge.
export function MarkAiFlagsSeen() {
  useEffect(() => {
    void markAiFlagsSeen();
  }, []);
  return null;
}
