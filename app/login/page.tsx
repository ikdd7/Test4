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
      setErr("비밀번호가 올바르지 않습니다.");
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
