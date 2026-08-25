import type {
	AgentSession,
	AgentSessionEvent,
	PromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getConfiguredReasonerModel,
	getConfiguredReasonerThinkingLevel,
	ReasonerRuntime,
	type ReasonerRuntimeOptions,
} from "../src/reasoner-runtime.js";
import {
	isSyntheticReasonerStop,
	type ReasonerSnapshot,
	type ReasonerTurn,
} from "../src/types.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

interface FakeSessionHarness {
	session: AgentSession;
	emit: (event: AgentSessionEvent) => void;
	setIdle: (idle: boolean) => void;
	setStreaming: (streaming: boolean) => void;
	promptRun: Deferred<void>;
	promptOptions: () => PromptOptions | undefined;
	calls: string[];
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createFakeSession(options: { idle?: boolean; streaming?: boolean } = {}): FakeSessionHarness {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	let idle = options.idle ?? false;
	let streaming = options.streaming ?? false;
	let currentModel = { provider: "test", id: "reasoner" };
	let latestPromptOptions: PromptOptions | undefined;
	const promptRun = deferred<void>();
	const calls: string[] = [];

	const session = {
		get model() {
			return currentModel;
		},
		sessionFile: "/tmp/duplex-reasoner.jsonl",
		sessionManager: { getLeafId: () => "leaf-1" },
		get isIdle() {
			return idle;
		},
		get isStreaming() {
			return streaming;
		},
		subscribe: vi.fn((nextListener: (event: AgentSessionEvent) => void) => {
			listener = nextListener;
			return () => {
				calls.push("unsubscribe");
				listener = undefined;
			};
		}),
		prompt: vi.fn((_text: string, promptOptions?: PromptOptions) => {
			latestPromptOptions = promptOptions;
			return promptRun.promise;
		}),
		steer: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		waitForIdle: vi.fn(async () => {
			calls.push("waitForIdle");
		}),
		compact: vi.fn(async (customInstructions?: string) => {
			calls.push(`compact:${customInstructions ?? ""}`);
			return {};
		}),
		setModel: vi.fn(async (model: Model<any>) => {
			currentModel = { provider: model.provider, id: model.id };
		}),
		clearQueue: vi.fn(() => {
			calls.push("clearQueue");
			return { steering: [], followUp: [] };
		}),
		abortCompaction: vi.fn(() => {
			calls.push("abortCompaction");
		}),
		abort: vi.fn(async () => {
			calls.push("abort");
			idle = true;
			streaming = false;
		}),
		dispose: vi.fn(() => {
			calls.push("dispose");
		}),
	} as unknown as AgentSession;

	return {
		session,
		emit: (event) => {
			if (!listener) throw new Error("The fake session has no subscriber.");
			listener(event);
		},
		setIdle: (value) => {
			idle = value;
		},
		setStreaming: (value) => {
			streaming = value;
		},
		promptRun,
		promptOptions: () => latestPromptOptions,
		calls,
	};
}

function createRuntime(
	harness: FakeSessionHarness,
	overrides: Partial<ReasonerRuntimeOptions> = {},
): ReasonerRuntime {
	return new ReasonerRuntime(harness.session, {
		cwd: "/workspace",
		projectTrusted: false,
		model: "test/reasoner",
		...overrides,
	});
}

function asEvent(value: object): AgentSessionEvent {
	return value as unknown as AgentSessionEvent;
}

function assistantMessage(
	text: string,
	stopReason: string = "stop",
	errorMessage?: string,
): object {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
	};
}

const originalReasonerModel = process.env.PI_DUPLEX_REASONER_MODEL;
const originalReasonerThinking = process.env.PI_DUPLEX_REASONER_THINKING;

afterEach(() => {
	if (originalReasonerModel === undefined) delete process.env.PI_DUPLEX_REASONER_MODEL;
	else process.env.PI_DUPLEX_REASONER_MODEL = originalReasonerModel;
	if (originalReasonerThinking === undefined) delete process.env.PI_DUPLEX_REASONER_THINKING;
	else process.env.PI_DUPLEX_REASONER_THINKING = originalReasonerThinking;
});

describe("reasoner model configuration", () => {
	it("requires an explicit reasoner model", () => {
		delete process.env.PI_DUPLEX_REASONER_MODEL;
		expect(() => getConfiguredReasonerModel()).toThrow(
			"PI_DUPLEX_REASONER_MODEL is required",
		);

		process.env.PI_DUPLEX_REASONER_MODEL = " ";
		expect(() => getConfiguredReasonerModel()).toThrow(
			"PI_DUPLEX_REASONER_MODEL is required",
		);
	});

	it("requires a fully qualified provider and model", () => {
		process.env.PI_DUPLEX_REASONER_MODEL = "gpt-5.6-luna";
		expect(() => getConfiguredReasonerModel()).toThrow("Expected provider/model");
	});

	it("accepts any fully qualified provider and model", () => {
		process.env.PI_DUPLEX_REASONER_MODEL = "anthropic/claude-opus-4-7";
		expect(getConfiguredReasonerModel()).toBe("anthropic/claude-opus-4-7");

		process.env.PI_DUPLEX_REASONER_MODEL = "openrouter/anthropic/claude-opus-4-7";
		expect(getConfiguredReasonerModel()).toBe(
			"openrouter/anthropic/claude-opus-4-7",
		);
	});

	it("rejects empty provider or model components", () => {
		for (const value of ["/model", "provider/"]) {
			process.env.PI_DUPLEX_REASONER_MODEL = value;
			expect(() => getConfiguredReasonerModel()).toThrow();
		}
	});

	it("validates explicit thinking levels against Pi's model capabilities", () => {
		const model = {
			provider: "test",
			id: "reasoner",
			reasoning: true,
			thinkingLevelMap: { max: "max" },
		} as unknown as Model<any>;

		process.env.PI_DUPLEX_REASONER_THINKING = "turbo";
		expect(() => getConfiguredReasonerThinkingLevel(model)).toThrow(
			"is not supported by test/reasoner",
		);
		process.env.PI_DUPLEX_REASONER_THINKING = "MAX";
		expect(() => getConfiguredReasonerThinkingLevel(model)).toThrow();
		process.env.PI_DUPLEX_REASONER_THINKING = "max";
		expect(getConfiguredReasonerThinkingLevel(model)).toBe("max");
	});

	it("leaves the implicit max default for Pi to clamp normally", () => {
		delete process.env.PI_DUPLEX_REASONER_THINKING;
		const model = {
			provider: "test",
			id: "reasoner",
			reasoning: true,
		} as unknown as Model<any>;

		expect(getConfiguredReasonerThinkingLevel(model)).toBe("max");
	});
});

describe("ReasonerRuntime lifecycle", () => {
	it("switches models through Pi while idle", async () => {
		const harness = createFakeSession({ idle: true });
		const runtime = createRuntime(harness);
		const model = { provider: "anthropic", id: "claude-test" };

		const checkpoint = await runtime.setModel(model as Model<any>);

		expect(harness.session.setModel).toHaveBeenCalledWith(model);
		expect(runtime.snapshot.model).toBe("anthropic/claude-test");
		expect(checkpoint?.model).toBe("anthropic/claude-test");
	});

	it("clears both queues and compaction before aborting the agent", async () => {
		const harness = createFakeSession({ idle: false, streaming: true });
		const snapshots: ReasonerSnapshot[] = [];
		const runtime = createRuntime(harness, {
			onSnapshot: (snapshot) => snapshots.push(snapshot),
		});
		harness.emit(
			asEvent({ type: "queue_update", steering: ["change direction"], followUp: ["later"] }),
		);

		await runtime.abort();

		expect(harness.calls).toEqual(["clearQueue", "abortCompaction", "abort"]);
		expect(runtime.snapshot).toMatchObject({
			state: "idle",
			phase: "idle",
			queuedMessages: 0,
		});
		expect(snapshots.at(-1)?.state).toBe("idle");
	});

	it("unsubscribes, clears pending work, aborts a live session, then disposes it", async () => {
		const harness = createFakeSession({ idle: false, streaming: true });
		const runtime = createRuntime(harness);

		await runtime.dispose();

		expect(harness.calls).toEqual([
			"unsubscribe",
			"clearQueue",
			"abortCompaction",
			"abort",
			"clearQueue",
			"abortCompaction",
			"dispose",
		]);
	});

	it("joins concurrent disposal callers until the session is actually disposed", async () => {
		const harness = createFakeSession({ idle: false, streaming: true });
		const abortGate = deferred<void>();
		vi.mocked(harness.session.abort).mockImplementation(async () => {
			harness.calls.push("abort");
			await abortGate.promise;
			harness.setIdle(true);
			harness.setStreaming(false);
		});
		const runtime = createRuntime(harness);
		let secondResolved = false;

		const firstDisposal = runtime.dispose();
		const secondDisposal = runtime.dispose().then(() => {
			secondResolved = true;
		});
		await Promise.resolve();

		expect(secondResolved).toBe(false);
		expect(harness.calls.filter((call) => call === "abort")).toHaveLength(1);

		abortGate.resolve(undefined);
		await Promise.all([firstDisposal, secondDisposal]);

		expect(harness.calls.filter((call) => call === "dispose")).toHaveLength(1);
		expect(harness.calls.at(-1)).toBe("dispose");
	});

	it("defers admission across Pi's agent_end to agent_settled boundary", async () => {
		const harness = createFakeSession({ idle: false, streaming: true });
		const runtime = createRuntime(harness);
		harness.emit(asEvent({ type: "agent_end", messages: [], willRetry: false }));

		const admission = runtime.submit("steer", "arrived at the settle boundary");
		await Promise.resolve();
		expect(harness.session.prompt).not.toHaveBeenCalled();

		harness.setIdle(true);
		harness.setStreaming(false);
		harness.emit(asEvent({ type: "agent_settled" }));
		await Promise.resolve();
		expect(harness.session.prompt).toHaveBeenCalledTimes(1);

		harness.promptOptions()?.preflightResult?.(true);
		await admission;
		harness.promptRun.resolve(undefined);
		await harness.promptRun.promise;
	});

	it("waits for a preflight-crossing prompt before disposing", async () => {
		const harness = createFakeSession({ idle: true, streaming: false });
		const runtime = createRuntime(harness);
		const admission = runtime.submit("start", "pending behind pre-prompt work");
		const admissionResult = admission.then(
			() => "resolved",
			(error: Error) => error.name,
		);

		const disposing = runtime.dispose();
		harness.promptOptions()?.preflightResult?.(true);
		harness.promptRun.resolve(undefined);

		expect(await admissionResult).toBe("AbortError");
		await disposing;
		expect(harness.calls.at(-1)).toBe("dispose");
	});

	it("resolves prompt admission before the full reasoning run completes", async () => {
		const harness = createFakeSession({ idle: true });
		const runtime = createRuntime(harness);
		let admitted = false;

		const admission = runtime.submit("start", "preserve  this exactly").then(() => {
			admitted = true;
		});
		await Promise.resolve();
		expect(admitted).toBe(false);
		expect(harness.promptOptions()?.expandPromptTemplates).toBe(false);

		harness.promptOptions()?.preflightResult?.(true);
		await admission;

		expect(admitted).toBe(true);
		expect(harness.session.prompt).toHaveBeenCalledWith(
			"preserve  this exactly",
			expect.objectContaining({ expandPromptTemplates: false }),
		);

		// Admission does not wait for this promise; settle it to leave no dangling work.
		harness.promptRun.resolve(undefined);
		await harness.promptRun.promise;
	});

	it("waits for an idle boundary and defers new work across manual compaction", async () => {
		const harness = createFakeSession({ idle: false, streaming: true });
		const idleGate = deferred<void>();
		const compactionGate = deferred<void>();
		vi.mocked(harness.session.waitForIdle).mockImplementation(async () => {
			harness.calls.push("waitForIdle");
			await idleGate.promise;
			harness.setIdle(true);
			harness.setStreaming(false);
		});
		vi.mocked(harness.session.compact).mockImplementation(async (instructions) => {
			harness.calls.push(`compact:${instructions ?? ""}`);
			await compactionGate.promise;
			return {} as never;
		});
		const runtime = createRuntime(harness);

		const compaction = runtime.compact("focus on decisions");
		const queuedAdmission = runtime.submit("steer", "arrived during compaction");
		await Promise.resolve();

		expect(harness.session.abort).not.toHaveBeenCalled();
		expect(harness.session.prompt).not.toHaveBeenCalled();
		expect(harness.calls).toEqual(["waitForIdle"]);

		idleGate.resolve(undefined);
		await vi.waitFor(() => {
			expect(harness.calls).toContain("compact:focus on decisions");
		});

		compactionGate.resolve(undefined);
		await expect(compaction).resolves.toBe(true);
		await Promise.resolve();
		expect(harness.session.prompt).toHaveBeenCalledTimes(1);

		harness.promptOptions()?.preflightResult?.(true);
		await queuedAdmission;
		harness.promptRun.resolve(undefined);
		await harness.promptRun.promise;
	});

	it("treats a too-small reasoner session as a successful compaction no-op", async () => {
		const harness = createFakeSession({ idle: true });
		vi.mocked(harness.session.compact).mockRejectedValue(
			new Error("Nothing to compact (session too small)"),
		);
		const onError = vi.fn();
		const runtime = createRuntime(harness, { onError });

		await expect(runtime.compact()).resolves.toBe(false);
		expect(runtime.snapshot).toMatchObject({ state: "idle", phase: "idle" });
		expect(onError).not.toHaveBeenCalled();
	});

	it("cancels a compaction waiting behind active work when STOP arrives", async () => {
		const harness = createFakeSession({ idle: false, streaming: true });
		const idleGate = deferred<void>();
		vi.mocked(harness.session.waitForIdle).mockImplementation(async () => {
			harness.calls.push("waitForIdle");
			await idleGate.promise;
		});
		vi.mocked(harness.session.abort).mockImplementation(async () => {
			harness.calls.push("abort");
			harness.setIdle(true);
			harness.setStreaming(false);
			idleGate.resolve(undefined);
		});
		const runtime = createRuntime(harness);

		const compaction = runtime.compact("do not run after stop");
		const stopping = runtime.abort();

		await expect(compaction).rejects.toMatchObject({ name: "AbortError" });
		await stopping;
		expect(harness.session.compact).not.toHaveBeenCalled();
		expect(runtime.snapshot).toMatchObject({ state: "idle", phase: "idle" });
	});

	it("rejects admission when prompt preflight fails", async () => {
		const harness = createFakeSession({ idle: true });
		const runtime = createRuntime(harness);
		const admission = runtime.submit("start", "cannot be admitted");
		const error = new Error("no configured auth");

		harness.promptOptions()?.preflightResult?.(false);
		harness.promptRun.reject(error);

		await expect(admission).rejects.toBe(error);
		expect(runtime.snapshot).toMatchObject({ state: "error" });
	});
});

describe("ReasonerRuntime event reduction", () => {
	it("accumulates tool-only turns into the next prose turn", () => {
		const harness = createFakeSession();
		const turns: ReasonerTurn[] = [];
		createRuntime(harness, { onTurn: (turn) => turns.push(turn) });

		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "src/controller.ts" },
			}),
		);
		harness.emit(
			asEvent({
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				result: { content: [] },
				isError: false,
			}),
		);
		harness.emit(
			asEvent({ type: "turn_end", message: assistantMessage("", "toolUse"), toolResults: [] }),
		);

		harness.emit(
			asEvent({
				type: "tool_execution_start",
				toolCallId: "bash-1",
				toolName: "bash",
				args: { command: "npm test\n-- --runInBand" },
			}),
		);
		harness.emit(
			asEvent({
				type: "tool_execution_end",
				toolCallId: "bash-1",
				toolName: "bash",
				result: { content: [] },
				isError: true,
			}),
		);
		harness.emit(
			asEvent({ type: "turn_end", message: assistantMessage("", "toolUse"), toolResults: [] }),
		);
		expect(turns).toEqual([]);

		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("Implemented and verified."),
				toolResults: [],
			}),
		);

		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			text: "Implemented and verified.",
			stopReason: "stop",
			superseded: false,
			checkpoint: {
				sessionFile: "/tmp/duplex-reasoner.jsonl",
				leafId: "leaf-1",
			},
		});
		expect(turns[0]?.tools).toEqual([
			{
				summary: "read src/controller.ts",
				isError: false,
			},
			{
				summary: "bash npm test -- --runInBand",
				isError: true,
			},
		]);
	});

	it("suppresses a transient retry failure and publishes only the successful retry", () => {
		const harness = createFakeSession();
		const turns: ReasonerTurn[] = [];
		const errors: Error[] = [];
		const runtime = createRuntime(harness, {
			onTurn: (turn) => turns.push(turn),
			onError: (error) => errors.push(error),
		});

		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("Temporary provider failure", "error", "rate limited"),
				toolResults: [],
			}),
		);
		harness.emit(asEvent({ type: "agent_end", messages: [], willRetry: true }));
		harness.emit(
			asEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 0,
				errorMessage: "rate limited",
			}),
		);
		harness.emit(asEvent({ type: "agent_start" }));
		// Pi emits a successful auto_retry_end while persisting message_end,
		// immediately before it forwards that assistant message's turn_end.
		harness.emit(asEvent({ type: "auto_retry_end", success: true, attempt: 1 }));
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("Recovered successfully."),
				toolResults: [],
			}),
		);
		harness.emit(asEvent({ type: "agent_end", messages: [], willRetry: false }));
		harness.emit(asEvent({ type: "agent_settled" }));

		expect(turns.map((turn) => turn.text)).toEqual(["Recovered successfully."]);
		expect(errors).toEqual([]);
		expect(runtime.snapshot).toMatchObject({ state: "idle", phase: "idle" });
	});

	it("publishes a terminal error once after retry exhaustion", () => {
		const harness = createFakeSession();
		const turns: ReasonerTurn[] = [];
		const errors: Error[] = [];
		const runtime = createRuntime(harness, {
			onTurn: (turn) => turns.push(turn),
			onError: (error) => errors.push(error),
		});

		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("Provider still unavailable", "error", "service unavailable"),
				toolResults: [],
			}),
		);
		harness.emit(asEvent({ type: "agent_end", messages: [], willRetry: false }));
		harness.emit(
			asEvent({
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "service unavailable",
			}),
		);
		harness.emit(asEvent({ type: "agent_settled" }));

		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			text: "Provider still unavailable",
			stopReason: "error",
			errorMessage: "service unavailable",
		});
		expect(errors.map((error) => error.message)).toEqual(["service unavailable"]);
		expect(runtime.snapshot).toMatchObject({ state: "error", phase: "error" });
	});

	it("does not publish an error that overflow compaction recovers", () => {
		const harness = createFakeSession();
		const turns: ReasonerTurn[] = [];
		const errors: Error[] = [];
		createRuntime(harness, {
			onTurn: (turn) => turns.push(turn),
			onError: (error) => errors.push(error),
		});

		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("Context overflow", "error", "context limit"),
				toolResults: [],
			}),
		);
		harness.emit(asEvent({ type: "agent_end", messages: [], willRetry: false }));
		expect(turns).toHaveLength(0);
		expect(errors).toHaveLength(0);

		harness.emit(asEvent({ type: "compaction_start", reason: "overflow" }));
		harness.emit(
			asEvent({ type: "compaction_end", reason: "overflow", willRetry: true }),
		);
		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("Recovered answer", "stop"),
				toolResults: [],
			}),
		);

		expect(turns).toHaveLength(1);
		expect(turns[0]?.text).toBe("Recovered answer");
		expect(errors).toHaveLength(0);
	});

	it("does not publish a staged overflow failure when STOP aborts compaction", async () => {
		const harness = createFakeSession({ idle: false, streaming: true });
		const turns: ReasonerTurn[] = [];
		const errors: Error[] = [];
		const runtime = createRuntime(harness, {
			onTurn: (turn) => turns.push(turn),
			onError: (error) => errors.push(error),
		});

		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("A truncated answer", "length", "context limit"),
				toolResults: [],
			}),
		);
		harness.emit(asEvent({ type: "agent_end", messages: [], willRetry: false }));
		harness.emit(asEvent({ type: "compaction_start", reason: "overflow" }));

		const stopping = runtime.abort();
		harness.emit(
			asEvent({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: true,
				willRetry: false,
			}),
		);
		await stopping;

		expect(turns).toEqual([]);
		expect(errors).toEqual([]);
		expect(runtime.snapshot).toMatchObject({ state: "idle", phase: "idle" });
	});

	it("marks output superseded when steering is pending at its safe boundary", () => {
		const harness = createFakeSession();
		const turns: ReasonerTurn[] = [];
		createRuntime(harness, { onTurn: (turn) => turns.push(turn) });

		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({ type: "queue_update", steering: ["use option B"], followUp: ["then test"] }),
		);
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("This answer is now stale."),
				toolResults: [],
			}),
		);

		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			text: "This answer is now stale.",
			superseded: true,
		});
	});

	it("publishes an aborted turn without treating cancellation as a runtime error", () => {
		const harness = createFakeSession();
		const turns: ReasonerTurn[] = [];
		const errors: Error[] = [];
		const runtime = createRuntime(harness, {
			onTurn: (turn) => turns.push(turn),
			onError: (error) => errors.push(error),
		});

		harness.emit(asEvent({ type: "agent_start" }));
		harness.emit(
			asEvent({
				type: "turn_end",
				message: assistantMessage("", "aborted", "Request was aborted"),
				toolResults: [],
			}),
		);
		harness.emit(asEvent({ type: "agent_end", messages: [], willRetry: false }));
		harness.emit(asEvent({ type: "agent_settled" }));

		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			text: "Reasoner work was stopped.",
			stopReason: "aborted",
			superseded: false,
		});
		expect(isSyntheticReasonerStop(turns[0]!)).toBe(true);
		expect(isSyntheticReasonerStop({ ...turns[0]!, text: "Partial answer" })).toBe(false);
		expect(errors).toEqual([]);
		expect(runtime.snapshot).toMatchObject({ state: "idle", phase: "idle" });
	});
});
