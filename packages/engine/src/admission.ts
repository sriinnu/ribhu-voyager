import { ConversationBusy, QuotaExceeded } from "./errors.js";
import type { Storage } from "./ports.js";
import type { SubmissionDraft, SubmissionInfo } from "./types.js";

/**
 * Legacy check-then-admit quota check. Admission now uses the atomic
 * `Storage.reserveQuota` reservation instead; this helper is kept for callers
 * that only want to read whether a quota is currently exhausted.
 *
 * @deprecated use `Storage.reserveQuota` (atomic) to admit work.
 */
export async function enforceQuota(storage: Storage): Promise<void> {
  const quota = await storage.quota();
  if (quota.dailyTokens === null && quota.monthlyCostMicros === null) return;
  if (quota.dailyTokens !== null) {
    const day = await storage.usageSummary("day");
    if (day.totalTokens >= quota.dailyTokens) {
      throw new QuotaExceeded(
        `Daily token quota exceeded: ${day.totalTokens} of ${quota.dailyTokens} tokens used today.`,
      );
    }
  }
  if (quota.monthlyCostMicros !== null) {
    const month = await storage.usageSummary("month");
    if (month.costMicros >= quota.monthlyCostMicros) {
      throw new QuotaExceeded(
        `Monthly cost quota exceeded: ${month.costMicros} of ${quota.monthlyCostMicros} micros spent this month.`,
      );
    }
  }
}

export type AdmitSubmissionOptions = {
  /**
   * Per-run budget to reserve atomically against the tenant quota. Omitted
   * callers (embedded/no-budget paths) still get the plain admission.
   */
  reservation?: { tokens: number; costMicros: number };
};

/**
 * Durably admit an input and enqueue a run. Shared by the API and the engine.
 * Quota is reserved atomically with the submission row, so two concurrent
 * submissions at the boundary cannot both be admitted.
 */
export async function admitSubmission(
  storage: Storage,
  conversationId: number,
  draft: SubmissionDraft,
  options: AdmitSubmissionOptions = {},
): Promise<SubmissionInfo> {
  const content = draft.content.trim();
  if (content === "") throw new Error("content must be non-empty");
  if (draft.requestId.trim() === "") throw new Error("requestId is required");

  const existing = await storage.findSubmission(conversationId, draft.requestId);
  if (existing) return { id: existing.id, status: existing.status };

  if (draft.whenBusy === "reject" && (await storage.busy(conversationId))) {
    throw new ConversationBusy();
  }

  try {
    const submission = await storage.tx(async () => {
      const duplicate = await storage.findSubmission(
        conversationId,
        draft.requestId,
      );
      if (duplicate) return duplicate;
      // A Stop requested while the conversation was idle (for example while
      // the worker was down) must not poison this freshly admitted submission.
      // Clear it here, at admission, instead of at run start where it could
      // erase a Stop that raced the newly queued run.
      if (!(await storage.busy(conversationId))) {
        await storage.clearCancel(conversationId);
      }
      const row = await storage.createSubmission(
        conversationId,
        draft.requestId,
        content,
        draft.whenBusy ?? "steer",
      );
      if (options.reservation) {
        // Atomic reserve (committed usage + active reservations + this run).
        // Throwing QuotaExceeded rolls back the submission row and the entry.
        await storage.reserveQuota({
          conversationId,
          submissionId: row.id,
          tokens: options.reservation.tokens,
          costMicros: options.reservation.costMicros,
        });
      }
      await storage.appendEntry({
        conversationId,
        kind: "pi.user",
        data: { submissionId: row.id },
        model: [{ role: "user", content, timestamp: Date.now() }],
      });
      await storage.enqueueRun(conversationId);
      return row;
    });
    return { id: submission.id, status: submission.status };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    const message = error instanceof Error ? error.message : "";
    if (code === "23505" || message.includes("UNIQUE constraint failed")) {
      const existing = await storage.findSubmission(
        conversationId,
        draft.requestId,
      );
      if (existing) return { id: existing.id, status: existing.status };
    }
    throw error;
  }
}
