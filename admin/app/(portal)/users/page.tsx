import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Users · Back office" };

// Empty until the Users task (spec 4.12).
export default function UsersPage() {
  return <PageHeader title="Users" />;
}
