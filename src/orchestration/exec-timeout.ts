export interface ExecResultLike {
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
}

export interface ExecTimeoutClassification {
  isTimeout: boolean;
  summary: string | null;
  source: "typed" | "signal" | "output" | "none";
}

const TIMEOUT_TEXT_RE = /(etimedout|timed\s*out|\btimeout\b)/i;
const TYPED_TIMEOUT_CODES = new Set(["ETIMEDOUT", "ERR_EXEC_TIMEOUT", "ABORT_ERR"]);
const SIGNAL_TIMEOUTS = new Set(["SIGTERM", "SIGKILL"]);

export function isTimeoutLikeText(text: string): boolean {
  return TIMEOUT_TEXT_RE.test(text);
}

export function classifyExecTimeout(input: {
  error?: unknown;
  result?: ExecResultLike;
}): ExecTimeoutClassification {
  const typed = classifyTypedTimeout(input.error, input.result);
  if (typed) {
    return {
      isTimeout: true,
      summary: typed,
      source: "typed",
    };
  }

  const signal = classifySignalTimeout(input.result);
  if (signal) {
    return {
      isTimeout: true,
      summary: signal,
      source: "signal",
    };
  }

  const output = classifyOutputTimeout(input.result);
  if (output) {
    return {
      isTimeout: true,
      summary: output,
      source: "output",
    };
  }

  return {
    isTimeout: false,
    summary: null,
    source: "none",
  };
}

function classifyTypedTimeout(error: unknown, result?: ExecResultLike): string | null {
  if (result?.timedOut === true) {
    return "command timed out";
  }

  if (!error || typeof error !== "object") {
    return null;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toUpperCase() : null;
  const name = typeof record.name === "string" ? record.name.toUpperCase() : null;
  const message = typeof record.message === "string" ? record.message : String(error);

  if ((code && TYPED_TIMEOUT_CODES.has(code)) || (name && TYPED_TIMEOUT_CODES.has(name))) {
    return summarize(message);
  }

  if (record.timedOut === true) {
    return summarize(message);
  }

  if (isTimeoutLikeText(message)) {
    return summarize(message);
  }

  return null;
}

function classifySignalTimeout(result?: ExecResultLike): string | null {
  if (!result) {
    return null;
  }

  const signal = typeof result.signal === "string" ? result.signal.toUpperCase() : "";
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;

  if (signal && SIGNAL_TIMEOUTS.has(signal)) {
    return `command terminated by ${signal}`;
  }

  if (exitCode === 124) {
    return "command timed out (exit code 124)";
  }

  return null;
}

function classifyOutputTimeout(result?: ExecResultLike): string | null {
  if (!result) {
    return null;
  }

  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
  if (exitCode === 0) {
    return null;
  }

  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";

  if (stderr && isTimeoutLikeText(stderr)) {
    return summarize(stderr);
  }

  if (stdout && isTimeoutLikeText(stdout)) {
    return summarize(stdout);
  }

  return null;
}

function summarize(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 200) {
    return trimmed;
  }
  return `${trimmed.slice(0, 200)}...`;
}
