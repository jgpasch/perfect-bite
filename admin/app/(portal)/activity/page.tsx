import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Activity · Back office" };

// Empty until the Activity task (spec 4.12).
export default function ActivityPage() {
  return <PageHeader title="Activity" />;
}
