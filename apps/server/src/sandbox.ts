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

function bounded(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars]`;
}

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
  args.push(options.image, "bash", "-lc", command);

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
