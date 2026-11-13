import { spawn } from "node:child_process";

import type { ToolContext, ToolResult } from "@ribhu-voyager/engine";

const MAX_OUTPUT = 64_000;

export type DockerSandboxOptions = {
  image: string;
  dockerPath?: string;
  network?: string;
  memory?: string;
  cpus?: string;
};

/** A file operation executed by the container-side Node helper. */
export type DockerFileRequest =
  | { op: "read"; path: string }
  | { op: "write"; path: string; content: string }
  | { op: "edit"; path: string; oldText: string; newText: string };

export type DockerFileResult = {
  /**
   * Raw file contents for `read`; the human-readable summary for
   * `write`/`edit`. Numbered-line formatting stays host-side so Docker and
   * local modes share exactly the same read semantics.
   */
  content: string;
};

function bounded(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars]`;
}

/**
 * Docker `run` flags shared by every sandboxed execution path: the workspace is
 * the only host path mounted, the network is off, the root filesystem is
 * read-only, `/tmp` is a small tmpfs, capabilities are dropped, and the process
 * runs as the host UID so bind-mounted writes stay owned by the user.
 */
function hardenedArgs(
  context: ToolContext,
  options: DockerSandboxOptions,
): string[] {
  const args = [
    "run",
    "--rm",
    "--init",
    "--network",
    options.network ?? "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    options.memory ?? "512m",
    "--cpus",
    options.cpus ?? "1",
    "--pids-limit",
    "256",
    "-e",
    "HOME=/tmp",
    "-v",
    `${context.cwd}:/workspace:rw`,
    "-w",
    "/workspace",
  ];
  const uid = process.getuid?.();
  if (uid !== undefined && uid !== 0) {
    args.push("--user", `${uid}:${process.getgid?.() ?? uid}`);
  }
  return args;
}

/**
 * Container-side file helper. The request arrives as JSON on stdin, so neither
 * paths nor file contents are ever interpolated into a shell command and no
 * temporary host file is needed. Containment is enforced here, inside the
 * container: paths must resolve under `/workspace` and any symlink must stay
 * inside the workspace.
 */
const FILE_OP_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const ROOT = "/workspace";

function send(payload) {
  fs.writeSync(1, JSON.stringify(payload));
  process.exit(0);
}

function fail(message) {
  send({ ok: false, error: String(message) });
}

function insideRoot(candidate, rootReal) {
  return candidate === rootReal || candidate.startsWith(rootReal + path.sep);
}

function resolveInside(input) {
  if (typeof input !== "string" || input.trim() === "") {
    fail("path must be a non-empty string");
  }
  if (path.isAbsolute(input)) {
    fail("path escapes the workspace");
  }
  const rootReal = fs.realpathSync(ROOT);
  const lexical = path.resolve(rootReal, input);
  if (!insideRoot(lexical, rootReal)) {
    fail("path escapes the workspace");
  }
  const relative = path.relative(rootReal, lexical);
  let current = rootReal;
  if (relative !== "") {
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(current);
        } catch {
          fail("symlink escapes the workspace");
        }
        if (!insideRoot(real, rootReal)) {
          fail("symlink escapes the workspace");
        }
        current = real;
      }
    }
  }
  return current;
}

function run(request) {
  if (!request || typeof request !== "object") {
    fail("invalid file operation request");
  }
  const target = resolveInside(request.path);
  if (request.op === "read") {
    send({ ok: true, content: fs.readFileSync(target, "utf8") });
  }
  if (request.op === "write") {
    if (typeof request.content !== "string") {
      fail("content must be a string");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, request.content, "utf8");
    send({
      ok: true,
      content:
        "Wrote " + request.content.length + " characters to " + target,
    });
  }
  if (request.op === "edit") {
    if (typeof request.oldText !== "string" || request.oldText === "") {
      fail("oldText must be a non-empty string");
    }
    if (typeof request.newText !== "string") {
      fail("newText must be a string");
    }
    const raw = fs.readFileSync(target, "utf8");
    const first = raw.indexOf(request.oldText);
    if (first === -1) {
      fail("oldText was not found in the file");
    }
    if (raw.indexOf(request.oldText, first + request.oldText.length) !== -1) {
      fail("oldText appears more than once; make the match unique");
    }
    fs.writeFileSync(
      target,
      raw.slice(0, first) +
        request.newText +
        raw.slice(first + request.oldText.length),
      "utf8",
    );
    send({ ok: true, content: "Replaced 1 occurrence in " + target });
  }
  fail("unsupported file operation");
}

try {
  run(JSON.parse(fs.readFileSync(0, "utf8")));
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
`;

/**
 * Run a command inside a hardened, network-less Docker container. The
 * workspace is the only host path mounted; the container root is read-only and
 * /tmp is a small tmpfs.
 */
export function runDockerShell(
  command: string,
  context: ToolContext,
  timeout: number,
  options: DockerSandboxOptions,
): Promise<ToolResult> {
  const args = [...hardenedArgs(context, options), options.image, "bash", "-lc", command];

  return new Promise((resolvePromise) => {
    const child = spawn(options.dockerPath ?? "docker", args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };

    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
    };

    const onAbort = () => {
      kill();
      finish({
        content: bounded(`${stdout}${stderr}`) || "(aborted)",
        isError: true,
      });
    };

    const timer = setTimeout(() => {
      kill();
      finish({
        content: bounded(
          `${stdout}${stderr}\n[sandbox timed out after ${timeout}ms]`,
        ),
        isError: true,
      });
    }, timeout);

    if (context.signal.aborted) {
      onAbort();
      return;
    }
    context.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk;
        context.output(chunk);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk;
        context.output(chunk);
      }
    });
    child.on("error", (error) => {
      finish({
        content: `Failed to start Docker sandbox: ${error.message}`,
        isError: true,
      });
    });
    child.on("close", (code, signal) => {
      const combined = [stdout, stderr].filter((part) => part !== "").join("\n");
      const suffix =
        signal !== null
          ? `\n[terminated by ${signal}]`
          : code !== 0
            ? `\n[exit code ${code}]`
            : "";
      finish({
        content: bounded(`${combined}${suffix}`) || "(no output)",
        isError: code !== 0 || signal !== null,
      });
    });
  });
}

/**
 * Run one file operation inside the hardened container. The request (including
 * any file contents) travels as stdin JSON to a Node helper; the helper's
 * stdout is a single JSON envelope. The Docker process is abortable through the
 * tool context signal and bounded by `timeout`.
 */
export function runDockerFileOp(
  request: DockerFileRequest,
  context: ToolContext,
  timeout: number,
  options: DockerSandboxOptions,
): Promise<DockerFileResult> {
  const args = [
    ...hardenedArgs(context, options),
    "--interactive",
    options.image,
    "node",
    "-e",
    FILE_OP_SCRIPT,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.dockerPath ?? "docker", args, {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      settle();
    };

    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
    };

    const onAbort = () => {
      kill();
      finish(() => rejectPromise(new Error("docker file operation aborted")));
    };

    const timer = setTimeout(() => {
      kill();
      finish(() =>
        rejectPromise(
          new Error(`docker file operation timed out after ${timeout}ms`),
        ),
      );
    }, timeout);

    if (context.signal.aborted) {
      onAbort();
      return;
    }
    context.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      /* the container went away; close/error settles the promise */
    });
    child.stdin.end(JSON.stringify(request));
    child.on("error", (error) => {
      finish(() =>
        rejectPromise(
          new Error(`Failed to start Docker sandbox: ${error.message}`),
        ),
      );
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (code !== 0 || signal !== null) {
          const detail =
            stderr.trim() ||
            stdout.trim() ||
            (signal !== null ? `terminated by ${signal}` : `exit code ${code}`);
          rejectPromise(new Error(`docker file operation failed: ${detail}`));
          return;
        }
        const text = stdout.trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          rejectPromise(
            new Error(
              `docker file operation returned invalid output: ${bounded(text)}`,
            ),
          );
          return;
        }
        const envelope = parsed as {
          ok?: unknown;
          content?: unknown;
          error?: unknown;
        };
        if (!envelope || envelope.ok !== true) {
          rejectPromise(
            new Error(
              typeof envelope?.error === "string"
                ? envelope.error
                : "docker file operation failed",
            ),
          );
          return;
        }
        if (typeof envelope.content !== "string") {
          rejectPromise(
            new Error("docker file operation returned invalid content"),
          );
          return;
        }
        resolvePromise({ content: envelope.content });
      });
    });
  });
}
