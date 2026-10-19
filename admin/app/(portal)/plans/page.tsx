import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Plans · Back office" };

// Empty until the Plans task (spec 4.12).
export default function PlansPage() {
  return <PageHeader title="Plans" />;
}
