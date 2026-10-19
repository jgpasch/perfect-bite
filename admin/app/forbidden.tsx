import { Suspense } from "react";

import { NotAuthorized } from "@/components/not-authorized";
import { sessionEmail } from "@/lib/supabase/session";

// What forbidIfNotAuthorized shows when an admin call answers 42501.
export default function Forbidden() {
  return (
    <Suspense>
      <SignedInAs />
    </Suspense>
  );
}

async function SignedInAs() {
  return <NotAuthorized email={await sessionEmail()} />;
}
