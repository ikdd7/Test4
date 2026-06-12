import { NextResponse } from "next/server";

export const runtime = "nodejs";

async function authToken(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${password}:${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: "" }));
  const expected = process.env.APP_PASSWORD || "";

  // APP_PASSWORD 자체가 서버에 설정되지 않은 경우 → 별도 안내
  if (!expected) {
    return NextResponse.json({ ok: false, reason: "no_password_set" }, { status: 401 });
  }
  if (password !== expected) {
    return NextResponse.json({ ok: false, reason: "wrong" }, { status: 401 });
  }

  const token = await authToken(expected, process.env.AUTH_SALT || "fire-law");
  const res = NextResponse.json({ ok: true });
  res.cookies.set("fl_auth", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30일
  });
  return res;
}
