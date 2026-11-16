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

/** Admission refused because the tenant's daily token or monthly cost quota is spent. */
export class QuotaExceeded extends Error {
  readonly code = "quota_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceeded";
  }
}
