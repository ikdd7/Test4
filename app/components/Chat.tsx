"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type Source = { type: string; title: string; article: string | null; date: string };
type Msg = { role: "user" | "assistant"; content: string; sources?: Source[] };

// 첫 화면 추천 민원(소방)
const SUGGESTIONS: { icon: string; title: string; prompt: string }[] = [
  { icon: "🧯", title: "음식점 소화기 비치 기준", prompt: "음식점을 새로 차리려고 합니다. 소화기는 몇 개를 어디에 비치해야 하나요?" },
  { icon: "🚪", title: "비상구 막으면 과태료", prompt: "비상구를 물건으로 막아두면 과태료가 얼마인가요?" },
  { icon: "🧑‍🚒", title: "소방안전관리자 선임 대상", prompt: "우리 건물도 소방안전관리자를 꼭 선임해야 하나요? 어떤 건물이 대상인가요?" },
  { icon: "🔍", title: "자체점검 횟수", prompt: "소방시설 자체점검은 1년에 몇 번 해야 하나요?" },
];

// 인라인 마크다운: **굵게**, `코드`
function inlineParse(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<strong key={i++}>{m[1]}</strong>);
    else parts.push(<code key={i++}>{m[2]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// 줄 단위: # 제목 → 굵게, * / - 글머리 → •
function renderRich(text: string): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, idx) => {
    const tail = idx < lines.length - 1 ? "\n" : "";
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      return (
        <span key={idx}>
          <strong>{inlineParse(h[2])}</strong>
          {tail}
        </span>
      );
    }
    const bulleted = line.replace(/^(\s*)[*-]\s+/, "$1• ");
    return (
      <span key={idx}>
        {inlineParse(bulleted)}
        {tail}
      </span>
    );
  });
}

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 음성 인식(브라우저 내장 Web Speech API — 키·비용 없음)
  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [micMsg, setMicMsg] = useState("");
  const recogRef = useRef<any>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setMicSupported(!!SR);
  }, []);

  function autoGrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  function micErrorText(code: string): string {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        return "마이크 권한이 거부되었습니다. 주소창의 🔒(자물쇠) → 마이크 ‘허용’ 후 다시 시도하세요.";
      case "no-speech":
        return "음성이 감지되지 않았습니다. 🎤를 다시 눌러 또렷이 말씀해 주세요.";
      case "audio-capture":
        return "마이크를 찾을 수 없습니다. 기기 마이크를 확인하세요.";
      case "network":
        return "음성 인식 서버 연결 오류(네트워크). 잠시 후 다시 시도하세요.";
      default:
        return "음성 인식 오류: " + code;
    }
  }

  function toggleMic() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    setMicMsg("");
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const base = input.trim() ? input.trim() + " " : "";
    rec.onstart = () => {
      setListening(true);
      taRef.current?.focus();
    };
    rec.onresult = (e: any) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(base + txt);
      requestAnimationFrame(autoGrow);
      taRef.current?.focus();
    };
    rec.onerror = (e: any) => {
      setListening(false);
      setMicMsg(micErrorText(e?.error || "unknown"));
    };
    rec.onend = () => setListening(false);
    recogRef.current = rec;
    taRef.current?.focus();
    try {
      rec.start();
    } catch {
      /* 이미 시작된 경우 등 — 무시 */
    }
  }

  function scrollDown() {
    requestAnimationFrame(() => {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    });
  }

  async function send(e?: React.FormEvent, preset?: string) {
    e?.preventDefault();
    const q = (preset ?? input).trim();
    if (!q || busy) return;

    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    setBusy(true);
    scrollDown();

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      setMessages([
        ...next,
        {
          role: "assistant",
          content: data.answer || data.error || "응답을 받지 못했습니다.",
          sources: data.sources,
        },
      ]);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setMessages([...next, { role: "assistant", content: "⏹️ 요청을 중지했습니다." }]);
      } else {
        setMessages([...next, { role: "assistant", content: "네트워크 오류가 발생했습니다." }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      scrollDown();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  // 헤더의 "소방 법령 안내" 클릭 → 첫 화면(웰컴)으로 초기화
  function newChat() {
    abortRef.current?.abort();
    setBusy(false);
    setMessages([]);
    setInput("");
    setMicMsg("");
    if (taRef.current) taRef.current.style.height = "auto";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const empty = messages.length === 0;

  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={newChat} type="button" title="첫 화면으로">
          🚒 소방법령 AI
        </button>
      </header>

      {empty ? (
        <div className="welcome">
          <div className="welcome-logo">🚒</div>
          <h2>무엇을 도와드릴까요?</h2>
          <p>소방시설법·화재예방법을 근거로 AI가 답변해 드립니다.</p>
          <div className="cards">
            {SUGGESTIONS.map((s, i) => (
              <button key={i} className="card" onClick={() => send(undefined, s.prompt)} type="button">
                <div className="card-t">
                  {s.icon} {s.title}
                </div>
                <div className="card-d">{s.prompt}</div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="thread" ref={chatRef}>
          {messages.map((m, i) => (
            <div key={i} className={`row ${m.role}`}>
              {m.role === "assistant" && <div className="avatar">🚒</div>}
              <div className="content">
                {m.role === "assistant" ? renderRich(m.content) : m.content}
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <details className="sources">
                    <summary>검색된 근거 자료 {m.sources.length}건</summary>
                    <ul>
                      {m.sources.map((s, j) => (
                        <li key={j}>
                          [{s.type}] {s.title}
                          {s.article ? ` ${s.article}` : ""} · {s.date}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          ))}

          {busy && (
            <div className="row assistant">
              <div className="avatar">🚒</div>
              <div className="content">
                <div className="typing-wrap" aria-label="검색 중">
                  <div className="typing">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="typing-text">
                    소방 법령을 검색·검증하는 중입니다. 시간이 조금 걸릴 수 있어요.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <form className="composer" onSubmit={send}>
        {micMsg && <div className="mic-msg">{micMsg}</div>}
        <div className="composer-inner">
          <textarea
            ref={taRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            placeholder={
              listening ? "말씀하세요… (음성 인식 중)" : "소방법령 문의사항을 적어주세요."
            }
          />
          {micSupported && (
            <button
              type="button"
              className={`icon-btn mic ${listening ? "on" : ""}`}
              onClick={toggleMic}
              title={listening ? "듣는 중… (눌러서 중지)" : "음성으로 질문하기"}
              aria-label="음성 입력"
            >
              {listening ? "■" : "🎤"}
            </button>
          )}
          {busy ? (
            <button type="button" className="icon-btn stop" onClick={stop} aria-label="응답 중지" title="응답 중지">
              ■
            </button>
          ) : (
            <button type="submit" className="icon-btn send" disabled={!input.trim()} aria-label="전송" title="전송">
              ↑
            </button>
          )}
        </div>
        <div className="composer-hint">
          ※ 법령 정보 안내이며 <b>법률 자문이 아닙니다</b> — 최종 판단은 원문·관할 소방서 확인이 필요합니다.
        </div>
      </form>
    </>
  );
}
