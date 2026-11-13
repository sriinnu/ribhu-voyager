import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  type ApprovalsMode,
  type JsonObject,
  type ToolContext,
  type ToolResult,
  type ToolRunner,
  type ToolSpec,
} from "@ribhu-voyager/engine";

import {
  runDockerFileOp,
  runDockerShell,
  type DockerFileRequest,
  type DockerSandboxOptions,
} from "./sandbox.js";

export type ToolRunnerOptions = {
  sandbox?: "local" | "docker";
  image?: string;
  network?: string;
  dockerPath?: string;
  /** Hard policy gate, or `ask`: expose every tool and let the engine prompt. */
  approvals?: ApprovalsMode;
};

type LocalTool = ToolSpec & {
  execute(
    args: JsonObject,
    context: ToolContext,
  ): Promise<ToolResult>;
};

const MAX_OUTPUT = 64_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function bounded(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

function rawPath(args: JsonObject): string {
  const value = args.path;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  return value;
}

function pathFrom(args: JsonObject, cwd: string): string {
  const value = rawPath(args);
  const root = realpathSync(resolve(cwd));
  const target = resolve(root, value);
  let resolved = target;
  try {
    resolved = realpathSync(target);
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error("symlinks are not allowed for workspace file tools");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = realpathSync(dirname(target));
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new Error("path escapes the workspace");
    }
    resolved = joinReal(parent, target.slice(dirname(target).length));
  }
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("path escapes the workspace");
  }
  return resolved;
}

function joinReal(parent: string, suffix: string): string {
  return resolve(parent, `.${suffix}`);
}

const bash: LocalTool = {
  name: "bash",
  description:
    "Run a shell command in the working directory and return its output. Use this to inspect the repository, run tests, and verify changes.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 120000, max 600000).",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  replaySafe: false,
  async execute(args, context) {
    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("command must be a non-empty string");
    }
    const timeout = Math.min(
      600_000,
      typeof args.timeout === "number" && args.timeout > 0
        ? args.timeout
        : DEFAULT_TIMEOUT_MS,
    );
    return runShell(command, context, timeout);
  },
};

function runShell(
  command: string,
  context: ToolContext,
  timeout: number,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: context.cwd,
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: context.cwd,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: process.env.LANG ?? "C",
        LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? "C",
        TERM: "dumb",
      },
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

    const onAbort = () => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
      finish({
        content: bounded(`${stdout}${stderr}`) || "(aborted)",
        isError: true,
      });
    };

    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
      finish({
        content: bounded(`${stdout}${stderr}\n[timed out after ${timeout}ms]`),
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
      finish({ content: `Failed to start: ${error.message}`, isError: true });
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

/** Turns raw file contents into the numbered read output (shared by both modes). */
function renderRead(raw: string, args: JsonObject): string {
  if (raw.includes("\u0000")) {
    throw new Error("file appears to be binary");
  }
  const lines = raw.split("\n");
  const offset = Math.max(1, typeof args.offset === "number" ? Math.floor(args.offset) : 1);
  const limit = Math.min(
    4000,
    typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : 2000,
  );
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((line, index) => `${String(offset + index).padStart(5, " ")}  ${line}`)
    .join("\n");
  const suffix =
    offset - 1 + slice.length < lines.length
      ? `\n… ${lines.length - (offset - 1 + slice.length)} more lines`
      : "";
  return numbered + suffix;
}

const read: LocalTool = {
  name: "read",
  description:
    "Read a text file. Returns numbered lines. Use offset and limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      offset: { type: "number", description: "First line, 1-based." },
      limit: { type: "number", description: "Maximum lines to return (default 2000, max 4000)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  replaySafe: true,
  async execute(args, context) {
    const path = pathFrom(args, context.cwd);
    const raw = await readFile(path, "utf8");
    return { content: renderRead(raw, args) };
  },
};

const write: LocalTool = {
  name: "write",
  description: "Create or overwrite a file with the given content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  replaySafe: false,
  async execute(args, context) {
    const path = pathFrom(args, context.cwd);
    const content = args.content;
    if (typeof content !== "string") throw new Error("content must be a string");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { content: `Wrote ${content.length} characters to ${path}` };
  },
};

const edit: LocalTool = {
  name: "edit",
  description:
    "Replace one exact occurrence of oldText with newText in a file. Fails if the text is missing or appears more than once.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      oldText: { type: "string", description: "Exact text to replace." },
      newText: { type: "string", description: "Replacement text." },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  replaySafe: false,
  async execute(args, context) {
    const path = pathFrom(args, context.cwd);
    const oldText = args.oldText;
    const newText = args.newText;
    if (typeof oldText !== "string" || oldText === "") {
      throw new Error("oldText must be a non-empty string");
    }
    if (typeof newText !== "string") throw new Error("newText must be a string");
    const raw = await readFile(path, "utf8");
    const first = raw.indexOf(oldText);
    if (first === -1) throw new Error("oldText was not found in the file");
    if (raw.indexOf(oldText, first + oldText.length) !== -1) {
      throw new Error("oldText appears more than once; make the match unique");
    }
    await writeFile(path, raw.slice(0, first) + newText + raw.slice(first + oldText.length), "utf8");
    return { content: `Replaced 1 occurrence in ${path}` };
  },
};

function dockerSandboxOptions(options: ToolRunnerOptions): DockerSandboxOptions {
  return {
    image: options.image ?? "node:24-bookworm",
    ...(options.network ? { network: options.network } : {}),
    ...(options.dockerPath ? { dockerPath: options.dockerPath } : {}),
  };
}

/**
 * read/write/edit variants that execute inside the hardened container. Path
 * containment is enforced container-side by `runDockerFileOp`; the numbered
 * read formatting is shared with local mode so semantics are identical.
 */
function dockerFileTools(options: ToolRunnerOptions): {
  read: LocalTool;
  write: LocalTool;
  edit: LocalTool;
} {
  const sandboxOptions = dockerSandboxOptions(options);
  const run = (request: DockerFileRequest, context: ToolContext) =>
    runDockerFileOp(request, context, DEFAULT_TIMEOUT_MS, sandboxOptions);
  return {
    read: {
      ...read,
      async execute(args, context) {
        const path = rawPath(args);
        const result = await run({ op: "read", path }, context);
        return { content: renderRead(result.content, args) };
      },
    },
    write: {
      ...write,
      async execute(args, context) {
        const path = rawPath(args);
        const content = args.content;
        if (typeof content !== "string") {
          throw new Error("content must be a string");
        }
        const result = await run({ op: "write", path, content }, context);
        return { content: result.content };
      },
    },
    edit: {
      ...edit,
      async execute(args, context) {
        const path = rawPath(args);
        const oldText = args.oldText;
        const newText = args.newText;
        if (typeof oldText !== "string" || oldText === "") {
          throw new Error("oldText must be a non-empty string");
        }
        if (typeof newText !== "string") {
          throw new Error("newText must be a string");
        }
        const result = await run(
          { op: "edit", path, oldText, newText },
          context,
        );
        return { content: result.content };
      },
    },
  };
}

export function createToolRunner(options: ToolRunnerOptions = {}): ToolRunner {
  const docker = options.sandbox === "docker";
  const fileTools = docker
    ? dockerFileTools(options)
    : { read, write, edit };
  const bashTool = docker
    ? {
        ...bash,
        async execute(args: JsonObject, context: ToolContext) {
          const command = args.command;
          if (typeof command !== "string" || command.trim() === "") {
            throw new Error("command must be a non-empty string");
          }
          const timeout = Math.min(
            600_000,
            typeof args.timeout === "number" && args.timeout > 0
              ? args.timeout
              : DEFAULT_TIMEOUT_MS,
          );
          return runDockerShell(
            command,
            context,
            timeout,
            dockerSandboxOptions(options),
          );
        },
      }
    : bash;
  const approvals = options.approvals ?? "allow";
  // `ask` exposes every tool: the engine pauses before bash/write/edit and
  // waits for the journaled decision instead of removing the tool.
  const allowed =
    approvals === "read-only"
      ? [fileTools.read]
      : approvals === "deny-bash"
        ? [fileTools.read, fileTools.write, fileTools.edit]
        : [fileTools.read, fileTools.write, fileTools.edit, bashTool];
  const tools = allowed;
  const implementations = new Map(
    tools.map((tool) => [tool.name, tool] as const),
  );
  return {
    specs: tools,
    async execute(name, args, context) {
      const tool = implementations.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool.execute(args, context);
    },
  };
}
