// The signed-in shell (spec 4.12): the sidebar beside the section on the pale green ground.
import { Sidebar } from "@/components/sidebar";

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
