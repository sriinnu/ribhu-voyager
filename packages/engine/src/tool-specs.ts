import type { ToolSpec } from "./types.js";

export const toolSpecs: readonly ToolSpec[] = [
  {
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
  },
  {
    name: "read",
    description:
      "Read a text file. Returns numbered lines. Use offset and limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to the working directory.",
        },
        offset: { type: "number", description: "First line, 1-based." },
        limit: {
          type: "number",
          description: "Maximum lines to return (default 2000, max 4000).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    replaySafe: true,
  },
  {
    name: "write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to the working directory.",
        },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    replaySafe: false,
  },
  {
    name: "edit",
    description:
      "Replace one exact occurrence of oldText with newText in a file. Fails if the text is missing or appears more than once.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to the working directory.",
        },
        oldText: { type: "string", description: "Exact text to replace." },
        newText: { type: "string", description: "Replacement text." },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    replaySafe: false,
  },
];
