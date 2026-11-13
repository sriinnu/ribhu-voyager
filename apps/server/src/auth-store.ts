import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  Credential,
  CredentialInfo,
  CredentialOptions,
} from "./credentials.js";

export function defaultAuthFile(): string {
  return (
    process.env.RIBBHU_AUTH_FILE?.trim() ||
    join(homedir(), ".pi", "agent", "auth.json")
  );
}

/**
 * Pi's credential file, supported as an optional Claude login source.
 * This is just a JSON file reader/writer — no Pi packages are involved.
 */
export class PiAuthStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(
    providerId: string,
    options?: CredentialOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const all = await this.load();
    return all[providerId];
  }

  async list(options?: CredentialOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const all = await this.load();
    return Object.entries(all)
      .filter(
        (entry): entry is [string, Credential] =>
          entry[1] !== null &&
          typeof entry[1] === "object" &&
          (entry[1].type === "api_key" || entry[1].type === "oauth"),
      )
      .map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: CredentialOptions,
  ): Promise<Credential | undefined> {
    return this.serialize(async () => {
      options?.signal?.throwIfAborted();
      const all = await this.load();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      all[providerId] = next;
      await this.save(all);
      return next;
    });
  }

  async delete(providerId: string, options?: CredentialOptions): Promise<void> {
    await this.serialize(async () => {
      options?.signal?.throwIfAborted();
      const all = await this.load();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.save(all);
    });
  }

  private async load(): Promise<Record<string, Credential>> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, Credential>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async save(all: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, this.file);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
