import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 비밀번호 게이트. 쿠키(fl_auth)가 APP_PASSWORD 기반 토큰과 일치할 때만 통과.
async function authToken(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${password}:${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD || "";
  const salt = process.env.AUTH_SALT || "fire-law";
  const expected = password ? await authToken(password, salt) : "__no_password_set__";
  const cookie = req.cookies.get("fl_auth")?.value;

  if (cookie && cookie === expected) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

// login / api/login / 정적자원은 게이트 제외
export const config = {
  matcher: ["/((?!login|api/login|_next/static|_next/image|favicon.ico).*)"],
};
