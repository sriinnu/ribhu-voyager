# Security Policy

Ribhu Voyager is a self-hostable coding-agent gateway (server + worker + PWA/native shell).
This repository is **public**. Treat every commit, fork, clone, and CI log as visible to the
world.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main` (0.x) | ✅ security fixes land here |
| older commits/tags | ❌ no backports pre-1.0 |

Run the latest `main` (or the latest release built from it). There is no long-term-support
branch yet.

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

1. Use GitHub's private vulnerability reporting:
   <https://github.com/sriinnu/ribhu-voyager/security/advisories/new>
   (repository **Security** tab → **Advisories** → **Report a vulnerability**).
2. If private reporting is unavailable, open a minimal public issue asking for a private
   channel. Do not include exploit details, tokens, tenant data, or customer information in it.

Please include:

- the affected component (for example `apps/server`, `packages/engine`, sandbox, gateway,
  approval flow, push, native shell) and the commit/version;
- reproduction steps or a proof of concept against a **local** instance;
- impact (auth bypass, tenant isolation, sandbox escape, secret exposure, etc.);
- environment details. Redact real tokens, keystores, tenant IDs, and user data.

What to expect: acknowledgement within 3 business days, then triage, a remediation plan, and
coordinated disclosure after a fix is available. Credit is offered on request.

Only test against instances and data you own or are explicitly authorised to test. Do not
target other people's deployments, tenants, devices, or push endpoints. Good-faith research
that follows this policy will not be pursued.

### In scope

- authentication, token scoping, and tenant isolation (server API, WebSocket gateway, workers);
- tool sandboxing and path containment (Docker sandbox, file tools);
- approval flow and audit journal integrity;
- push endpoint validation and notification payload handling;
- app-shell security headers, Origin checks, rate limiting, and hosted-mode posture;
- native shell token/deep-link handling;
- dependency and supply-chain issues in tracked code.

### Out of scope

- findings that require an already-compromised host, browser, or developer machine;
- local development conveniences that are not the default in a hosted deployment;
- best-practice suggestions without a concrete impact;
- volumetric spam/DoS unless it is trivially repeatable at negligible cost;
- vulnerabilities in third-party services (report those to the provider).

## Secret hygiene in a public repository

**A public repository must never receive signing secrets, keystores, provisioning profiles,
push credentials, or API tokens.** Removing a file in a later commit does not remove it from
git history, forks, caches, or clones; assume anything committed is public forever.

Never commit, paste into an issue, or attach to a PR:

- Android keystores: `*.keystore`, `*.jks`, `keystore.properties`;
- Apple signing material: `*.p12`, `*.mobileprovision`, `*.provisionprofile`, `*.cer`;
- APNs auth keys and similar private keys: `*.p8`, `*.authkey`;
- push-service config: `google-services.json`, `GoogleService-Info.plist`;
- the local `.secrets/` directory, `.env` files, server tokens (`RIBBHU_TOKEN`,
  `RIBBHU_ADMIN_TOKEN`, `RIBBHU_POSTGRES_URL`), provider API keys, and VAPID private keys.

Local development signing material is allowed **on disk only** and is gitignored:

- `.secrets/` (mode `700`; the Android release keystore is mode `600`);
- `apps/mobile/android/keystore.properties` (mode `600`);
- generated native config and build outputs already covered by `.gitignore`.

If a secret is committed or exposed anyway:

1. **Rotate or revoke it first** at the issuer (Play/Apple/Firebase/provider console, token
   store, database). Rotation, not deletion, is the fix.
2. Remove it from the working tree and consider history rewriting — but remember that history
   rewrite does not recall existing clones or forks.
3. Audit for use of the exposed credential and notify affected parties if data was accessed.
4. For the Android app, treat a leaked release keystore as an update-identity incident: a
   compromised keystore cannot safely sign updates to existing installs without Play App
   Signing or a key reset.

Publishing this repository (and GitHub Actions workflows) does **not** publish repository
secrets: GitHub Actions secrets are not readable by the public, but they are only appropriate
for automation if scoped tightly (protected environments, required reviewers, least privilege,
never echoed to logs). No release signing secret is currently configured for CI; native
release signing is performed locally as documented in `docs/NATIVE-SHELL.md`.

## Key handling, backup, and rotation

### Android release keystore

- Location: `.secrets/ribhu-release.keystore` (PKCS12, mode `600`), gitignored.
- Passwords: `apps/mobile/android/keystore.properties`, gitignored, mode `600`, generated
  randomly and never printed or committed.
- Back up the keystore **and** its passwords in a password manager or encrypted offline
  medium, in at least two places. Never store the backup in this repository, in public
  artifact storage, or unencrypted cloud sync.
- This keystore is a local development signing identity, not a Play Console credential.
  Losing it means future updates cannot be signed with the same identity unless Play App
  Signing is configured.

### Apple signing

- Certificates and provisioning profiles stay in Xcode/the Apple developer account.
- Do not commit `.p12` files or profiles. Revoke and reissue via the Apple developer portal
  if exposed.
- Today the iOS app has no distribution certificate or App Store profile (see
  `docs/NATIVE-SHELL.md`); do not fake signing steps or commit material to work around that.

### APNs / FCM / push credentials

- APNs `.p8` auth keys and Firebase/Google service credentials are issued per Apple/Google
  account and environment. Rotate by creating a new key, deploying it, verifying delivery,
  then revoking the old key.
- Restrict service-account roles to the minimum needed for push, and keep one credential set
  per environment.
- Browser Web Push uses VAPID keys; the private key is a server secret and must never be
  committed or shared between environments.

### Server and automation secrets

- Generate tokens with a CSPRNG, one per environment, and never reuse a development token in
  a hosted deployment.
- Keep secrets in the platform secret store or environment, not in tracked files. Never echo
  them in logs, crash reports, screenshots, or issue attachments.
- Rotate on exposure, on suspected compromise, on staff/device changes, and on a regular
  schedule for long-lived credentials.

### Rotation checklist

1. Identify the credential and its scope (which environments, tenants, services).
2. Revoke or reissue at the issuer; prefer revoke-then-reissue over "keep both forever".
3. Update the secret store/environment and redeploy the affected service or app.
4. Invalidate dependent sessions, device tokens, approvals, or push registrations as needed.
5. Verify the old credential is rejected and the new one works.
6. Record what happened (incident notes, audit log) and review access logs for misuse.

## Automated security gates

- `.github/workflows/security.yml` runs on every push/PR to `main`, weekly, and on demand:
  - **gitleaks** over the full commit history;
  - `npm run secret:scan` — fails if a tracked file is signing material, a `.secrets/` path,
    or contains a PEM private-key header;
  - `npm audit --audit-level=high` — fails on high/critical dependency advisories.
- `.github/dependabot.yml` opens weekly npm and GitHub Actions update PRs.
- The server test suite covers authorization/token scope, sandbox containment, approval flow,
  push endpoint validation, and app-shell hardening. Run it before merging security-relevant
  changes.

Local checks:

```bash
npm run secret:scan
npm audit --audit-level=high
# optional: full history scan (requires gitleaks)
gitleaks git --redact --log-opts="--all" .
```

## Dependency and supply-chain expectations

- Commit `package-lock.json`; install with `npm ci` in CI.
- Review dependency and workflow-action bumps before merging, especially major versions and
  packages that run at build time.
- Prefer well-maintained dependencies and remove unused ones rather than adding scanner-only
  exceptions.
- Do not disable a security gate to make a change pass; fix the cause, or open an issue that
  documents the risk and its owner.

## Deployments

Run behind TLS, require a strong API token, keep the hosted-mode posture checks enabled
(Docker sandbox for untrusted code, non-`allow` approvals, strict tenant isolation), and
restrict network exposure. A loopback-only development instance with anonymous access is not
a supported public deployment.
