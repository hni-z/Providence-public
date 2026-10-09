import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexRpc } from "./rpc.js";
import { validateWorkerModel, type VerifiedWorkerModel, type WorkerModelRpc } from "./worker-model.js";

export const BENCHMARK_PROMPT = "Return exactly 42. Do not use tools.";
const TURN_TIMEOUT_MS = 60_000;

export type BenchmarkRpc = WorkerModelRpc & Pick<EventEmitter, "on" | "off"> & {
  onRequest?: (method: string, params: unknown, id: string | number) => Promise<unknown>;
};
export type BenchmarkSelection = Readonly<{ model: string; effort?: string }>;
export type BenchmarkOptions = Readonly<{
  baseline: BenchmarkSelection;
  candidate: BenchmarkSelection;
  repetitions: number;
  rpc: BenchmarkRpc;
  now?: () => number;
  timeoutMs?: number;
}>;
export type BenchmarkRound = Readonly<{
  startupMs: number;
  firstEventMs: number | null;
  firstTextMs: number | null;
  terminalMs: number | null;
  outputValid: boolean;
  invalid: boolean;
  timedOut: boolean;
}>;
export type BenchmarkSummary = Readonly<{
  model: string;
  effort?: string;
  repetitions: number;
  successfulRounds: number;
  p50TerminalMs: number | null;
  p95TerminalMs: number | null;
  rounds: readonly BenchmarkRound[];
}>;
export type BenchmarkResult = Readonly<{ toolsAreIsolated: false; baseline: BenchmarkSummary; candidate: BenchmarkSummary }>;

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function validOptions(options: BenchmarkOptions): void {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 10)
    throw new Error("repetitions must be an integer from 1 through 10.");
}

function notificationThreadId(params: unknown): string | undefined {
  return params && typeof params === "object" && typeof (params as Record<string, unknown>).threadId === "string"
    ? (params as Record<string, unknown>).threadId as string : undefined;
}

function toolStarted(method: string, params: unknown): boolean {
  if (method !== "item/started" || !params || typeof params !== "object") return false;
  const item = (params as Record<string, unknown>).item;
  return !!item && typeof item === "object" && !["agentMessage", "reasoning"].includes((item as Record<string, unknown>).type as string);
}

type BenchmarkSafety = { unsafe: boolean; abort?: () => void };

async function runRound(rpc: BenchmarkRpc, selection: VerifiedWorkerModel, cwd: string, now: () => number, timeoutMs: number, safety: BenchmarkSafety): Promise<BenchmarkRound> {
  const startupStarted = now();
  const started = await rpc.call("thread/start", {
    cwd, model: selection.model, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", dynamicTools: [],
  }) as { thread?: { id?: unknown } };
  const threadId = started.thread?.id;
  if (typeof threadId !== "string" || !threadId) throw new Error("Benchmark thread was not created.");
  const startupMs = Math.max(0, now() - startupStarted);
  const turnStarted = now();
  let firstEventMs: number | null = null;
  let firstTextMs: number | null = null;
  let outputValid = false;
  let invalid = false;
  let timedOut = false;
  let terminalMs: number | null = null;
  let turnId: string | undefined;
  let done!: (round: BenchmarkRound) => void;
  const completed = new Promise<BenchmarkRound>(resolve => { done = resolve; });
  const finish = () => done({ startupMs, firstEventMs, firstTextMs, terminalMs, outputValid, invalid, timedOut });
  let interrupted = false;
  const interrupt = () => {
    if (interrupted || !turnId) return;
    interrupted = true;
    void rpc.call("turn/interrupt", { threadId, turnId }).catch(() => {});
  };
  safety.abort = () => { invalid = true; safety.unsafe = true; interrupt(); };
  const listener = (method: string, params: unknown) => {
    if (notificationThreadId(params) !== threadId || terminalMs !== null) return;
    firstEventMs ??= Math.max(0, now() - turnStarted);
    if (toolStarted(method, params)) {
      invalid = true;
      safety.unsafe = true;
      interrupt();
      terminalMs = Math.max(0, now() - turnStarted);
      finish();
      return;
    }
    if (method === "turn/started") {
      const turn = params && typeof params === "object" ? (params as Record<string, unknown>).turn : undefined;
      if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string") turnId = (turn as Record<string, unknown>).id as string;
    }
    if (method === "item/agentMessage/delta") firstTextMs ??= Math.max(0, now() - turnStarted);
    if (method === "item/completed") {
      const item = params && typeof params === "object" ? (params as Record<string, unknown>).item : undefined;
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "agentMessage") {
        firstTextMs ??= Math.max(0, now() - turnStarted);
        const text = (item as Record<string, unknown>).text;
        outputValid = text === "42";
      }
    }
    if (method === "turn/completed") {
      const turn = params && typeof params === "object" ? (params as Record<string, unknown>).turn : undefined;
      if (!turn || typeof turn !== "object" || (turn as Record<string, unknown>).status !== "completed") invalid = true;
      terminalMs = Math.max(0, now() - turnStarted);
      finish();
    }
  };
  rpc.on("notification", listener);
  const timer = setTimeout(() => {
    if (terminalMs !== null) return;
    timedOut = true;
    terminalMs = Math.max(0, now() - turnStarted);
    safety.unsafe = true;
    interrupt();
    finish();
  }, timeoutMs);
  try {
    const turn = await rpc.call("turn/start", {
      threadId, input: [{ type: "text", text: BENCHMARK_PROMPT }], model: selection.model,
      ...(selection.effort ? { effort: selection.effort } : {}),
    }) as { turn?: { id?: unknown } };
    if (typeof turn.turn?.id === "string") turnId = turn.turn.id;
    if ((invalid || timedOut || safety.unsafe) && turnId) interrupt();
    return await completed;
  } finally {
    clearTimeout(timer);
    rpc.off("notification", listener);
  }
}

async function runSelection(rpc: BenchmarkRpc, selection: VerifiedWorkerModel, repetitions: number, cwd: string, now: () => number, timeoutMs: number, safety: BenchmarkSafety): Promise<BenchmarkSummary> {
  const rounds: BenchmarkRound[] = [];
  for (let index = 0; index < repetitions && !safety.unsafe; index++) {
    const round = await runRound(rpc, selection, cwd, now, timeoutMs, safety);
    rounds.push(round);
    if (round.invalid || round.timedOut) safety.unsafe = true;
  }
  const successful = rounds.filter(round => !round.invalid && !round.timedOut && round.outputValid && round.terminalMs !== null);
  const totals = successful.map(round => round.terminalMs!);
  return { model: selection.model, ...(selection.effort ? { effort: selection.effort } : {}), repetitions,
    successfulRounds: successful.length, p50TerminalMs: percentile(totals, .5), p95TerminalMs: percentile(totals, .95), rounds };
}

/** Runs only the fixed synthetic prompt. Injected external tools may still be exposed. */
export async function runWorkerBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  validOptions(options);
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be positive.");
  const previousRequestHandler = options.rpc.onRequest;
  const safety: BenchmarkSafety = { unsafe: false };
  options.rpc.onRequest = async () => { safety.abort?.(); throw new Error("Benchmark refuses provider requests."); };
  const cwd = await mkdtemp(join(tmpdir(), "providence-benchmark-"));
  try {
    const baseline = await validateWorkerModel(options.rpc, options.baseline.model, options.baseline.effort);
    const candidate = await validateWorkerModel(options.rpc, options.candidate.model, options.candidate.effort);
    if (!baseline || !candidate) throw new Error("Benchmark selections require explicit models.");
    const baselineSummary = await runSelection(options.rpc, baseline, options.repetitions, cwd, now, timeoutMs, safety);
    const candidateSummary = safety.unsafe
      ? { model: candidate.model, ...(candidate.effort ? { effort: candidate.effort } : {}), repetitions: options.repetitions, successfulRounds: 0, p50TerminalMs: null, p95TerminalMs: null, rounds: [] }
      : await runSelection(options.rpc, candidate, options.repetitions, cwd, now, timeoutMs, safety);
    return { toolsAreIsolated: false, baseline: baselineSummary, candidate: candidateSummary };
  } finally {
    options.rpc.onRequest = previousRequestHandler;
    await rm(cwd, { recursive: true, force: true });
  }
}

export function benchmarkPlan(): string {
  return "Dry run: fixed prompt only; --run is required. Provider model-turn timing excludes STT, TTS, browser actions, and real sends. toolsAreIsolated:false: dynamicTools is empty, but injected tools cannot be guaranteed absent; any observed tool start invalidates a round.";
}

function argument(name: string, args: string[]): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }

export async function benchmarkCli(args: string[], rpc = new CodexRpc()): Promise<string> {
  if (!args.includes("--run")) return benchmarkPlan();
  const baselineModel = argument("--baseline-model", args), candidateModel = argument("--candidate-model", args);
  const baselineEffort = argument("--baseline-effort", args), candidateEffort = argument("--candidate-effort", args);
  const repetitions = Number(argument("--repetitions", args));
  if (!baselineModel || !candidateModel || !baselineEffort || !candidateEffort || !Number.isInteger(repetitions))
    throw new Error("--run requires baseline/candidate model and effort plus --repetitions 1..10.");
  if (repetitions < 1 || repetitions > 10) throw new Error("repetitions must be an integer from 1 through 10.");
  try {
    await rpc.start();
    return JSON.stringify(await runWorkerBenchmark({ rpc, baseline: { model: baselineModel, effort: baselineEffort }, candidate: { model: candidateModel, effort: candidateEffort }, repetitions }));
  } finally { rpc.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  benchmarkCli(process.argv.slice(2)).then(console.log, error => { console.error(error.message); process.exitCode = 1; });
