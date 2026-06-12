"use client";

import { useState } from "react";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    setBusy(false);
    if (res.ok) {
      window.location.href = "/";
    } else {
      const data = await res.json().catch(() => ({}));
      if (data.reason === "no_password_set") {
        setErr("서버에 APP_PASSWORD 환경변수가 설정되지 않았습니다. Vercel 환경변수에 추가한 뒤 Redeploy 하세요.");
      } else {
        setErr("비밀번호가 올바르지 않습니다.");
      }
    }
  }

  return (
    <div className="login">
      <h1>🔥 소방 법령 안내 도구</h1>
      <p>접속 비밀번호를 입력하세요.</p>
      <form onSubmit={submit}>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="비밀번호"
          autoFocus
        />
        <button disabled={busy}>{busy ? "확인 중…" : "입장"}</button>
      </form>
      {err && <div className="err">{err}</div>}
    </div>
  );
}
