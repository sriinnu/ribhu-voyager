export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  /** Epoch milliseconds. */
  expires: number;
  subscriptionType?: string;
  scopes?: string[];
};

export type Credential = ApiKeyCredential | OAuthCredential;

export type CredentialInfo = {
  providerId: string;
  type: Credential["type"];
};

export type CredentialOptions = {
  signal?: AbortSignal;
};

export function isOauth(
  credential: Credential | undefined,
): credential is OAuthCredential {
  return credential?.type === "oauth";
}
