import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

// Google sends the admin back here with a code; swapping it for a session sets the cookies.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/users", request.url));
  }
  return NextResponse.redirect(new URL("/sign-in?error=callback", request.url));
}
