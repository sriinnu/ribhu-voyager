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
