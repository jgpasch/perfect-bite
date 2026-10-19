// Who gets past the session gate, and how a refused admin call is recognised (spec 4.12).

// Pages anyone may open signed out: the sign-in page and the OAuth callback.
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/")
  );
}

// `private.require_admin()` raises `not authorized` with errcode 42501; PostgREST passes the code on.
export function isNotAuthorized(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "42501";
}
