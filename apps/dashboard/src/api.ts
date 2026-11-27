export type Status = "received" | "queued" | "processing" | "needs_review" | "approved" | "rejected" | "sent" | "failed";

export interface RequestSummary {
  id: string;
  channel: string;
  senderName: string;
  senderEmail: string | null;
  subject: string | null;
  preview: string;
  receivedAt: string;
  status: Status;
  category: string | null;
  priority: string | null;
  summary: string | null;
  riskFlags: string[];
}

export interface TraceStep {
  kind: "model" | "tool";
  text?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  denied?: boolean;
  toolCalls?: { name: string; input: unknown }[];
}

export interface RequestDetail extends Omit<RequestSummary, "preview"> {
  body: string;
  extracted: Record<string, string | number | null> | null;
  draftReply: string | null;
  error: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  agentTrace: {
    model: string;
    durationMs: number;
    inputSignals?: string[];
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; modelCalls: number; toolCalls: number };
    steps: TraceStep[];
  } | null;
  audit: { id: number; at: string; actor: string; action: string; details: Record<string, unknown> }[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createApi(key: string) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
    }
    return res.json() as Promise<T>;
  }

  return {
    list: (status?: Status) => call<{ items: RequestSummary[] }>(`/v1/requests?limit=100${status ? `&status=${status}` : ""}`),
    get: (id: string) => call<RequestDetail>(`/v1/requests/${id}`),
    stats: () => call<{ byStatus: Record<string, number> }>("/v1/stats"),
    approve: (id: string, reply?: string) => call(`/v1/requests/${id}/approve`, { method: "POST", body: JSON.stringify(reply ? { reply } : {}) }),
    reject: (id: string, reason?: string) => call(`/v1/requests/${id}/reject`, { method: "POST", body: JSON.stringify(reason ? { reason } : {}) }),
    retry: (id: string) => call(`/v1/requests/${id}/retry`, { method: "POST", body: "{}" }),

    /**
     * Subscribe to live updates. EventSource can't send an Authorization header, so this
     * reads the SSE stream with fetch instead (keeping the key out of URLs and logs).
     */
    subscribe(onEvent: (e: { id: string; status: Status }) => void, onState: (live: boolean) => void): () => void {
      const ctrl = new AbortController();
      (async () => {
        while (!ctrl.signal.aborted) {
          try {
            const res = await fetch("/v1/events", { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal });
            if (!res.ok || !res.body) throw new Error(String(res.status));
            onState(true);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let i: number;
              while ((i = buf.indexOf("\n\n")) >= 0) {
                const chunk = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const data = chunk.split("\n").find((l) => l.startsWith("data: "));
                if (data) onEvent(JSON.parse(data.slice(6)));
              }
            }
          } catch {
            /* fall through to reconnect */
          }
          onState(false);
          if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
        }
      })();
      return () => ctrl.abort();
    },
  };
}
export type Api = ReturnType<typeof createApi>;
