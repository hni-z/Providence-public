import { Runtime } from "../runtime.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { RuntimeOptions } from "../runtime.js";

/** Hosted coordination has function tools only: no local Codex process or shell. */
export class ApiRuntime extends Runtime {
  private apiConnected = false;
  override get connected() { return this.apiConnected; }
  private turns = new Map<string, AbortController>();
  private jobs = new Set<Promise<void>>();
  private threads: Record<string, any[]>;
  constructor(readonly options: RuntimeOptions, private file: string,
    private key: () => string, private model: string, private providerFetch: typeof fetch = fetch) {
    super(options);
    this.threads = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }
  async start() { this.apiConnected = true; return { type: "apiKey" }; }
  async create() {
    if (!this.apiConnected) throw new Error("Providence coordination is stopped");
    const threadId = randomUUID();
    this.threads[threadId] = []; this.save();
    return { threadId, workspace: this.options.root };
  }
  async execute(threadId: string, taskId: string, text: string) {
    if (!this.apiConnected) throw new Error("Providence coordination is stopped");
    if (!Object.hasOwn(this.threads, threadId)) throw new Error("Unknown coordinator conversation");
    if (this.turns.has(threadId)) throw new Error("Coordinator conversation is busy");
    const controller = new AbortController(); this.turns.set(threadId, controller);
    // Persist user input before execution; interrupted tool calls are never replayed on startup.
    this.threads[threadId].push({ role: "user", content: text }); this.save();
    const job = this.run(threadId, taskId, controller);
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return { turnId: taskId };
  }
  private async run(threadId: string, taskId: string, controller: AbortController) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
    const input = [...this.threads[threadId]];
    let text = "";
    try {
      this.emit("event", { type: "runtime.turn_acknowledged", threadId, taskId });
      for (let round = 0; round < 12; round++) {
        signal.throwIfAborted();
        if (JSON.stringify(input).length > 350_000) throw new Error("context_limit");
        const response = await this.providerFetch("https://api.openai.com/v1/responses", {
          method: "POST", redirect: "error", signal,
          headers: { Authorization: `Bearer ${this.key()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, reasoning: { effort: "low" }, service_tier: "fast",
            store: false, max_output_tokens: 4096, include: ["reasoning.encrypted_content"],
            instructions: this.options.instructions, input,
            tools: (this.options.tools ?? []).map(t => ({ type: "function", name: t.name,
              description: t.description, parameters: t.inputSchema, strict: false })),
            parallel_tool_calls: false }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`provider_${response.status}`); }
        // Bound provider responses as well as prompts.
        const reader = response.body?.getReader(); if (!reader) throw new Error("empty_response");
        let bytes = 0; const chunks: Uint8Array[] = [];
        try { while (true) { const r = await reader.read(); if (r.done) break;
          bytes += r.value.length; if (bytes > 2_000_000) { await reader.cancel(); throw new Error("response_limit"); }
          chunks.push(r.value); } } finally { reader.releaseLock(); }
        const result = JSON.parse(Buffer.concat(chunks).toString());
        if (result.status !== "completed" || !Array.isArray(result.output)) throw new Error("incomplete_response");
        input.push(...result.output);
        const calls = result.output.filter((item: any) => item.type === "function_call");
        for (const item of result.output) if (item.type === "message") {
          const part = (item.content ?? []).filter((v: any) => v.type === "output_text").map((v: any) => v.text).join("\n");
          if (part) { text += (text ? "\n" : "") + part;
            this.emit("event", { type: "text.delta", threadId, taskId, text: part, itemId: item.id }); }
        }
        if (!calls.length) {
          // Retain bounded plain conversation history. Tool results are already in the task store.
          this.threads[threadId].push({ role: "assistant", content: text || "Request completed." });
          this.threads[threadId] = this.threads[threadId].slice(-24); this.save();
          this.emit("event", { type: "task.completed", threadId, taskId, text }); return;
        }
        for (const call of calls) {
          signal.throwIfAborted();
          if (!(this.options.tools ?? []).some(t => t.name === call.name)) throw new Error("unknown_tool");
          let output: unknown;
          try { output = await this.options.toolHandler!(call.name, JSON.parse(call.arguments), call.call_id, { taskId, threadId }); }
          catch { output = { error: "The requested operation could not be completed. Check the selected device and task state." }; }
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
        }
      }
      throw new Error("turn_limit");
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable";
      this.emit("event", { type: controller.signal.aborted ? "task.cancelled" : "task.failed", threadId, taskId, text,
        error: code === "provider_401" || code === "provider_403" ? "Check your OpenAI API key and model access in Account settings."
          : code === "provider_429" ? "OpenAI rate or usage limit reached. Check your API billing and limits."
          : "Coordination stopped before a complete response. Inspect any dispatched device tasks before trying again." });
    } finally { this.turns.delete(threadId); }
  }
  async cancel(threadId: string) {
    const turn = this.turns.get(threadId); if (!turn) throw new Error("No active turn");
    turn.abort(); return { interrupted: true };
  }
  resolveApproval(): never { throw new Error("Resolve the permission request on its device task."); }
  stop() { this.apiConnected = false; for (const turn of this.turns.values()) turn.abort(); }
  override async stopAndWait() { this.stop(); await Promise.allSettled(this.jobs); }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.threads), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
}
