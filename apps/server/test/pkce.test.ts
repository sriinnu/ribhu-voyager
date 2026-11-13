import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildAuthorizeUrl,
  codeChallenge,
  createCodeVerifier,
} from "@ribhu-voyager/protocol";

test("PKCE verifier/challenge matches S256", { timeout: 20_000 }, async () => {
  const verifier = createCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  assert.equal(await codeChallenge(verifier), expected);
});

test("authorize URL carries PKCE and state", { timeout: 20_000 }, async () => {
  const url = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: "https://auth.example.com/authorize",
      clientId: "ribhu",
      redirectUri: "ribhu://oauth/callback",
      scopes: ["openid", "profile", "offline_access"],
      state: "state-1",
      codeChallenge: "challenge-1",
      extra: { audience: "ribhu-api" },
    }),
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("scope"), "openid profile offline_access");
  assert.equal(url.searchParams.get("audience"), "ribhu-api");
});
