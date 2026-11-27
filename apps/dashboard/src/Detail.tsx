import { useEffect, useState } from "react";
import type { Api, RequestDetail } from "./api.ts";
import { CATEGORY_LABEL, FIELD_LABEL, FLAG_LABEL, PRIORITY_LABEL, SEVERE_FLAGS, STATUS_LABEL } from "./labels.ts";

export function Detail({ api, id, version, onChanged }: { api: Api; id: string; version: number; onChanged: () => void }) {
  const [r, setR] = useState<RequestDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"reply" | "trace" | "audit">("reply");

  useEffect(() => {
    let cancelled = false;
    api.get(id).then((d) => {
      if (cancelled) return;
      setR(d);
      // Don't overwrite what the reviewer is typing when a live update arrives.
      if (!dirty) setDraft(d.draftReply ?? "");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id, version]);

  if (!r) return <div className="placeholder muted">Laden…</div>;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDirty(false);
      setR(await api.get(id));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Er ging iets mis");
    } finally {
      setBusy(false);
    }
  };

  const reviewable = r.status === "needs_review";
  const severe = r.riskFlags.filter((f) => SEVERE_FLAGS.has(f));
  const t = r.agentTrace;

  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <h2>{r.subject ?? "(geen onderwerp)"}</h2>
          <div className="muted">
            {r.senderName} {r.senderEmail && <>· {r.senderEmail}</>} · {r.channel} · {new Date(r.receivedAt).toLocaleString("nl-NL")}
          </div>
        </div>
        <div className="tags">
          <span className={`status s-${r.status}`}>{STATUS_LABEL[r.status]}</span>
          {r.category && <span className="tag">{CATEGORY_LABEL[r.category] ?? r.category}</span>}
          {r.priority && <span className={`tag ${r.priority === "urgent" ? "urgent" : ""}`}>{PRIORITY_LABEL[r.priority] ?? r.priority}</span>}
        </div>
      </div>

      {severe.length > 0 && (
        <div className="banner danger">
          <strong>Let op:</strong> {severe.map((f) => FLAG_LABEL[f] ?? f).join(", ")}. Lees het concept goed voordat je het goedkeurt.
        </div>
      )}

      <div className="grid">
        <div className="card">
          <h3>Bericht</h3>
          <pre className="body">{r.body}</pre>
        </div>
        <div className="card">
          <h3>Samenvatting van de agent</h3>
          <p>{r.summary ?? <span className="muted">Nog niet verwerkt.</span>}</p>
          {r.extracted && (
            <dl className="fields">
              {Object.entries(r.extracted)
                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{FIELD_LABEL[k] ?? k}</dt>
                    <dd>{typeof v === "number" ? v.toLocaleString("nl-NL") : v}</dd>
                  </div>
                ))}
            </dl>
          )}
          {r.riskFlags.length > 0 && (
            <div className="tags">
              {r.riskFlags.map((f) => (
                <span key={f} className={`tag ${SEVERE_FLAGS.has(f) ? "danger" : "warn"}`}>
                  ⚑ {FLAG_LABEL[f] ?? f}
                </span>
              ))}
            </div>
          )}
          {r.error && <div className="banner danger">Fout: {r.error}</div>}
        </div>
      </div>

      <div className="tabs">
        {(["reply", "trace", "audit"] as const).map((k) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {k === "reply" ? "Concept-antwoord" : k === "trace" ? `Agent-trace${t ? ` (${t.steps.length})` : ""}` : `Audit (${r.audit.length})`}
          </button>
        ))}
      </div>

      {tab === "reply" && (
        <div className="card">
          <textarea
            value={draft}
            disabled={!reviewable || busy}
            rows={12}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            placeholder={reviewable ? "" : "Geen concept"}
          />
          {error && <div className="error">{error}</div>}
          <div className="actions">
            {reviewable && (
              <>
                <button className="danger-btn" disabled={busy} onClick={() => act(() => api.reject(r.id))}>
                  Afwijzen
                </button>
                <button className="primary" disabled={busy || !draft.trim()} onClick={() => act(() => api.approve(r.id, dirty ? draft : undefined))}>
                  {dirty ? "Aangepast goedkeuren & versturen" : "Goedkeuren & versturen"}
                </button>
              </>
            )}
            {r.status === "failed" && (
              <button className="primary" disabled={busy} onClick={() => act(() => api.retry(r.id))}>
                Opnieuw proberen
              </button>
            )}
            {r.reviewedBy && (
              <span className="muted small">
                Beoordeeld door {r.reviewedBy} op {new Date(r.reviewedAt!).toLocaleString("nl-NL")}
              </span>
            )}
          </div>
        </div>
      )}

      {tab === "trace" && (
        <div className="card">
          {!t ? (
            <span className="muted">Nog geen trace.</span>
          ) : (
            <>
              <div className="muted small trace-meta">
                {t.model} · {(t.durationMs / 1000).toFixed(1)} s · {t.usage.modelCalls} modelcalls · {t.usage.toolCalls} toolcalls · {t.usage.inputTokens + t.usage.outputTokens} tokens
                {t.usage.cacheReadTokens > 0 && <> ({t.usage.cacheReadTokens} uit cache)</>}
                {t.inputSignals && t.inputSignals.length > 0 && <> · input guard: {t.inputSignals.join(", ")}</>}
              </div>
              <ol className="trace">
                {t.steps.map((s, i) =>
                  s.kind === "model" ? (
                    <li key={i} className="model">
                      <span className="who">{t.model === "scripted" ? "Model (scripted)" : "Claude"}</span> {s.text || <span className="muted">(alleen toolcalls)</span>}
                    </li>
                  ) : (
                    <li key={i} className={`tool ${s.isError ? "err" : ""} ${s.denied ? "denied" : ""}`}>
                      <span className="who">{s.denied ? "⛔ geweigerd" : "🔧"} {s.name}</span>
                      <code>{JSON.stringify(s.input)}</code>
                      <details>
                        <summary>resultaat</summary>
                        <pre>{s.output}</pre>
                      </details>
                    </li>
                  ),
                )}
              </ol>
            </>
          )}
        </div>
      )}

      {tab === "audit" && (
        <div className="card">
          <ol className="audit">
            {r.audit.map((a) => (
              <li key={a.id}>
                <span className="muted small">{new Date(a.at).toLocaleTimeString("nl-NL")}</span> <strong>{a.actor}</strong> {a.action}
                {Object.keys(a.details).length > 0 && <code>{JSON.stringify(a.details)}</code>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}
