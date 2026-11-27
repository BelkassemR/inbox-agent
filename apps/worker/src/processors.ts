import { audit, getRequest, transitionStatus, type Db, type Logger } from "@inbox/core";
import { triageRequest, type TriageDeps } from "@inbox/agent";
import { UnrecoverableError, type Job } from "@inbox/queue";
import type { DeliveryJob, TriageJob } from "@inbox/queue";
import type { Metrics } from "./metrics.ts";

export function makeTriageProcessor(deps: TriageDeps & { metrics: Metrics }) {
  return async (job: Job<TriageJob>) => {
    const end = deps.metrics.duration.startTimer();
    const outcome = await triageRequest(deps, job.data.requestId);
    end();

    if (outcome.status === "done") {
      const { usage } = outcome.run;
      deps.metrics.jobs.inc({ outcome: "done" });
      deps.metrics.tokens.inc({ kind: "input" }, usage.inputTokens);
      deps.metrics.tokens.inc({ kind: "output" }, usage.outputTokens);
      deps.metrics.tokens.inc({ kind: "cache_read" }, usage.cacheReadTokens);
      deps.metrics.toolCalls.inc(usage.toolCalls);
      for (const f of outcome.request.riskFlags) deps.metrics.flags.inc({ flag: f });
      return { status: "done" };
    }
    if (outcome.status === "skipped") {
      deps.metrics.jobs.inc({ outcome: "skipped" });
      return { status: "skipped", reason: outcome.reason };
    }

    deps.metrics.jobs.inc({ outcome: outcome.retryable ? "retry" : "failed" });
    const attempts = job.opts.attempts ?? 1;
    const lastAttempt = job.attemptsMade + 1 >= attempts;
    if (!outcome.retryable) throw new UnrecoverableError(outcome.error);
    if (lastAttempt) {
      // Out of retries: park it as failed so an operator can retry it from the dashboard.
      await transitionStatus(deps.db, job.data.requestId, ["queued"], "failed", { error: `gave up after ${attempts} attempts: ${outcome.error}` });
      throw new UnrecoverableError(outcome.error);
    }
    // Throwing makes BullMQ retry with exponential backoff.
    throw new Error(outcome.error);
  };
}

/** Sends approved replies. Swap LogMailer for a real provider (Postmark, SES, …). */
export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}
export class LogMailer implements Mailer {
  constructor(private readonly logger?: Logger) {}
  async send(msg: { to: string; subject: string; text: string }) {
    this.logger?.info({ to: msg.to, subject: msg.subject, chars: msg.text.length }, "reply delivered (log mailer)");
  }
}

export function makeDeliveryProcessor(deps: { db: Db; mailer: Mailer; metrics: Metrics; logger?: Logger }) {
  return async (job: Job<DeliveryJob>) => {
    const r = await getRequest(deps.db, job.data.requestId);
    if (!r || r.status !== "approved") return { status: "skipped" };
    // The recipient is always the original sender; the reply text can't redirect it.
    if (r.senderEmail && r.draftReply) {
      await deps.mailer.send({ to: r.senderEmail, subject: `Re: ${r.subject ?? "your message"}`, text: r.draftReply });
    }
    const sent = await transitionStatus(deps.db, r.id, ["approved"], "sent");
    if (sent) await audit(deps.db, { actor: "system", action: "reply.sent", requestId: r.id, details: { channel: r.channel, to: r.senderEmail ? "sender" : "none" } });
    deps.metrics.deliveries.inc({ outcome: "sent" });
    return { status: "sent" };
  };
}
