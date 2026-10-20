// The signed-in shell (spec 4.12): the sidebar beside the section on the pale green ground, for admins
// only. proxy.ts has already sent anyone signed out to /sign-in; here is_admin() decides the rest.
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { NotAuthorized } from "@/components/not-authorized";
import { Sidebar } from "@/components/sidebar";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized, sessionEmail } from "@/lib/supabase/session";

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Suspense>
      <AdminGate>{children}</AdminGate>
    </Suspense>
  );
}

async function AdminGate({ children }: { children: React.ReactNode }) {
  const email = await sessionEmail();
  if (email === null) redirect("/sign-in");

  const supabase = await createClient();
  const { data: isAdmin, error } = await supabase.rpc("is_admin");
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't check admin access: ${error.message}`);
  if (isAdmin !== true) return <NotAuthorized email={email} />;

  // The badge is a nicety: if the count fails, the portal still opens without it.
  const { data: flaggedCount } = await supabase.rpc("admin_ai_call_flag_count", { p_days: 7 });

  return (
    <div className="flex min-h-screen">
      <Sidebar email={email} flaggedCount={typeof flaggedCount === "number" ? flaggedCount : 0} />
      <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
