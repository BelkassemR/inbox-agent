import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createApi, type RequestSummary, type Status } from "./api.ts";
import { Detail } from "./Detail.tsx";
import { CATEGORY_LABEL, SEVERE_FLAGS, STATUS_LABEL, timeAgo } from "./labels.ts";

const KEY_STORAGE = "inbox-agent.key";
const FILTERS: (Status | "all")[] = ["needs_review", "processing", "failed", "approved", "sent", "rejected", "all"];

function Login({ onLogin }: { onLogin: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await createApi(key).stats();
            onLogin(key);
          } catch (err) {
            setError(err instanceof ApiError && err.status === 401 ? "Ongeldige API-key" : "API niet bereikbaar");
          }
        }}
      >
        <div className="logo">◆ Inbox Agent</div>
        <p className="muted">Log in met je operator API-key.</p>
        <input type="password" autoFocus placeholder="API-key" value={key} onChange={(e) => setKey(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={!key}>
          Inloggen
        </button>
      </form>
    </div>
  );
}

export function App() {
  // sessionStorage: the key is gone when the tab closes, and isn't shared across tabs.
  const [key, setKey] = useState(() => sessionStorage.getItem(KEY_STORAGE));
  if (!key) {
    return (
      <Login
        onLogin={(k) => {
          sessionStorage.setItem(KEY_STORAGE, k);
          setKey(k);
        }}
      />
    );
  }
  return (
    <Inbox
      apiKey={key}
      onLogout={() => {
        sessionStorage.removeItem(KEY_STORAGE);
        setKey(null);
      }}
    />
  );
}

function Inbox({ apiKey, onLogout }: { apiKey: string; onLogout: () => void }) {
  const api = useMemo(() => createApi(apiKey), [apiKey]);
  const [filter, setFilter] = useState<Status | "all">("needs_review");
  const [items, setItems] = useState<RequestSummary[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [version, setVersion] = useState(0); // bumps on live events to refresh the open detail

  const refresh = useCallback(async () => {
    try {
      const [list, stats] = await Promise.all([api.list(filter === "all" ? undefined : filter), api.stats()]);
      setItems(list.items);
      setCounts(stats.byStatus);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
    }
  }, [api, filter, onLogout]);

  useEffect(() => void refresh(), [refresh]);

  // Live updates: coalesce bursts of events into one refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe(
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void refresh();
          setVersion((v) => v + 1);
        }, 300);
      },
      setLive,
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [api, refresh]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="app">
      <header>
        <div className="logo">◆ Inbox Agent</div>
        <div className="header-right">
          <span className={`live ${live ? "on" : ""}`}>{live ? "● Live" : "○ Verbinden…"}</span>
          <button className="ghost" onClick={onLogout}>
            Uitloggen
          </button>
        </div>
      </header>

      <nav className="filters">
        {FILTERS.map((f) => (
          <button key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? "Alles" : STATUS_LABEL[f]}
            <span className="count">{f === "all" ? total : (counts[f] ?? 0)}</span>
          </button>
        ))}
      </nav>

      <main>
        <ul className="list">
          {items.length === 0 && <li className="empty">Niets hier. 🎉</li>}
          {items.map((r) => {
            const severe = r.riskFlags.some((f) => SEVERE_FLAGS.has(f));
            return (
              <li key={r.id} className={`${selected === r.id ? "selected" : ""} ${severe ? "severe" : ""}`} onClick={() => setSelected(r.id)}>
                <div className="row">
                  <strong>{r.senderName}</strong>
                  <span className="muted small">{timeAgo(r.receivedAt)}</span>
                </div>
                <div className="subject">{r.subject ?? r.preview.slice(0, 60)}</div>
                <div className="summary muted small">{r.summary ?? r.preview}</div>
                <div className="tags">
                  <span className={`status s-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                  {r.category && <span className="tag">{CATEGORY_LABEL[r.category] ?? r.category}</span>}
                  {r.priority === "urgent" && <span className="tag urgent">Urgent</span>}
                  {r.riskFlags.length > 0 && <span className={`tag ${severe ? "danger" : "warn"}`}>⚑ {r.riskFlags.length}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <section className="detail-pane">
          {selected ? (
            <Detail key={selected} api={api} id={selected} version={version} onChanged={refresh} />
          ) : (
            <div className="placeholder muted">Selecteer een bericht</div>
          )}
        </section>
      </main>
    </div>
  );
}
