export class ConversationBusy extends Error {
  constructor() {
    super("The conversation is busy.");
    this.name = "ConversationBusy";
  }
}

export class ConversationIdle extends Error {
  constructor() {
    super("The conversation is idle.");
    this.name = "ConversationIdle";
  }
}

export class LeaseLost extends Error {
  constructor() {
    super("The worker no longer owns this conversation's lease.");
    this.name = "LeaseLost";
  }
}

/**
 * A fenced write was rejected because the worker no longer owns the job at that
 * fence (lease expired or another worker reclaimed it).
 */
export class StaleFence extends LeaseLost {
  constructor() {
    super();
    this.name = "StaleFence";
    this.message = "The worker's lease fence is stale; the write was rejected.";
  }
}

/** Admission refused because the tenant's daily token or monthly cost quota is spent. */
export class QuotaExceeded extends Error {
  readonly code = "quota_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceeded";
  }
}
