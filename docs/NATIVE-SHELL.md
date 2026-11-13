# Native Shell and OAuth Foundation

Status: **foundation only**. The PWA is the working client; this document and
`apps/mobile/capacitor.config.ts` define the path to store builds. No iOS/Android project has been
generated, and no OAuth provider is wired to a token-exchange endpoint yet.

## Shell

Use Capacitor around the existing React PWA:

```bash
npm install -w @ribhu-voyager/mobile @capacitor/core @capacitor/cli
npx cap add ios
npx cap add android
npm run build
npx cap sync
```

`apps/mobile/capacitor.config.ts` already sets the app id, name, web directory, and Android HTTPS
scheme. iOS still uses `capacitor://localhost` unless you change it.
Keep the PWA as the web build; Capacitor only provides the native container.

## OAuth 2.1 + PKCE

The protocol package now exports:

- `createCodeVerifier()` — 43-char URL-safe verifier
- `codeChallenge(verifier)` — S256 challenge
- `buildAuthorizeUrl({...})` — authorize URL with state and PKCE

Recommended flow:

1. Native app creates verifier + state, stores both in secure storage.
2. Opens the system browser (not an embedded webview) at the authorize URL.
3. Redirect URI uses a custom scheme (`ribhu://oauth/callback`) or universal link.
4. App exchanges the code + verifier at **your backend**, not in the app.
5. Backend verifies the ID token, creates/loads a tenant user, and returns a short-lived
   `RIBBHU_TOKEN` scoped to that tenant.
6. App stores the refresh token in Keychain/Keystore and the access token in memory.

The backend exchange endpoint is **not implemented**. Add it behind your identity provider
(Auth0, WorkOS, Clerk, Keycloak, or your own OIDC).

## Tenant binding

`RIBBHU_TENANT` selects the Postgres tenant for a deployment. `api_tokens` stores only token hashes;
`issueApiToken`/`resolveApiToken` are the primitives for a real token-issuing service. Today the
gateway still uses a single shared `RIBBHU_TOKEN`, so run one tenant per deployment until token →
runtime routing lands.

## Push and background

- APNs/FCM for “answer ready”, “approval needed”, and “run failed”.
- The worker owns execution; the app only needs reconnect + snapshot on resume.
- Approval requests should be push notifications with an in-app approve/deny screen.

## Approvals

Current policy gate:

```bash
RIBBHU_APPROVALS=allow       # default
RIBBHU_APPROVALS=deny-bash   # read/write/edit only
RIBBHU_APPROVALS=read-only   # read only
```

Interactive approvals are the next layer: the worker pauses a risky tool, emits an approval
request, and resumes only after the phone approves.

## Release checklist

- [ ] Identity provider + backend code exchange
- [ ] Tenant-scoped token issuing
- [ ] Keychain/Keystore refresh storage
- [ ] Universal link / custom scheme verification
- [ ] Push certificates and deep links
- [ ] Approval UI and push action
- [ ] App Store / Play Store privacy + data safety
- [ ] E2E on real devices against an HTTPS gateway
