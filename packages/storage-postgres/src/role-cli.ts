import { randomBytes } from "node:crypto";

import { provisionAppRole } from "./role.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const url = flag(args, "--url") ?? process.env.RIBBHU_POSTGRES_URL;
const role = flag(args, "--role") ?? "ribhu_app";
const supplied = flag(args, "--password");
const password = supplied ?? randomBytes(24).toString("hex");
if (!url) {
  console.error(
    "usage: provision --url <admin-postgres-url> [--role ribhu_app] [--password <secret>]\n" +
      "Set RIBBHU_POSTGRES_URL instead of --url.",
  );
  process.exit(2);
}
const result = await provisionAppRole(url, role, password);
console.log(`provisioned ${result.role} on ${result.database}`);
if (!supplied) {
  console.log(`password: ${password}`);
}
