#!/usr/bin/env node
/**
 * Secret-hygiene gate for this repository.
 *
 * Fails when a *tracked* file is signing material (keystores, provisioning
 * profiles, push-service config, a `.secrets/` directory) or when a tracked
 * text file contains an obvious PEM private-key header. Intentional local
 * signing artifacts stay usable on disk because they are gitignored; they
 * must simply never enter git, and this is a public repository.
 *
 * Run locally with: npm run secret:scan
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Files larger than this are not scanned for private-key text. */
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/** Signing/key material that must never be tracked, matched by suffix. */
const FORBIDDEN_EXTENSIONS = [
  ".keystore",
  ".jks",
  ".p12",
  ".mobileprovision",
  ".provisionprofile",
  ".p8",
  ".authkey",
];

/** Credential/config file names that must never be tracked (lowercased). */
const FORBIDDEN_FILENAMES = [
  "keystore.properties",
  "google-services.json",
  "googleservice-info.plist",
];

/**
 * PEM private-key header. The pieces are concatenated so the scanner's own
 * tracked source does not contain a complete header and cannot flag itself.
 */
const PRIVATE_KEY_HEADER = new RegExp(
  "-----BEGIN " + "(?:[A-Z0-9]+ )?" + "PRIVATE KEY-----",
);

function fatal(message) {
  process.stderr.write(`secret scan error: ${message}\n`);
  process.exit(2);
}

function findTrackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z", "--", "."], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter((file) => file !== "");
}

function forbiddenPathReason(file) {
  const segments = file.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.includes(".secrets")) {
    return "tracked .secrets/ signing directory";
  }
  const name = lowerSegments[lowerSegments.length - 1] ?? "";
  if (FORBIDDEN_FILENAMES.includes(name)) {
    return `tracked signing/credential file ${segments[segments.length - 1]}`;
  }
  for (const extension of FORBIDDEN_EXTENSIONS) {
    if (name.endsWith(extension)) {
      return `tracked signing material (*${extension})`;
    }
  }
  return undefined;
}

function privateKeyReason(root, file) {
  let stat;
  try {
    stat = lstatSync(join(root, file));
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
  // Symlinks, directories, and submodules are covered by the path gate (or by
  // gitleaks); only regular files are content-scanned here.
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCANNED_BYTES) {
    return undefined;
  }
  const buffer = readFileSync(join(root, file));
  if (buffer.indexOf(0) !== -1) return undefined; // binary
  const text = buffer.toString("utf8");
  return PRIVATE_KEY_HEADER.test(text) ? "PEM private-key header" : undefined;
}

function main() {
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fatal("not inside a git repository");
    return;
  }
  if (root === "") fatal("could not resolve the git worktree root");

  const tracked = findTrackedFiles(root);
  const findings = [];
  for (const file of tracked) {
    const pathReason = forbiddenPathReason(file);
    if (pathReason) {
      findings.push({ file, reason: pathReason });
      continue;
    }
    const contentReason = privateKeyReason(root, file);
    if (contentReason) findings.push({ file, reason: contentReason });
  }

  if (findings.length > 0) {
    const onActions = process.env.GITHUB_ACTIONS === "true";
    for (const finding of findings) {
      if (onActions) {
        process.stderr.write(
          `::error title=Secret scan::${finding.file}: ${finding.reason}\n`,
        );
      } else {
        process.stderr.write(`  FAIL ${finding.file}: ${finding.reason}\n`);
      }
    }
    process.stderr.write(
      `\nsecret scan FAILED: ${findings.length} finding(s) across ${tracked.length} tracked files.\n` +
        "Signing material and private keys must stay out of git. Rotate any exposed credential; " +
        "removing it from a later commit does not remove it from history or clones.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `secret scan passed: ${tracked.length} tracked files checked; ` +
      "no signing material, .secrets/ paths, or PEM private-key headers found.\n",
  );
}

main();
