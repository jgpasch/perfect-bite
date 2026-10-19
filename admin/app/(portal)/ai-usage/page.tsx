import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "AI usage · Back office" };

// Empty until the AI usage task (spec 4.12).
export default function AiUsagePage() {
  return <PageHeader title="AI usage" />;
}
