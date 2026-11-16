import { admitSubmission } from "./admission.js";
import { approvalArgsKey } from "./approval.js";
import {
  DEFAULT_RUN_TOKEN_BUDGET,
  costMicrosForUsage,
  reservationForRun,
  type ModelPricing,
  type RunBudget,
} from "./quota.js";
import { seedConversation } from "./conversation.js";
import { LeaseLost, RunBudgetExceeded } from "./errors.js";
import type {
  Awaitable,
  Storage,
  ToolRunner,
  ToolTaskRow,
  WriteGuard,
} from "./ports.js";
import type {
  ApprovalDecision,
  ApprovalsMode,
  AssistantContent,
  AssistantMessage,
  ConversationView,
  EntryRecord,
  JsonObject,
  ModelMessage,
  ModelRef,
  Provider,
  SubmissionDraft,
  SubmissionInfo,
  ToolContext,
  ToolResult,
  Usage,
} from "./types.js";
import { emptyUsage } from "./types.js";

type ToolSlot = {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
};

type LiveState = {
  run?: { inputs: number[]; turns: number };
  generation?: { attempt: number; message?: AssistantMessage };
  tools?: ToolSlot[];
  runFailure?: { reason: string; detail?: string };
};

/** Tools that pause for interactive approval when `approvals` is `"ask"`. */
const APPROVAL_TOOLS = new Set(["bash", "write", "edit"]);
/** How often a waiting turn re-reads the journal for a decision. */
const APPROVAL_POLL_MS = 300;
/** An unanswered request is treated as denied after this long. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Soft cap for assembled model context; whole turns are dropped to reach it. */
const CONTEXT_CHAR_BUDGET = 360_000;

type ApprovalState = {
  status: "pending" | "approved" | "denied";
  requestedAt?: number;
  /** Present on a pending request: the tool name and its exact arguments. */
  name?: string;
  args?: JsonObject;
  /** Audit flags copied from the decision entry that produced this state. */
  always?: boolean;
  auto?: boolean;
};

type ApprovalOutcome = "approved" | "denied" | "timeout";

/** Journal kind for durable "always allow this exact call" rules. */
const APPROVAL_RULE_KIND = "pi.approval-rule";

function normalizeApprovalDecision(
  decision: ApprovalDecision | boolean,
): ApprovalDecision {
  // boolean is the pre-`always` call style; keep it working for existing callers.
  if (decision === true) return "approve";
  if (decision === false) return "deny";
  return decision;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type EngineOptions = {
  storage: Storage;
  provider: Provider;
  runner: ToolRunner;
  cwd: string;
  model: ModelRef;
  instructions: string;
  maxWindowEntries?: number;
  maxTurns?: number;
  compactionThresholdChars?: number;
  compactionKeepEntries?: number;
  /** Tool policy. `ask` pauses before bash/write/edit for a journaled decision. */
  approvals?: ApprovalsMode;
  /**
   * Per-model pricing. When set, one turn's cost is derived from it unless an
   * explicit `costMicros` function is supplied. Defaults to 0 (unknown).
   */
  pricing?: ModelPricing;
  /**
   * Cost charged for one model turn, in millionths of a currency unit. Wins
   * over `pricing` when both are set; defaults to 0 (unknown).
   */
  costMicros?: (usage: Usage) => number;
  /** Max tokens one run may consume; enforced before every model turn. */
  tokenBudget?: number;
  /** Max cost (micros) one run may spend; enforced before every model turn. */
  costBudgetMicros?: number;
  /** Called once when a new approval request is journaled (push notification hook). */
  onApprovalRequest?: (
    conversationId: number,
    request: { callId: string; name: string; args: JsonObject },
  ) => void | Promise<void>;
  /** Start pending runs on open. Workers set false and run only claimed jobs. */
  autoRun?: boolean;
  recoverOnOpen?: boolean;
  log?: (message: string) => void;
};

type ViewListener = (view: ConversationView, cursor: number) => void;

export class Conversation {
  constructor(
    readonly engine: Engine,
    readonly id: number,
  ) {}

  submit(draft: SubmissionDraft): Promise<SubmissionInfo> {
    return this.engine.submit(this.id, draft);
  }

  compact(): Promise<number | undefined> {
    return this.engine.compact(this.id);
  }

  abort(): Promise<void> {
    return this.engine.abort(this.id);
  }

  /** Approve, deny, or always-allow an `ask`-mode tool call by its call id. */
  decideApproval(callId: string, decision: ApprovalDecision): Promise<boolean> {
    return this.engine.decideApproval(this.id, callId, decision);
  }

  view(): Promise<ConversationView> {
    return this.engine.view(this.id);
  }

  async watch(
    listener: ViewListener,
  ): Promise<() => void> {
    return this.engine.subscribe(this.id, listener);
  }

  waitForIdle(timeoutMs = 60_000): Promise<void> {
    return this.engine.waitForIdle(this.id, timeoutMs);
  }
}

export class Engine {
  private readonly storage: Storage;
  private readonly provider: Provider;
  private readonly runner: ToolRunner;
  private readonly cwd: string;
  private readonly model: ModelRef;
  private readonly instructions: string;
  private readonly maxWindowEntries: number;
  private readonly maxTurns: number;
  private readonly compactionThresholdChars: number;
  private readonly compactionKeepEntries: number;
  private readonly approvals: ApprovalsMode;
  private readonly pricing?: ModelPricing;
  private readonly costMicros: (usage: Usage) => number;
  private readonly tokenBudget: number;
  private readonly costBudgetMicros: number;
  private readonly onApprovalRequest?: EngineOptions["onApprovalRequest"];
  private readonly autoRun: boolean;
  private readonly recoverOnOpen: boolean;
  private readonly log: (message: string) => void;

  private readonly listeners = new Map<number, Set<ViewListener>>();
  private readonly running = new Set<number>();
  private readonly aborts = new Map<number, AbortController>();
  private readonly live = new Map<number, LiveState>();
  private readonly cursors = new Map<number, number>();
  private readonly emitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly lastEmit = new Map<number, number>();
  private readonly leaseLost = new Set<number>();
  /**
   * Active fence guard per conversation while this engine runs a claimed job.
   * Embedded (no-lease) engines leave this empty and stay unguarded.
   */
  private readonly writeGuards = new Map<number, WriteGuard>();
  private readonly pendingEmits = new Set<Promise<void>>();
  private closed = false;

  private constructor(options: EngineOptions) {
    this.storage = options.storage;
    this.provider = options.provider;
    this.runner = options.runner;
    this.cwd = options.cwd;
    this.model = options.model;
    this.instructions = options.instructions;
    this.maxWindowEntries = options.maxWindowEntries ?? 100;
    this.maxTurns = options.maxTurns ?? 24;
    this.compactionThresholdChars = options.compactionThresholdChars ?? 240_000;
    this.compactionKeepEntries = options.compactionKeepEntries ?? 12;
    this.approvals = options.approvals ?? "allow";
    this.pricing = options.pricing;
    this.costMicros =
      options.costMicros ??
      ((usage) => costMicrosForUsage(usage, this.pricing));
    this.tokenBudget =
      options.tokenBudget !== undefined
        ? Math.max(0, Math.trunc(options.tokenBudget))
        : DEFAULT_RUN_TOKEN_BUDGET;
    this.costBudgetMicros =
      options.costBudgetMicros !== undefined
        ? Math.max(0, Math.trunc(options.costBudgetMicros))
        : 0;
    this.onApprovalRequest = options.onApprovalRequest;
    this.autoRun = options.autoRun ?? true;
    this.recoverOnOpen = options.recoverOnOpen ?? true;
    this.log = options.log ?? (() => undefined);
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const engine = new Engine(options);
    const rootId = await engine.storage.ensureRoot();
    await seedConversation(engine.storage, rootId, engine.model);
    await engine.resume();
    return engine;
  }

  async root(): Promise<Conversation> {
    return new Conversation(this, await this.storage.ensureRoot());
  }

  /**
   * Summarize older entries into a `pi.compaction` boundary. The provider
   * stream runs under an abort controller registered in the engine's abort map,
   * so `abortAll()`, `loseLease()`, an explicit `signal`, or worker shutdown all
   * cancel it before a summary is journaled.
   */
  async compact(
    conversationId: number,
    signal?: AbortSignal,
    isLeaseValid?: () => Awaitable<boolean>,
    guard?: WriteGuard,
  ): Promise<number | undefined> {
    return await this.adoptGuard(conversationId, guard, () =>
      this.compactInner(conversationId, signal, isLeaseValid),
    );
  }

  private async compactInner(
    conversationId: number,
    signal?: AbortSignal,
    isLeaseValid?: () => Awaitable<boolean>,
  ): Promise<number | undefined> {
    const existing = this.aborts.get(conversationId);
    const controller = existing ?? new AbortController();
    const owned = !existing;
    if (owned) this.aborts.set(conversationId, controller);
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const effective = controller.signal;
    try {
      if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
      const { entries } = await this.storage.entries(
        conversationId,
        this.maxWindowEntries,
      );
      const keep = Math.min(this.compactionKeepEntries, entries.length - 1);
      if (keep < 1) return undefined;
      const candidate = entries[entries.length - keep - 1];
      if (!candidate) return undefined;
      // A compaction boundary must be a turn boundary. Backing up to the last
      // user entry guarantees the summary never ends inside an
      // assistant/tool-call + tool-result pair.
      let cutoff: EntryRecord | undefined;
      for (const entry of entries) {
        if (entry.id > candidate.id) break;
        if (entry.kind === "pi.user") cutoff = entry;
      }
      if (!cutoff) return undefined;
      const messages: ModelMessage[] = [];
      for (const entry of entries) {
        if (entry.id > cutoff.id) break;
        if (entry.kind === "pi.compaction") continue;
        if (entry.model) messages.push(...entry.model);
      }
      if (messages.length === 0) return undefined;

      let summary = "";
      for await (const event of this.provider.stream({
        model: this.model.modelId,
        system:
          "Summarize this coding-agent conversation for an agent that must continue it. " +
          "Preserve goals, decisions, files changed, commands and test results, open issues, " +
          "and exact identifiers. Be concise but complete.",
        messages,
        tools: [],
        maxTokens: 2048,
        signal: effective,
      })) {
        if (effective.aborted) throw abortError();
        if (event.type === "text") summary += event.text;
      }
      if (effective.aborted) throw abortError();
      summary = summary.trim();
      if (summary === "") return undefined;
      if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();

      const entryId = await this.storage.tx(async () =>
        await this.appendEntry({
          conversationId,
          kind: "pi.compaction",
          data: {
            summary: summary.slice(0, 16_000),
            coversUpTo: cutoff.id,
          },
        }),
      );
      await this.emit(conversationId);
      this.log(
        `compacted conversation=${conversationId} upTo=${cutoff.id} entry=${entryId}`,
      );
      return entryId;
    } finally {
      if (signal) signal.removeEventListener("abort", forwardAbort);
      if (owned && this.aborts.get(conversationId) === controller) {
        this.aborts.delete(conversationId);
      }
    }
  }

  async listConversations() {
    return await this.storage.listConversations();
  }

  async createConversation(title?: string): Promise<Conversation> {
    const id = await this.storage.createConversation(title);
    await seedConversation(this.storage, id, this.model);
    return new Conversation(this, id);
  }

  async forkConversation(
    parentId: number,
    atEntryId?: number,
  ): Promise<Conversation> {
    const id = await this.storage.forkConversation(parentId, atEntryId);
    await seedConversation(this.storage, id, this.model);
    return new Conversation(this, id);
  }

  async renameConversation(id: number, title: string): Promise<void> {
    await this.storage.renameConversation(id, title);
  }

  async conversation(id: number): Promise<Conversation | undefined> {
    return await this.storage.conversationExists(id) ? new Conversation(this, id) : undefined;
  }

  async waitForIdle(conversationId: number, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.running.has(conversationId) && !await this.storage.busy(conversationId)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("timed out waiting for the conversation to become idle");
  }

  abortAll(): void {
    for (const controller of this.aborts.values()) controller.abort();
  }

  loseLease(conversationId: number): void {
    this.leaseLost.add(conversationId);
    this.aborts.get(conversationId)?.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortAll();
    for (const timer of this.emitTimers.values()) clearTimeout(timer);
    this.emitTimers.clear();
    const deadline = Date.now() + 15_000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.allSettled([...this.pendingEmits]);
    await this.storage.close();
  }

  /** Budget this engine reserves against the tenant quota for one run. */
  private runBudget(): RunBudget {
    return {
      tokenBudget: this.tokenBudget,
      costBudgetMicros: this.costBudgetMicros,
    };
  }

  async submit(conversationId: number, draft: SubmissionDraft): Promise<SubmissionInfo> {
    const submission = await admitSubmission(this.storage, conversationId, draft, {
      reservation: reservationForRun(this.runBudget(), this.pricing),
    });
    void this.run(conversationId).catch(() => undefined);
    return submission;
  }

  async abort(conversationId: number): Promise<void> {
    const open = await this.storage.queuedSubmissions(conversationId);
    await this.storage.settleSubmissionIds(
      open.map((row) => row.id),
      "aborted",
    );
    await this.finalizeReservations(
      open.map((row) => row.id),
      "release",
    );
    for (const task of await this.storage.runningToolTasks(conversationId)) {
      await this.storage.finishToolTask(task.id, "Interrupted by user.", "aborted");
    }
    this.aborts.get(conversationId)?.abort();
    const live = this.live.get(conversationId);
    if (live) {
      live.run = undefined;
      live.generation = undefined;
      live.tools = undefined;
    }
    await this.emit(conversationId);
  }

  /**
   * Approve or deny a pending `ask`-mode tool call, or set a durable
   * "always allow" rule for this exact call. Every decision is journaled as an
   * immutable `pi.approval` entry (the newest entry wins); `always` also
   * journals a `pi.approval-rule` entry in the same transaction. Returns false
   * when there is nothing pending.
   */
  async decideApproval(
    conversationId: number,
    callId: string,
    decision: ApprovalDecision | boolean,
  ): Promise<boolean> {
    const normalized = normalizeApprovalDecision(decision);
    if (!(await this.storage.conversationExists(conversationId))) return false;
    const latest = await this.latestApproval(conversationId, callId);
    if (latest?.status !== "pending") return false;
    const decidedAt = Date.now();
    if (normalized === "always") {
      // Rules need the request's tool name and exact arguments. The pending
      // request is the newest entry for this call, so it carries both.
      const name = latest.name;
      const args = latest.args;
      if (typeof name !== "string" || !args) {
        // Defensive: fall back to a plain approval instead of losing the call.
        await this.storage.tx(async () => {
          await this.storage.appendEntry({
            conversationId,
            kind: "pi.approval",
            data: { callId, status: "approved", decidedAt },
          });
        });
        await this.audit(
          "approval.approved",
          `${conversationId}:${callId}`,
          { conversationId, callId, always: true, fallback: true },
          "user",
        );
        this.log(
          `approval approved conversation=${conversationId} call=${callId} (always without request args)`,
        );
        return true;
      }
      const argsKey = approvalArgsKey(args);
      await this.storage.tx(async () => {
        await this.storage.appendEntry({
          conversationId,
          kind: "pi.approval",
          data: { callId, status: "approved", decidedAt, always: true },
        });
        await this.storage.appendEntry({
          conversationId,
          kind: APPROVAL_RULE_KIND,
          data: {
            name,
            argsKey,
            args,
            createdAt: decidedAt,
          },
        });
      });
      await this.audit(
        "approval.always",
        `${conversationId}:${callId}`,
        { conversationId, callId, tool: name, argsKey },
        "user",
      );
      this.log(
        `approval always conversation=${conversationId} call=${callId} tool=${name} rule=${argsKey}`,
      );
      return true;
    }
    await this.storage.tx(async () => {
      await this.storage.appendEntry({
        conversationId,
        kind: "pi.approval",
        data: {
          callId,
          status: normalized === "approve" ? "approved" : "denied",
          decidedAt,
        },
      });
    });
    await this.audit(
      normalized === "approve" ? "approval.approved" : "approval.denied",
      `${conversationId}:${callId}`,
      { conversationId, callId },
      "user",
    );
    this.log(
      `approval ${normalized === "approve" ? "approved" : "denied"} conversation=${conversationId} call=${callId}`,
    );
    return true;
  }

  async view(conversationId: number): Promise<ConversationView> {
    if (!await this.storage.conversationExists(conversationId)) {
      return { conversation: { id: conversationId }, entries: [], docs: {} };
    }
    const view = await this.storage.view(conversationId, this.maxWindowEntries);
    const live = this.live.get(conversationId);
    if (live) {
      const value: JsonObject = {
        ...(live.run
          ? { run: { inputs: live.run.inputs, turns: live.run.turns } }
          : {}),
        ...(live.generation
          ? {
              generation: {
                attempt: live.generation.attempt,
                ...(live.generation.message
                  ? { message: live.generation.message as unknown as JsonObject }
                  : {}),
              },
            }
          : {}),
        ...(live.tools ? { tools: live.tools as unknown as JsonObject } : {}),
        ...(live.runFailure
          ? { runFailure: live.runFailure as unknown as JsonObject }
          : {}),
      };
      view.docs["pi.live"] = value;
    }
    return view;
  }

  async subscribe(
    conversationId: number,
    listener: ViewListener,
  ): Promise<() => void> {
    const set = this.listeners.get(conversationId) ?? new Set<ViewListener>();
    set.add(listener);
    this.listeners.set(conversationId, set);
    listener(await this.view(conversationId), this.cursors.get(conversationId) ?? 0);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(conversationId);
    };
  }

  async resume(): Promise<void> {
    // Finish any tool that was executing when the process died. Workers set
    // recoverOnOpen=false and recover only after claiming the conversation.
    if (this.recoverOnOpen) {
      for (const task of await this.storage.runningToolTasks()) {
        // A pending ask-mode request is a durable wait: the run loop re-enters
        // it with abort/lease checks instead of blocking engine startup here.
        if (this.requiresApproval(task.name)) continue;
        await this.recoverToolTask(task);
      }
    }
    // Restart any conversation with open work. A cancel that arrived while no
    // worker was running is consumed here: the open submissions are settled
    // aborted instead of being resumed.
    const ids = new Set(await this.storage.conversationIdsWithOpenWork());
    for (const id of ids) {
      if (await this.consumeCancelledWork(id)) continue;
      if (this.autoRun) {
        void this.run(id).catch(() => undefined);
      } else {
        await this.storage.enqueueRun(id);
      }
    }
  }

  /**
   * Settle open work whose conversation was stopped while the worker was down.
   * Returns true when a stale cancel flag was consumed.
   */
  private async consumeCancelledWork(conversationId: number): Promise<boolean> {
    if (!(await this.storage.isCancelRequested(conversationId))) return false;
    const open = await this.storage.queuedSubmissions(conversationId);
    await this.storage.settleSubmissionIds(
      open.map((row) => row.id),
      "aborted",
    );
    await this.finalizeReservations(
      open.map((row) => row.id),
      "release",
    );
    for (const task of await this.storage.runningToolTasks(conversationId)) {
      await this.storage.finishToolTask(task.id, "Interrupted by user.", "aborted");
    }
    await this.storage.clearCancel(conversationId);
    await this.emit(conversationId);
    this.log(`consumed cancel conversation=${conversationId}`);
    return true;
  }

  async recoverConversation(
    conversationId: number,
    isLeaseValid?: () => Awaitable<boolean>,
    guard?: WriteGuard,
  ): Promise<void> {
    return await this.adoptGuard(conversationId, guard, () =>
      this.recoverConversationInner(conversationId, isLeaseValid),
    );
  }

  private async recoverConversationInner(
    conversationId: number,
    isLeaseValid?: () => Awaitable<boolean>,
  ): Promise<void> {
    const tasks = await this.storage.runningToolTasks(conversationId);
    if (tasks.length === 0) return;
    // Share the run's abort controller when one exists so stop/close reaches
    // a recovery wait too.
    const owned = !this.aborts.has(conversationId);
    const controller = this.aborts.get(conversationId) ?? new AbortController();
    if (owned) this.aborts.set(conversationId, controller);
    let interrupted: unknown;
    try {
      for (const task of tasks) {
        await this.recoverToolTask(task, controller.signal, isLeaseValid);
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
      interrupted = error;
    } finally {
      if (owned && this.aborts.get(conversationId) === controller) {
        this.aborts.delete(conversationId);
      }
    }
    if (interrupted !== undefined) {
      // A cancel or shutdown interrupted the durable wait: settle it as aborted.
      await this.abort(conversationId).catch(() => undefined);
      throw interrupted;
    }
  }

  private async recoverToolTask(
    task: ToolTaskRow,
    signal?: AbortSignal,
    isLeaseValid?: () => Awaitable<boolean>,
  ): Promise<void> {
    if (await this.storage.hasToolResult(task.conversation_id, task.call_id)) {
      await this.storage.finishToolTask(task.id, "result already journaled", "done", this.guard(task.conversation_id));
      return;
    }

    let args: JsonObject = {};
    try {
      const parsed = JSON.parse(task.args) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as JsonObject;
      }
    } catch {
      /* use empty args */
    }

    const spec = this.runner.specs.find((entry) => entry.name === task.name);
    if (spec && this.requiresApproval(task.name)) {
      // Request and decision are journal entries: re-enter the wait instead of
      // reporting an interruption. Approved -> execute; denied -> tool error.
      const decision = await this.awaitApproval(
        task.conversation_id,
        { id: task.call_id, name: task.name, arguments: args },
        {
          signal: signal ?? new AbortController().signal,
          ...(isLeaseValid ? { isLeaseValid } : {}),
          watchCancel: true,
        },
      );
      if (decision !== "approved") {
        await this.journalApprovalDenial(task, decision);
        await this.emit(task.conversation_id);
        return;
      }
    } else if (!spec || spec.replaySafe === false) {
      await this.storage.tx(async () => {
        await this.appendEntry({
          conversationId: task.conversation_id,
          kind: "pi.tool-result",
          byTaskId: task.id,
          model: [
            {
              role: "toolResult",
              toolCallId: task.call_id,
              toolName: task.name,
              content:
                "Interrupted: the gateway restarted while this tool was running. It was not re-run because it is not replay-safe.",
              isError: true,
              timestamp: Date.now(),
            },
          ],
        });
        await this.storage.finishToolTask(task.id, "interrupted", "aborted", this.guard(task.conversation_id));
      });
      await this.emit(task.conversation_id);
      return;
    }

    if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
    this.log(
      `resuming ${this.requiresApproval(task.name) ? "approved" : "replay-safe"} tool ${task.name}`,
    );
    const controller = new AbortController();
    const executionSignal = signal ?? controller.signal;
    try {
      const result = await this.runner.execute(task.name, args, {
        cwd: this.cwd,
        signal: executionSignal,
        output: () => undefined,
        taskId: task.id,
      });
      await this.storage.tx(async () => {
        await this.appendEntry({
          conversationId: task.conversation_id,
          kind: "pi.tool-result",
          byTaskId: task.id,
          model: [
            {
              role: "toolResult",
              toolCallId: task.call_id,
              toolName: task.name,
              content: result.content,
              isError: result.isError === true,
              timestamp: Date.now(),
            },
          ],
        });
        await this.storage.finishToolTask(task.id, result.content, result.isError ? "failed" : "done", this.guard(task.conversation_id));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = executionSignal.aborted;
      await this.storage.tx(async () => {
        await this.appendEntry({
          conversationId: task.conversation_id,
          kind: "pi.tool-result",
          byTaskId: task.id,
          model: [
            {
              role: "toolResult",
              toolCallId: task.call_id,
              toolName: task.name,
              content: aborted
                ? "Interrupted by user."
                : `Interrupted tool failed on resume: ${message}`,
              isError: true,
              timestamp: Date.now(),
            },
          ],
        });
        await this.storage.finishToolTask(
          task.id,
          message,
          aborted ? "aborted" : "failed",
          this.guard(task.conversation_id),
        );
      });
      if (aborted) throw abortError();
    }
    await this.emit(task.conversation_id);
  }

  async run(
    conversationId: number,
    isLeaseValid?: () => Awaitable<boolean>,
    guard?: WriteGuard,
  ): Promise<void> {
    return await this.adoptGuard(conversationId, guard, () =>
      this.runInner(conversationId, isLeaseValid),
    );
  }

  private async runInner(
    conversationId: number,
    isLeaseValid?: () => Awaitable<boolean>,
  ): Promise<void> {
    if (this.closed || this.running.has(conversationId)) return;
    if (!await this.storage.conversationExists(conversationId)) return;

    const initial = await this.storage.queuedSubmissions(conversationId);
    const pendingAtStart = await this.pendingToolCalls(conversationId);
    if (initial.length === 0 && pendingAtStart.length === 0) return;

    this.running.add(conversationId);
    // Stale cancel flags are cleared at admission; a flag set after the
    // submission was admitted must still stop this run.
    const controller = new AbortController();
    this.aborts.set(conversationId, controller);
    const cancelTimer = setInterval(() => {
      void (async () => {
        try {
          if (await this.storage.isCancelRequested(conversationId)) {
            controller.abort();
          }
        } catch {
          /* storage is closing */
        }
      })();
    }, 200);
    const inputIds = initial.map((row) => row.id);
    // Only a run that was already in flight can reuse a committed final answer.
    // A freshly queued follow-up must call the model even if the previous
    // answer is the last journal entry.
    const resumed = initial.length > 0 && initial.every((row) => row.status === "running");
    const adoptSteering = async () => {
      for (const submission of await this.storage.queuedSubmissions(conversationId)) {
        if (submission.status !== "queued" || submission.when_busy !== "steer") {
          continue;
        }
        if (inputIds.includes(submission.id)) continue;
        await this.storage.updateSubmission(submission.id, "running", {}, this.guard(conversationId));
        inputIds.push(submission.id);
      }
    };
    this.log(`run conversation=${conversationId} inputs=${inputIds.join(",")}`);
    const live: LiveState = { run: { inputs: inputIds, turns: 0 } };
    this.live.set(conversationId, live);
    let failed: string | undefined;
    let settled = false;
    let lostLease = false;
    let compactedThisRun = false;
    let runTokens = 0;
    let runCostMicros = 0;

    try {
      // Mark the inputs running inside the guarded section: a worker that lost
      // its fence before this write is rejected like any other stale commit.
      for (const id of inputIds) {
        await this.storage.updateSubmission(
          id,
          "running",
          {},
          this.guard(conversationId),
        );
      }
      for (let turn = 0; turn < this.maxTurns; turn += 1) {
        if (controller.signal.aborted) break;
        if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
        await adoptSteering();

        if (!compactedThisRun && this.compactionThresholdChars > 0) {
          compactedThisRun = true;
          const context = await this.contextMessages(
            conversationId,
            new Set(inputIds),
          );
          const chars = context.reduce(
            (sum, message) => sum + JSON.stringify(message).length,
            0,
          );
          if (chars > this.compactionThresholdChars) {
            try {
              await this.compact(
                conversationId,
                controller.signal,
                undefined,
                this.guard(conversationId),
              );
            } catch (error) {
              this.log(
                `compaction failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }

        const pending = await this.pendingToolCalls(conversationId);
        if (pending.length > 0) {
          for (const call of pending) {
            if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
            await this.executeTool(
              conversationId,
              call,
              controller.signal,
              live,
              isLeaseValid,
            );
          }
          continue;
        }

        const last = await this.storage.lastEntry(conversationId);
        if (!last || inputIds.length === 0) break;

        // A final answer was committed before the process died; settle it.
        if (
          resumed &&
          last.kind === "pi.assistant" &&
          !this.entryHasToolCalls(last)
        ) {
          await this.storage.settleSubmissionIds(inputIds, "done", { answerEntryId: last.id }, this.guard(conversationId));
          await this.finalizeReservations(inputIds, "commit");
          settled = true;
          break;
        }

        live.run = { inputs: inputIds, turns: turn };
        const messages = await this.contextMessages(conversationId, new Set(inputIds));
        if (
          !messages.some(
            (message) => message.role === "user" || message.role === "toolResult",
          )
        ) {
          break;
        }

        // Per-run budget: checked before every model turn, not only at
        // admission. `maxTokens` is also clamped to the remaining budget.
        const remainingTokens =
          this.tokenBudget > 0 ? this.tokenBudget - runTokens : undefined;
        if (remainingTokens !== undefined && remainingTokens <= 0) {
          throw new RunBudgetExceeded(
            `Run token budget exceeded (${runTokens} of ${this.tokenBudget} tokens).`,
          );
        }
        if (this.costBudgetMicros > 0 && runCostMicros >= this.costBudgetMicros) {
          throw new RunBudgetExceeded(
            `Run cost budget exceeded (${runCostMicros} of ${this.costBudgetMicros} micros).`,
          );
        }
        const assistant = await this.generate(
          conversationId,
          messages,
          controller.signal,
          live,
          remainingTokens,
        );
        const toolCalls = assistant.content.filter(
          (block): block is Extract<AssistantContent, { type: "toolCall" }> =>
            block.type === "toolCall",
        );
        if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
        let entryId = 0;
        await this.storage.tx(async () => {
          entryId = await this.appendEntry({
            conversationId,
            kind: "pi.assistant",
            model: [assistant],
          });
          await this.addUsage(
            conversationId,
            assistant.usage,
            inputIds[0] ?? null,
          );
          // Tool intents are committed with the assistant entry. A crash after
          // this commit leaves a durable task, so an unsafe tool is never
          // silently re-executed from a bare tool-call block.
          for (const call of toolCalls) {
            const spec = this.runner.specs.find((entry) => entry.name === call.name);
            if (!spec) continue;
            await this.storage.createToolTask(
              conversationId,
              call.id,
              call.name,
              call.arguments,
              spec.replaySafe,
              this.guard(conversationId),
            );
          }
        });
        runTokens += assistant.usage.totalTokens;
        runCostMicros += this.costMicros(assistant.usage);
        live.generation = undefined;
        await this.emit(conversationId);

        if (toolCalls.length > 0) {
          for (const call of toolCalls) {
            if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
            await this.executeTool(
              conversationId,
              call,
              controller.signal,
              live,
              isLeaseValid,
            );
          }
          continue;
        }

        if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
        await this.storage.settleSubmissionIds(
          inputIds,
          "done",
          { answerEntryId: entryId },
          this.guard(conversationId),
        );
        await this.finalizeReservations(inputIds, "commit");
        settled = true;
        live.run = undefined;
        break;
      }

      if (!settled && !controller.signal.aborted && !lostLease) {
        const detail = `Stopped after ${this.maxTurns} model turns.`;
        await this.storage.settleSubmissionIds(inputIds, "failed", { error: detail }, this.guard(conversationId));
        await this.finalizeReservations(inputIds, "release");
        live.runFailure = { reason: "turn_limit", detail };
        live.run = undefined;
        live.generation = undefined;
        failed = detail;
      }
    } catch (error) {
      lostLease =
        error instanceof LeaseLost ||
        this.leaseLost.has(conversationId) ||
        (isLeaseValid ? !(await isLeaseValid()) : false);
      if (lostLease) {
        this.log(`lease lost conversation=${conversationId}`);
        live.run = undefined;
        live.generation = undefined;
      } else if (controller.signal.aborted) {
        await this.storage.settleSubmissionIds(inputIds, "aborted", {}, this.guard(conversationId));
        for (const task of await this.storage.runningToolTasks(conversationId)) {
          await this.storage.finishToolTask(task.id, "Interrupted by user.", "aborted", this.guard(conversationId));
        }
        await this.finalizeReservations(inputIds, "release");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        failed = message;
        const open = await this.storage.queuedSubmissions(conversationId);
        await this.storage.settleSubmissionIds(
          open.map((row) => row.id),
          "failed",
          { error: message },
          this.guard(conversationId),
        );
        await this.finalizeReservations(
          [...new Set([...inputIds, ...open.map((row) => row.id)])],
          "release",
        );
        live.runFailure = {
          reason: "model_error",
          detail: message.slice(0, 800),
        };
        live.run = undefined;
        live.generation = undefined;
        this.log(`run failed on conversation ${conversationId}: ${message}`);
      }
    } finally {
      clearInterval(cancelTimer);
      await this.storage.clearCancel(conversationId);
      live.run = undefined;
      live.generation = undefined;
      live.tools = undefined;
      this.log(`run done conversation=${conversationId}${failed ? ` failed=${failed}` : ""}`);
      this.aborts.delete(conversationId);
      this.leaseLost.delete(conversationId);
      await this.emit(conversationId);
      this.running.delete(conversationId);

      if (!this.closed && !lostLease && failed === undefined && !controller.signal.aborted) {
        if ((await this.storage.queuedSubmissions(conversationId)).length > 0) {
          if (this.autoRun) {
        setTimeout(() => {
          void this.run(conversationId).catch(() => undefined);
        }, 0);
      }
          else await this.storage.enqueueRun(conversationId);
        }
      }
    }
  }

  private entryHasToolCalls(entry: EntryRecord): boolean {
    const message = entry.model?.[0];
    return (
      message?.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall")
    );
  }

  private async pendingToolCalls(conversationId: number): Promise<
    Array<{
      id: string;
      name: string;
      arguments: JsonObject;
    }>
  > {
    const last = await this.storage.lastEntry(conversationId);
    if (!last || last.kind === "pi.user") return [];

    const assistant = await this.storage.lastEntryOfKind(conversationId, "pi.assistant");
    if (!assistant) return [];

    const lastUser = await this.storage.lastEntryOfKind(conversationId, "pi.user");
    if (lastUser && lastUser.id > assistant.id) return [];

    const message = assistant.model?.[0];
    if (!message || message.role !== "assistant") return [];

    const calls: Array<{
      id: string;
      name: string;
      arguments: JsonObject;
    }> = [];
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      if (await this.storage.hasToolResult(conversationId, block.id)) continue;
      calls.push({
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      });
    }
    return calls;
  }

  /**
   * Assemble model context as whole turns: `user -> assistant(+toolCalls) ->
   * toolResults`. Turns are dropped from the front to fit the budget, never
   * split; tool results whose tool call is missing are dropped as orphans.
   */
  private async contextMessages(
    conversationId: number,
    activeInputs?: Set<number>,
  ): Promise<ModelMessage[]> {
    // Read a generous tail so a turn is never cut by the raw entry window; the
    // turn/char budget below is what actually bounds the request.
    const fetchLimit = Math.max(this.maxWindowEntries * 8, 800);
    const { entries } = await this.storage.entries(conversationId, fetchLimit);
    const compaction = await this.storage.lastEntryOfKind(conversationId, "pi.compaction");
    const boundary = compaction?.data as { coversUpTo?: unknown } | undefined;
    const coversUpTo =
      typeof boundary?.coversUpTo === "number" ? boundary.coversUpTo : undefined;

    type ContextTurn = {
      submissionId?: number;
      messages: ModelMessage[];
      toolCallIds: Set<string>;
    };
    const turns: ContextTurn[] = [];
    let current: ContextTurn | undefined;

    for (const entry of entries) {
      if (coversUpTo !== undefined && entry.id <= coversUpTo) continue;
      if (entry.kind === "pi.compaction") continue;
      if (entry.kind === "pi.user") {
        const data = entry.data as { submissionId?: unknown } | undefined;
        const submissionId =
          typeof data?.submissionId === "number" ? data.submissionId : undefined;
        current = {
          messages: [],
          toolCallIds: new Set<string>(),
          ...(submissionId !== undefined ? { submissionId } : {}),
        };
        turns.push(current);
        if (entry.model) current.messages.push(...entry.model);
        continue;
      }
      const turn = current;
      if (!turn || !entry.model) continue;
      for (const message of entry.model) {
        if (message.role === "toolResult") {
          // Orphaned result: its assistant tool call is not in this turn.
          if (!turn.toolCallIds.has(message.toolCallId)) continue;
          turn.messages.push(message);
          continue;
        }
        if (message.role === "assistant") {
          for (const block of message.content) {
            if (block.type === "toolCall") turn.toolCallIds.add(block.id);
          }
        }
        turn.messages.push(message);
      }
    }

    const included = turns.filter(
      (turn) =>
        !activeInputs ||
        turn.submissionId === undefined ||
        activeInputs.has(turn.submissionId),
    );

    // Trim only whole turns from the front. The newest turn is always kept even
    // when it alone exceeds the budget.
    const charCount = (turn: ContextTurn): number =>
      turn.messages.reduce(
        (sum, message) => sum + JSON.stringify(message).length,
        0,
      );
    let first = 0;
    let total = included.reduce((sum, turn) => sum + charCount(turn), 0);
    while (first < included.length - 1 && total > CONTEXT_CHAR_BUDGET) {
      total -= charCount(included[first]!);
      first += 1;
    }
    const messages: ModelMessage[] = [];
    for (const turn of included.slice(first)) messages.push(...turn.messages);
    return messages;
  }

  private async systemPrompt(conversationId: number): Promise<string> {
    const base = `${this.instructions}

Working directory: ${this.cwd}
Use the read/write/edit/bash tools. Keep changes small and verify them.`;
    const compaction = await this.storage.lastEntryOfKind(conversationId, "pi.compaction");
    const data = compaction?.data as { summary?: unknown } | undefined;
    return typeof data?.summary === "string" && data.summary !== ""
      ? `${base}

Summary of earlier context:
${data.summary}`
      : base;
  }

  private async generate(
    conversationId: number,
    messages: ModelMessage[],
    signal: AbortSignal,
    live: LiveState,
    remainingTokens?: number,
  ): Promise<AssistantMessage> {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: "pending",
      timestamp: Date.now(),
      usage: emptyUsage(),
    };
    live.generation = { attempt: 1, message: partial };
    this.emitThrottled(conversationId);

    let text = "";
    const toolCalls: Array<{
      id: string;
      name: string;
      arguments: JsonObject;
    }> = [];
    let stopReason: "stop" | "toolUse" | "length" = "stop";
    let usage: Usage = emptyUsage();

    for await (const event of this.provider.stream({
      model: this.model.modelId,
      system: await this.systemPrompt(conversationId),
      messages,
      tools: [...this.runner.specs],
      maxTokens:
        remainingTokens === undefined
          ? 8192
          : Math.min(8192, Math.max(1, remainingTokens)),
      signal,
    })) {
      if (event.type === "text") {
        text += event.text;
        partial.content = [{ type: "text", text }];
        live.generation = { attempt: 1, message: partial };
        this.emitThrottled(conversationId);
      } else if (event.type === "toolCall") {
        toolCalls.push({
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
      } else if (event.type === "done") {
        stopReason = event.stopReason;
        usage = event.usage;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const content: AssistantContent[] = [];
    if (text !== "") content.push({ type: "text", text });
    for (const call of toolCalls) {
      content.push({ type: "toolCall", ...call });
    }
    if (content.length === 0) {
      throw new Error("The model returned an empty response.");
    }

    return {
      role: "assistant",
      content,
      stopReason: toolCalls.length > 0 ? "toolUse" : stopReason,
      timestamp: Date.now(),
      usage,
    };
  }

  private requiresApproval(name: string): boolean {
    return this.approvals === "ask" && APPROVAL_TOOLS.has(name);
  }

  /**
   * Newest `pi.approval` entry for one call id. Scans the tail of the journal
   * and widens the window until it reaches the start or finds the entry, so a
   * long conversation cannot hide a pending request.
   */
  private async latestApproval(
    conversationId: number,
    callId: string,
  ): Promise<ApprovalState | undefined> {
    let limit = 200;
    for (;;) {
      const { entries } = await this.storage.entries(conversationId, limit);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        if (entry.kind !== "pi.approval") continue;
        const data = entry.data as
          | {
              callId?: unknown;
              status?: unknown;
              requestedAt?: unknown;
              name?: unknown;
              args?: unknown;
              always?: unknown;
              auto?: unknown;
            }
          | undefined;
        if (!data || data.callId !== callId) continue;
        if (
          data.status !== "pending" &&
          data.status !== "approved" &&
          data.status !== "denied"
        ) {
          continue;
        }
        return {
          status: data.status,
          ...(typeof data.requestedAt === "number"
            ? { requestedAt: data.requestedAt }
            : {}),
          ...(typeof data.name === "string" ? { name: data.name } : {}),
          ...(isJsonObject(data.args) ? { args: data.args } : {}),
          ...(data.always === true ? { always: true } : {}),
          ...(data.auto === true ? { auto: true } : {}),
        };
      }
      if (entries.length < limit) return undefined;
      limit *= 2;
    }
  }

  /**
   * An existing durable `always allow` rule for this exact tool name and
   * argument object. Rules are append-only conversation journal entries, so
   * they survive restarts and are isolated by the same tenant boundary.
   */
  private async matchingApprovalRule(
    conversationId: number,
    name: string,
    argsKey: string,
  ): Promise<EntryRecord | undefined> {
    let limit = 200;
    for (;;) {
      const { entries } = await this.storage.entries(conversationId, limit);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        if (entry.kind !== APPROVAL_RULE_KIND) continue;
        const data = entry.data as
          | { name?: unknown; argsKey?: unknown }
          | undefined;
        if (!data || data.name !== name || data.argsKey !== argsKey) continue;
        return entry;
      }
      if (entries.length < limit) return undefined;
      limit *= 2;
    }
  }

  /**
   * Durable wait for a decision. The request is journaled once; every poll
   * re-reads the newest status so a worker restart resumes here. Abort and a
   * lost lease win over the approval, and five unanswered minutes are denied.
   */
  private async awaitApproval(
    conversationId: number,
    call: { id: string; name: string; arguments: JsonObject },
    options: {
      signal: AbortSignal;
      isLeaseValid?: () => Awaitable<boolean>;
      watchCancel?: boolean;
    },
  ): Promise<ApprovalOutcome> {
    if (!this.requiresApproval(call.name)) return "approved";
    let requestedAt: number | undefined;
    for (;;) {
      if (this.closed) throw abortError();
      if (options.signal.aborted) throw abortError();
      if (options.isLeaseValid && !(await options.isLeaseValid())) {
        throw new LeaseLost();
      }
      if (
        options.watchCancel &&
        (await this.storage.isCancelRequested(conversationId))
      ) {
        throw abortError();
      }

      const latest = await this.latestApproval(conversationId, call.id);
      if (latest === undefined) {
        // A durable "always allow" rule for exactly these arguments means this
        // call is auto-approved: journal the audit decision and never pause.
        const rule = await this.matchingApprovalRule(
          conversationId,
          call.name,
          approvalArgsKey(call.arguments),
        );
        if (rule) {
          await this.storage.tx(async () => {
            await this.appendEntry({
              conversationId,
              kind: "pi.approval",
              data: {
                callId: call.id,
                status: "approved",
                decidedAt: Date.now(),
                auto: true,
              },
            });
          });
          await this.audit(
            "approval.auto",
            `${conversationId}:${call.id}`,
            {
              conversationId,
              callId: call.id,
              tool: call.name,
              ruleId: rule.id,
            },
          );
          this.log(
            `approval auto-approved conversation=${conversationId} call=${call.id} tool=${call.name} rule=${rule.id}`,
          );
          await this.emit(conversationId);
          return "approved";
        }
        const now = Date.now();
        requestedAt = now;
        await this.storage.tx(async () => {
          await this.appendEntry({
            conversationId,
            kind: "pi.approval",
            data: {
              callId: call.id,
              name: call.name,
              args: call.arguments,
              status: "pending",
              requestedAt: now,
            },
          });
        });
        await this.audit(
          "approval.requested",
          `${conversationId}:${call.id}`,
          {
            conversationId,
            callId: call.id,
            tool: call.name,
            args: call.arguments,
          },
        );
        this.log(
          `approval requested conversation=${conversationId} call=${call.id} tool=${call.name}`,
        );
        await this.emit(conversationId);
        if (this.onApprovalRequest) {
          void (async () => {
            try {
              await this.onApprovalRequest!(conversationId, {
                callId: call.id,
                name: call.name,
                args: call.arguments,
              });
            } catch (error) {
              this.log(
                `approval notification failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          })();
        }
      } else if (latest.status === "approved") {
        return "approved";
      } else if (latest.status === "denied") {
        return "denied";
      } else {
        requestedAt = requestedAt ?? latest.requestedAt ?? Date.now();
        if (Date.now() - requestedAt >= APPROVAL_TIMEOUT_MS) {
          await this.storage.tx(async () => {
            await this.appendEntry({
              conversationId,
              kind: "pi.approval",
              data: {
                callId: call.id,
                status: "denied",
                decidedAt: Date.now(),
              },
            });
          });
          await this.audit(
            "approval.denied",
            `${conversationId}:${call.id}`,
            {
              conversationId,
              callId: call.id,
              tool: call.name,
              reason: "timeout",
            },
          );
          this.log(
            `approval timed out conversation=${conversationId} call=${call.id}`,
          );
          await this.emit(conversationId);
          return "timeout";
        }
      }
      await sleepWithSignal(APPROVAL_POLL_MS, options.signal);
    }
  }

  /** Journal the denial as an ordinary tool error; the task is finished failed. */
  private async journalApprovalDenial(
    task: ToolTaskRow,
    outcome: "denied" | "timeout",
  ): Promise<void> {
    const minutes = Math.round(APPROVAL_TIMEOUT_MS / 60_000);
    const content =
      outcome === "timeout"
        ? `Approval timed out after ${minutes} minutes for tool "${task.name}". The tool was not executed.`
        : `Approval denied for tool "${task.name}". The tool was not executed.`;
    await this.storage.tx(async () => {
      await this.appendEntry({
        conversationId: task.conversation_id,
        kind: "pi.tool-result",
        byTaskId: task.id,
        model: [
          {
            role: "toolResult",
            toolCallId: task.call_id,
            toolName: task.name,
            content,
            isError: true,
            timestamp: Date.now(),
          },
        ],
      });
      await this.storage.finishToolTask(task.id, content, "failed", this.guard(task.conversation_id));
    });
  }

  private async executeTool(
    conversationId: number,
    call: { id: string; name: string; arguments: JsonObject },
    signal: AbortSignal,
    live: LiveState,
    isLeaseValid?: () => Awaitable<boolean>,
  ): Promise<void> {
    if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
    const spec = this.runner.specs.find((entry) => entry.name === call.name);
    if (!spec) {
      await this.storage.tx(async () =>
        await this.appendEntry({
          conversationId,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: `Unknown tool: ${call.name}`,
              isError: true,
              timestamp: Date.now(),
            },
          ],
        }),
      );
      await this.emit(conversationId);
      return;
    }

    if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
    let task = await this.storage.findToolTask(conversationId, call.id);
    if (!task) {
      if (!spec.replaySafe) {
        await this.storage.tx(async () =>
          await this.appendEntry({
            conversationId,
            kind: "pi.tool-result",
            model: [
              {
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content:
                  "Interrupted before the tool ran; not replayed because it is not replay-safe.",
                isError: true,
                timestamp: Date.now(),
              },
            ],
          }),
        );
        await this.emit(conversationId);
        return;
      }
      task = await this.storage.tx(async () =>
        await this.storage.createToolTask(
          conversationId,
          call.id,
          call.name,
          call.arguments,
          spec.replaySafe,
          this.guard(conversationId),
        ),
      );
    }
    if (task.status !== "running") {
      await this.storage.tx(async () =>
        await this.appendEntry({
          conversationId,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: "Tool was interrupted before it completed.",
              isError: true,
              timestamp: Date.now(),
            },
          ],
        }),
      );
      await this.emit(conversationId);
      return;
    }
    const slot: ToolSlot = {
      callId: call.id,
      name: call.name,
      status: "running",
      output: "",
    };
    live.tools = [...(live.tools ?? []), slot];
    await this.emit(conversationId);

    // In ask mode the call is already a durable task; the journaled decision is
    // what lets it run. Denial is an ordinary tool error, so the model continues.
    const decision = await this.awaitApproval(conversationId, call, {
      signal,
      ...(isLeaseValid ? { isLeaseValid } : {}),
    });
    if (decision !== "approved") {
      await this.journalApprovalDenial(task, decision);
      live.tools = (live.tools ?? []).filter((entry) => entry.callId !== call.id);
      await this.emit(conversationId);
      return;
    }

    try {
      const result = await this.runner.execute(call.name, call.arguments, {
        cwd: this.cwd,
        signal,
        taskId: task.id,
        output: (chunk) => {
          slot.output = `${slot.output ?? ""}${chunk}`.slice(-16_000);
          this.emitThrottled(conversationId);
        },
      });
      if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
      slot.status = "done";
      await this.storage.tx(async () => {
        await this.appendEntry({
          conversationId,
          kind: "pi.tool-result",
          byTaskId: task.id,
          model: [
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: result.content,
              isError: result.isError === true,
              timestamp: Date.now(),
            },
          ],
        });
        await this.storage.finishToolTask(
          task.id,
          result.content.slice(0, 16_000),
          result.isError ? "failed" : "done",
          this.guard(conversationId),
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = signal.aborted;
      if (isLeaseValid && !(await isLeaseValid())) throw new LeaseLost();
      slot.status = "done";
      await this.storage.tx(async () => {
        await this.appendEntry({
          conversationId,
          kind: "pi.tool-result",
          byTaskId: task.id,
          model: [
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: aborted ? "Interrupted by user." : message,
              isError: true,
              timestamp: Date.now(),
            },
          ],
        });
        await this.storage.finishToolTask(
          task.id,
          message.slice(0, 16_000),
          aborted ? "aborted" : "failed",
          this.guard(conversationId),
        );
      });
      if (aborted) throw new DOMException("Aborted", "AbortError");
    }
    live.tools = (live.tools ?? []).filter(
      (entry) => entry.callId !== call.id,
    );
    await this.emit(conversationId);
  }

  private guard(conversationId: number): WriteGuard | undefined {
    return this.writeGuards.get(conversationId);
  }

  /** Journal append that carries the active fence guard, when there is one. */
  private async appendEntry(
    entry: Omit<EntryRecord, "id">,
  ): Promise<number> {
    return await this.storage.appendEntry(entry, this.guard(entry.conversationId));
  }

  /** Run `fn` with `guard` installed for this conversation (restores previous). */
  private async adoptGuard<T>(
    conversationId: number,
    guard: WriteGuard | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!guard) return await fn();
    const previous = this.writeGuards.get(conversationId);
    this.writeGuards.set(conversationId, guard);
    try {
      return await fn();
    } finally {
      if (previous) this.writeGuards.set(conversationId, previous);
      else this.writeGuards.delete(conversationId);
    }
  }

  /** Commit or release the quota reservations held by these submissions. */
  private async finalizeReservations(
    submissionIds: number[],
    outcome: "commit" | "release",
  ): Promise<void> {
    for (const submissionId of new Set(submissionIds)) {
      try {
        const reservation = await this.storage.quotaReservationFor(submissionId);
        if (!reservation || reservation.status !== "active") continue;
        if (outcome === "commit") {
          await this.storage.commitQuota(reservation.id);
        } else {
          await this.storage.releaseQuota(reservation.id);
        }
      } catch (error) {
        this.log(
          `quota reservation ${outcome} failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  private async addUsage(
    conversationId: number,
    usage: Usage,
    submissionId?: number | null,
  ): Promise<void> {
    const docs = await this.storage.docs(conversationId);
    const previous = docs["pi.usage"] as
      | { input?: number; output?: number; totalTokens?: number }
      | undefined;
    await this.storage.putDoc(conversationId, "pi.usage", {
      input: (previous?.input ?? 0) + usage.input,
      output: (previous?.output ?? 0) + usage.output,
      totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
    });
    // Durable per-event usage for quotas and the admin dashboard. Cost is
    // configured by the worker; unknown pricing records 0 micros.
    await this.storage.recordUsage({
      conversationId,
      submissionId: submissionId ?? null,
      provider: this.model.provider,
      model: this.model.modelId,
      inputTokens: usage.input,
      outputTokens: usage.output,
      costMicros: Math.max(0, Math.trunc(this.costMicros(usage))),
    });
  }

  /** Best-effort control-plane audit record (tenant scoping lives in storage). */
  private async audit(
    action: string,
    target: string,
    data: JsonObject,
    actor = "engine",
  ): Promise<void> {
    await this.storage.recordAudit({ actor, action, target, data });
  }

  private liveDoc(conversationId: number): JsonObject {
    const live = this.live.get(conversationId);
    if (!live) return {};
    return {
      ...(live.run
        ? { run: { inputs: live.run.inputs, turns: live.run.turns } }
        : {}),
      ...(live.generation
        ? {
            generation: {
              attempt: live.generation.attempt,
              ...(live.generation.message
                ? { message: live.generation.message as unknown as JsonObject }
                : {}),
            },
          }
        : {}),
      ...(live.tools ? { tools: live.tools as unknown as JsonObject } : {}),
      ...(live.runFailure
        ? { runFailure: live.runFailure as unknown as JsonObject }
        : {}),
    };
  }

  private emit(conversationId: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    const task = this.emitNow(conversationId);
    this.pendingEmits.add(task);
    void task
      .catch(() => undefined)
      .finally(() => this.pendingEmits.delete(task));
    return task;
  }

  private async emitNow(conversationId: number): Promise<void> {
    const cursor = (this.cursors.get(conversationId) ?? 0) + 1;
    this.cursors.set(conversationId, cursor);
    await this.storage.putDoc(conversationId, "pi.live", this.liveDoc(conversationId));
    this.lastEmit.set(conversationId, Date.now());

    const set = this.listeners.get(conversationId);
    if (!set || set.size === 0) return;
    const view = await this.view(conversationId);
    for (const listener of set) {
      try {
        listener(view, cursor);
      } catch {
        /* listener failure must not break the run */
      }
    }
  }

  private emitThrottled(conversationId: number): void {
    if (this.closed) return;
    if (this.emitTimers.has(conversationId)) return;
    const elapsed = Date.now() - (this.lastEmit.get(conversationId) ?? 0);
    if (elapsed >= 120) {
      void this.emit(conversationId);
      return;
    }
    const timer = setTimeout(() => {
      this.emitTimers.delete(conversationId);
      void this.emit(conversationId);
    }, 120 - elapsed);
    this.emitTimers.set(conversationId, timer);
  }
}

export type { SubmissionRow, ToolTaskRow } from "./ports.js";
