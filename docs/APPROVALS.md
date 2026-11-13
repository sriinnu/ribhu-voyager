# Interactive Approvals

Status: **Phase 10 complete**. The `ask` mode is the interactive layer; the older `deny-bash` and
`read-only` modes remain hard gates.

## Modes

```bash
RIBBHU_APPROVALS=allow       # default; all tools
RIBBHU_APPROVALS=ask         # pause before bash/write/edit
RIBBHU_APPROVALS=deny-bash   # remove bash
RIBBHU_APPROVALS=read-only   # only read
```

## Ask flow

1. The model emits a tool call for `bash`, `write`, or `edit`.
2. The worker creates the durable tool task and journals a `pi.approval` entry:
   ```json
   {
     "callId": "call_...",
     "name": "bash",
     "args": { "command": "npm test" },
     "status": "pending",
     "requestedAt": 1760000000000
   }
   ```
3. The phone shows an approval card with the tool name and argument preview.
4. The user taps **Approve** or **Deny**. The client sends:
   ```json
   { "t": "approval", "conversationId": 1, "callId": "call_...", "decision": "approve" }
   ```
5. The gateway appends a `pi.approval` decision entry:
   ```json
   { "callId": "call_...", "status": "approved", "decidedAt": 1760000000000 }
   ```
6. The worker polls the journal, then executes the tool or journals a normal tool error.

## Durability

The approval is part of the journal, not worker memory. If the worker restarts while a request
is pending, recovery re-enters the wait. The decision is append-only; the newest entry wins.

The worker keeps renewing its lease while waiting. A 5-minute timeout is treated as **denied**.
Aborting the turn while pending must not execute the tool.

## Security

- Approval decisions are accepted only on the authenticated connection and for the attached
  conversation.
- This is a single-user control surface. There is no per-role approver or audit identity yet.
- A pending approval is not a substitute for a sandbox: use `RIBBHU_SANDBOX=docker` for untrusted
  work.

## Limits

- Only `bash`, `write`, and `edit` prompt.
- No remember/always-allow, approval history UI, push notification, or role-based approval.
- The decision is a journal entry; it is not cryptographically signed.
