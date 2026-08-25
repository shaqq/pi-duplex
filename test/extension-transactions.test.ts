import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import duplexExtension from "../src/extension.js";
import { REASONER_OUTPUT_MESSAGE, REASONER_TURN_ENTRY } from "../src/public-context.js";
import { REASONER_MODEL_STATE_TYPE } from "../src/reasoner-model-state.js";
import { ReasonerRuntime } from "../src/reasoner-runtime.js";
import { ROUTE_TRANSACTION_TYPE } from "../src/route-transactions.js";
import { REASONER_STATE_TYPE } from "../src/session-state.js";

type AnyHandler = (...args: any[]) => any;

const originalReasonerModel = process.env.PI_DUPLEX_REASONER_MODEL;
const originalReasonerThinking = process.env.PI_DUPLEX_REASONER_THINKING;

beforeEach(() => {
	process.env.PI_DUPLEX_REASONER_MODEL = "test/reasoner";
	delete process.env.PI_DUPLEX_REASONER_THINKING;
});

afterEach(() => {
	vi.restoreAllMocks();
	if (originalReasonerModel === undefined) delete process.env.PI_DUPLEX_REASONER_MODEL;
	else process.env.PI_DUPLEX_REASONER_MODEL = originalReasonerModel;
	if (originalReasonerThinking === undefined) delete process.env.PI_DUPLEX_REASONER_THINKING;
	else process.env.PI_DUPLEX_REASONER_THINKING = originalReasonerThinking;
});

function createHarness(
	branch: any[] = [],
	options: {
		mode?: "tui" | "print" | "json" | "rpc";
		persistent?: boolean;
		editorFactory?: any;
	} = {},
) {
	const handlers = new Map<string, AnyHandler[]>();
	const commands = new Map<string, any>();
	let routeTool: any;
	let reasonerTurnRenderer: AnyHandler | undefined;
	const appendEntry = vi.fn<(customType: string, data: any) => void>();
	const sendMessage = vi.fn();
	const notify = vi.fn();
	const confirm = vi.fn(async () => true);
	const compact = vi.fn();
	const custom = vi.fn(async (..._args: any[]): Promise<any> => undefined);
	let editorFactory: unknown = options.editorFactory;
	const ui = {
		notify,
		confirm,
		custom,
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		getEditorComponent: vi.fn(() => editorFactory),
		setEditorComponent: vi.fn((factory) => {
			editorFactory = factory;
		}),
	};
	const model = {
		provider: "openai-codex",
		id: "gpt-5.6-luna",
		reasoning: true,
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		ui,
		cwd: "/tmp/pi-duplex-test",
		model,
		thinkingLevel: "medium",
		modelRegistry: {
			isUsingOAuth: () => true,
			getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
			getProviderAuthStatus: (_provider: string): any => ({
				configured: true,
				source: "stored",
			}),
			getApiKeyForProvider: async (_provider: string): Promise<string | undefined> =>
				undefined,
			getRegisteredProviderIds: (): string[] => [],
			getRegisteredNativeProvider: (_id: string): any => undefined,
			getRegisteredProviderConfig: (_id: string): any => undefined,
		},
		sessionManager: {
			getBranch: () => branch,
			buildContextEntries: () => branch,
			getEntries: () => branch,
			getCwd: () => "/tmp/pi-duplex-test",
			getSessionFile: () =>
				options.persistent === false ? undefined : "/tmp/pi-duplex-test/foreground.jsonl",
			getSessionName: () => undefined,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		getContextUsage: () => undefined,
		compact,
	};

	const setActiveTools = vi.fn();
	const pi = {
		registerEntryRenderer: vi.fn((customType: string, renderer: AnyHandler) => {
			if (customType === REASONER_TURN_ENTRY) reasonerTurnRenderer = renderer;
		}),
		registerMessageRenderer: vi.fn(),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => {
			routeTool = tool;
		},
		on: (event: string, handler: AnyHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		appendEntry,
		sendMessage,
		getActiveTools: () => ["read", "bash", "delegate"],
		setActiveTools,
	} as unknown as ExtensionAPI;

	duplexExtension(pi);

	async function emit(event: string, payload: any = {}): Promise<any[]> {
		const results: any[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	}

	async function startSession(): Promise<void> {
		await emit("session_start", { type: "session_start", reason: "startup" });
	}

	async function exposeInput(text: string): Promise<void> {
		await emit("input", {
			type: "input",
			source: "interactive",
			text,
		});
		await emit("before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "foreground",
		});
		await emit("turn_start", { type: "turn_start" });
		await emit("message_start", {
			type: "message_start",
			message: { role: "user", content: text },
		});
	}

	return {
		appendEntry,
		commands,
		confirm,
		compact,
		custom,
		ctx,
		emit,
		exposeInput,
		notify,
		sendMessage,
		setActiveTools,
		get routeTool() {
			return routeTool;
		},
		get reasonerTurnRenderer() {
			return reasonerTurnRenderer;
		},
		get editorFactory() {
			return editorFactory;
		},
		startSession,
	};
}

function linkedStateEntry() {
	return {
		type: "custom",
		customType: REASONER_STATE_TYPE,
		data: {
			version: 1,
			mode: "linked",
			sessionFile: "/tmp/pi-duplex-test/reasoner.jsonl",
			leafId: "leaf-1",
		},
	};
}

function escapeAwareEditor() {
	const editor: any = {
		actionHandlers: new Map(),
		onEscape: undefined,
		render: () => [],
		invalidate: vi.fn(),
		getText: () => "",
		setText: vi.fn(),
		handleInput: vi.fn((data: string) => {
			if (data === "escape") editor.onEscape?.();
		}),
	};
	return editor;
}

describe("extension transaction failure boundaries", () => {
	it("registers delegation and recovery", () => {
		const harness = createHarness();

		expect(harness.routeTool.name).toBe("delegate");
		expect(harness.commands.has("reset-reasoner")).toBe(true);
		expect(harness.commands.has("reasoner-model")).toBe(true);
	});

	it("renders an empty aborted turn as one stop status", () => {
		const harness = createHarness();
		const component = harness.reasonerTurnRenderer?.(
			{
				data: {
					sequence: 1,
					text: "Reasoner work was stopped.",
					tools: [],
					stopReason: "aborted",
					superseded: false,
					timestamp: 1,
				},
			},
			{ expanded: false },
			{ fg: (_color: string, value: string) => value },
		);
		const rendered = component?.render(100).join("\n") ?? "";

		expect(rendered).not.toContain("Reasoner work was stopped.");
		expect(rendered.match(/Reasoner stopped/g)).toHaveLength(1);
	});

	it("uses Pi's reasoner catalog and session to switch models", async () => {
		const selected = { provider: "anthropic", id: "claude-test" };
		const runtime = {
			isBusy: false,
			modelSelectionResources: {
				currentModel: { provider: "test", id: "reasoner" },
				settingsManager: {},
				modelRuntime: {},
				scopedModels: [],
			},
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			setModel: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockResolvedValue(runtime as unknown as ReasonerRuntime);
		const harness = createHarness();
		harness.custom.mockResolvedValue(selected);
		await harness.startSession();
		await harness.exposeInput("initialize the reasoner");
		await harness.routeTool.execute(
			"route-0",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);

		await harness.commands.get("reasoner-model").handler("claude", harness.ctx);

		expect(runtime.setModel).toHaveBeenCalledWith(selected);
		expect(harness.appendEntry).toHaveBeenCalledWith(REASONER_MODEL_STATE_TYPE, {
			version: 1,
			mode: "selected",
			reference: "anthropic/claude-test",
		});
		expect(harness.notify).toHaveBeenCalledWith(
			"Reasoner model: anthropic/claude-test",
			"info",
		);
	});

	it("rejects an explicit thinking level unsupported by a live model switch", async () => {
		process.env.PI_DUPLEX_REASONER_THINKING = "max";
		const selected = {
			provider: "anthropic",
			id: "claude-test",
			reasoning: true,
			thinkingLevelMap: { high: "high" },
		};
		const runtime = {
			isBusy: false,
			modelSelectionResources: {
				currentModel: { provider: "test", id: "reasoner" },
				settingsManager: {},
				modelRuntime: {},
				scopedModels: [],
			},
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			setModel: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockResolvedValue(runtime as unknown as ReasonerRuntime);
		const harness = createHarness();
		harness.custom.mockResolvedValue(selected);
		await harness.startSession();
		await harness.exposeInput("initialize the reasoner");
		await harness.routeTool.execute(
			"route-0",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
		harness.appendEntry.mockClear();

		await harness.commands.get("reasoner-model").handler("claude", harness.ctx);

		expect(runtime.setModel).not.toHaveBeenCalled();
		expect(harness.appendEntry).not.toHaveBeenCalledWith(
			REASONER_MODEL_STATE_TYPE,
			expect.anything(),
		);
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("PI_DUPLEX_REASONER_THINKING=\"max\" is not supported"),
			"error",
		);
	});

	it("blocks routing when a reasoner model change has an ambiguous write", async () => {
		const selected = { provider: "anthropic", id: "claude-test" };
		const runtime = {
			isBusy: false,
			modelSelectionResources: {
				currentModel: { provider: "test", id: "reasoner" },
				settingsManager: {},
				modelRuntime: {},
				scopedModels: [],
			},
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			setModel: vi.fn(async () => {
				throw new Error("nested model write failed");
			}),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockResolvedValue(runtime as unknown as ReasonerRuntime);
		const harness = createHarness();
		harness.custom.mockResolvedValue(selected);
		await harness.startSession();
		await harness.exposeInput("initialize the reasoner");
		await harness.routeTool.execute(
			"route-0",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);

		await harness.commands.get("reasoner-model").handler("", harness.ctx);
		await harness.exposeInput("continue after the partial model change");

		await expect(
			harness.routeTool.execute(
				"route-1",
				{ action: "start" },
				undefined,
				undefined,
				harness.ctx,
			),
		).rejects.toThrow("uncertain outcome");
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("could not persist the reasoner model change"),
			"error",
		);
	});

	it("restores a picked model even before the reasoner has produced a message", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});
		const harness = createHarness([
			{
				type: "custom",
				customType: REASONER_MODEL_STATE_TYPE,
				data: {
					version: 1,
					mode: "selected",
					reference: "anthropic/claude-picked",
				},
			},
		]);
		await harness.startSession();
		await harness.exposeInput("resume before the first reasoner answer");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(reasonerOptions.model).toBe("anthropic/claude-picked");
	});

	it("restores a checkpoint model without requiring the original environment setting", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});
		delete process.env.PI_DUPLEX_REASONER_MODEL;
		const harness = createHarness([
			{
				...linkedStateEntry(),
				data: {
					...linkedStateEntry().data,
					model: "anthropic/claude-saved",
				},
			},
		]);

		await harness.startSession();
		await harness.exposeInput("resume the saved reasoner");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(reasonerOptions.model).toBe("anthropic/claude-saved");
		expect(reasonerOptions.restore.model).toBe("anthropic/claude-saved");
		expect(harness.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("PI_DUPLEX_REASONER_MODEL is required"),
			"error",
		);
	});

	it("replaces an unavailable saved model without detaching reasoner history", async () => {
		let reasonerOptions: any;
		const replacement = { provider: "anthropic", id: "claude-replacement" };
		vi.spyOn(ReasonerRuntime, "createModelSelectionResources").mockResolvedValue({
			currentModel: undefined,
			settingsManager: {},
			modelRuntime: {},
			scopedModels: [],
		} as any);
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return {
				isBusy: false,
				checkpoint: {
					sessionFile: "/tmp",
					leafId: "saved-leaf",
					model: "anthropic/claude-replacement",
				},
				dispose: vi.fn(async () => undefined),
			} as unknown as ReasonerRuntime;
		});
		const harness = createHarness([
			{
				...linkedStateEntry(),
				data: {
					...linkedStateEntry().data,
					model: "retired/model",
				},
			},
			{
				type: "custom",
				customType: REASONER_MODEL_STATE_TYPE,
				data: {
					version: 1,
					mode: "selected",
					reference: "retired/model",
				},
			},
		]);
		harness.custom.mockResolvedValue(replacement);
		await harness.startSession();

		await harness.commands.get("reasoner-model").handler("", harness.ctx);

		expect(ReasonerRuntime.createModelSelectionResources).toHaveBeenCalledWith(
			expect.objectContaining({ currentModel: "retired/model" }),
		);
		expect(reasonerOptions.model).toBe("anthropic/claude-replacement");
		expect(reasonerOptions.restore).toMatchObject({
			leafId: "leaf-1",
			model: "anthropic/claude-replacement",
		});
		expect(harness.notify).toHaveBeenCalledWith(
			"Reasoner model: anthropic/claude-replacement",
			"info",
		);
	});

	it("shares foreground-registered providers with the isolated reasoner runtime", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});
		const nativeProvider = { id: "custom-native" };
		const configuredProvider = { api: "openai-completions" };
		const harness = createHarness();
		harness.ctx.modelRegistry = {
			...harness.ctx.modelRegistry,
			getRegisteredProviderIds: () => ["custom-native", "custom-config"],
			getRegisteredNativeProvider: (id: string) =>
				id === "custom-native" ? nativeProvider : undefined,
			getRegisteredProviderConfig: (id: string) =>
				id === "custom-config" ? configuredProvider : undefined,
		};
		await harness.startSession();
		await harness.exposeInput("use the custom provider");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
		const nestedRuntime = {
			registerNativeProvider: vi.fn(),
			registerProvider: vi.fn(),
		};

		await reasonerOptions.configureModelRuntime(nestedRuntime);

		expect(nestedRuntime.registerNativeProvider).toHaveBeenCalledWith(nativeProvider);
		expect(nestedRuntime.registerProvider).toHaveBeenCalledWith(
			"custom-config",
			configuredProvider,
		);
	});

	it("shares a foreground --api-key runtime override with the reasoner", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});
		const harness = createHarness();
		harness.ctx.modelRegistry = {
			...harness.ctx.modelRegistry,
			getProviderAuthStatus: (provider: string) => ({
				configured: provider === "test",
				source: provider === "test" ? "runtime" : undefined,
			}),
			getApiKeyForProvider: async (provider: string) =>
				provider === "test" ? "runtime-secret" : undefined,
		};
		await harness.startSession();
		await harness.exposeInput("use the runtime credential");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
		const nestedRuntime = {
			registerNativeProvider: vi.fn(),
			registerProvider: vi.fn(),
			setRuntimeApiKey: vi.fn(async () => undefined),
		};

		await reasonerOptions.configureModelRuntime(nestedRuntime);

		expect(nestedRuntime.setRuntimeApiKey).toHaveBeenCalledWith("test", "runtime-secret");
	});

	it("leaves foreground model and credential validation to Pi", async () => {
		const harness = createHarness();
		harness.ctx.model = { provider: "anthropic", id: "any-model", reasoning: true };
		harness.ctx.modelRegistry = {
			...harness.ctx.modelRegistry,
			isUsingOAuth: () => false,
		};
		await harness.startSession();

		const [result] = await harness.emit("input", {
			type: "input",
			source: "interactive",
			text: "hello",
		});

		expect(result).toEqual({ action: "continue" });
	});

	it("repairs and updates compaction-aware reasoner output context", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});

		const harness = createHarness([
			{
				type: "custom",
				customType: REASONER_TURN_ENTRY,
				data: {
					sequence: 1,
					text: "restored public answer",
					tools: [{ summary: "must remain private" }],
					superseded: false,
					timestamp: 1_777_777_777_001,
				},
			},
		]);
		await harness.startSession();

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: REASONER_OUTPUT_MESSAGE,
				content: expect.stringContaining("restored public answer"),
				display: false,
			}),
			{ triggerTurn: false },
		);
		expect(harness.sendMessage.mock.calls[0]?.[0].content).not.toContain("must remain private");
		harness.sendMessage.mockClear();

		await harness.exposeInput("continue the work");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
		reasonerOptions.onTurn({
			sequence: 2,
			text: "new committed answer",
			tools: [],
			superseded: false,
			timestamp: 1_777_777_777_002,
		});

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: REASONER_OUTPUT_MESSAGE,
				content: expect.stringContaining("new committed answer"),
				display: false,
			}),
			{ triggerTurn: false },
		);
		const [contextResult] = await harness.emit("context", { type: "context", messages: [] });
		expect(contextResult.messages.at(-1).content).not.toContain("new committed answer");
	});

	it("defers the context mirror until an active foreground agent settles", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});

		const harness = createHarness();
		await harness.startSession();
		await harness.exposeInput("do substantive work");
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
		reasonerOptions.onTurn({
			sequence: 1,
			text: "completed while the foreground tool call is active",
			tools: [],
			superseded: false,
			timestamp: 1_777_777_777_001,
		});

		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.appendEntry).toHaveBeenCalledWith(
			REASONER_TURN_ENTRY,
			expect.objectContaining({ sequence: 1 }),
		);

		await harness.emit("agent_settled", { type: "agent_settled" });
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: REASONER_OUTPUT_MESSAGE }),
			{ triggerTurn: false },
		);
	});

	it("always releases the reset barrier when the detach tombstone cannot be persisted", async () => {
		const harness = createHarness([linkedStateEntry()]);
		let tombstoneAttempts = 0;
		harness.appendEntry.mockImplementation((customType, data) => {
			if (customType === REASONER_STATE_TYPE && data?.mode === "none") {
				tombstoneAttempts += 1;
				if (tombstoneAttempts === 1) throw new Error("disk unavailable");
			}
		});
		await harness.startSession();
		const reset = harness.commands.get("reset-reasoner");

		await expect(reset.handler("", harness.ctx)).rejects.toThrow("disk unavailable");
		await expect(reset.handler("", harness.ctx)).resolves.toBeUndefined();

		expect(tombstoneAttempts).toBe(2);
		expect(harness.confirm).toHaveBeenCalledTimes(2);
		expect(harness.notify).not.toHaveBeenCalledWith(
			"A reasoner reset is already in progress.",
			"warning",
		);
	});

	it("clears an unavailable saved model before detaching the reasoner", async () => {
		const harness = createHarness([
			linkedStateEntry(),
			{
				type: "custom",
				customType: REASONER_MODEL_STATE_TYPE,
				data: {
					version: 1,
					mode: "selected",
					reference: "missing-provider/removed-model",
				},
			},
		]);
		await harness.startSession();

		await harness.commands.get("reset-reasoner").handler("", harness.ctx);

		const writes = harness.appendEntry.mock.calls.map(([customType, data]) => ({
			customType,
			data,
		}));
		expect(writes.slice(0, 2)).toEqual([
			{
				customType: REASONER_MODEL_STATE_TYPE,
				data: { version: 1, mode: "default" },
			},
			{
				customType: REASONER_STATE_TYPE,
				data: { version: 1, mode: "none" },
			},
		]);
	});

	it("waits for an Escape stop before disposing the reasoner on shutdown", async () => {
		let busy = false;
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		const runtime = {
			get isBusy() {
				return busy;
			},
			submit: vi.fn(async () => {
				busy = true;
			}),
			abort: vi.fn(async () => {
				await abortGate;
				busy = false;
			}),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockResolvedValue(runtime as unknown as ReasonerRuntime);
		const baseEditor = escapeAwareEditor();
		const harness = createHarness([], {
			editorFactory: () => baseEditor,
		});
		await harness.startSession();
		await harness.exposeInput("long-running request");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
		const editor = (harness.editorFactory as any)({}, {}, {});
		const nativeEscape = vi.fn();
		editor.onEscape = nativeEscape;
		editor.handleInput("escape");
		editor.handleInput("escape");

		const shutdown = harness.emit("session_shutdown", { type: "session_shutdown" });
		await Promise.resolve();
		expect(runtime.abort).toHaveBeenCalledOnce();
		expect(runtime.dispose).not.toHaveBeenCalled();

		releaseAbort();
		await shutdown;

		expect(runtime.dispose).toHaveBeenCalledOnce();
		const abandonedWrites = harness.appendEntry.mock.calls.filter(
			([customType, data]) =>
				customType === ROUTE_TRANSACTION_TYPE && data?.phase === "abandoned",
		);
		expect(abandonedWrites).toHaveLength(1);
	});

	it("returns an envelope for retry when persisting its prepared record fails", async () => {
		const harness = createHarness();
		harness.appendEntry.mockImplementation((customType, data) => {
			if (customType === ROUTE_TRANSACTION_TYPE && data?.phase === "prepared") {
				throw new Error("cannot persist prepared route");
			}
		});
		await harness.startSession();
		await harness.exposeInput("exact request");

		await expect(
			harness.routeTool.execute("route-1", { action: "start" }, undefined, undefined, harness.ctx),
		).rejects.toThrow("cannot persist prepared route");
		await harness.emit("turn_start", { type: "turn_start" });
		const stopped = await harness.routeTool.execute(
			"route-2",
			{ action: "stop" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(stopped.details).toEqual({ acceptedCount: 1 });
	});

	it("does not fail or release work already accepted before an admission-record write fails", async () => {
		let busy = false;
		const runtime = {
			get isBusy() {
				return busy;
			},
			submit: vi.fn(async (action: string) => {
				if (action === "start") busy = true;
			}),
			abort: vi.fn(async () => {
				busy = false;
			}),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockResolvedValue(runtime as unknown as ReasonerRuntime);

		const harness = createHarness();
		let failedAdmissionWrite = false;
		harness.appendEntry.mockImplementation((customType, data) => {
			if (
				customType === ROUTE_TRANSACTION_TYPE &&
				data?.phase === "admitted" &&
				!failedAdmissionWrite
			) {
				failedAdmissionWrite = true;
				throw new Error("cannot persist admission");
			}
		});
		await harness.startSession();
		await harness.exposeInput("run this once");

		await expect(
			harness.routeTool.execute("route-1", { action: "start" }, undefined, undefined, harness.ctx),
		).rejects.toThrow("cannot persist admission");
		await harness.emit("turn_start", { type: "turn_start" });
		const stopped = await harness.routeTool.execute(
			"route-2",
			{ action: "stop" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(runtime.submit).toHaveBeenCalledWith("start", "run this once", undefined);
		expect(stopped.details).toEqual({ acceptedCount: 0 });
		const records = harness.appendEntry.mock.calls
			.filter(([customType]) => customType === ROUTE_TRANSACTION_TYPE)
			.map(([, data]) => data);
		expect(records.some((record) => record.phase === "failed")).toBe(false);
		expect(records.some((record) => record.phase === "abandoned")).toBe(true);
	});

	it("contains settlement persistence failures and keeps their route blocked", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});

		const harness = createHarness();
		harness.appendEntry.mockImplementation((customType, data) => {
			if (customType === ROUTE_TRANSACTION_TYPE && data?.phase === "settled") {
				throw new Error("cannot persist settlement");
			}
		});
		await harness.startSession();
		await harness.exposeInput("first request");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(() => reasonerOptions.onSettled()).not.toThrow();
		await harness.exposeInput("must remain blocked");
		await expect(
			harness.routeTool.execute("route-2", { action: "start" }, undefined, undefined, harness.ctx),
		).rejects.toThrow("uncertain outcome");
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("could not persist reasoner route settlement"),
			"error",
		);
	});

	it("retries failed checkpoint persistence and contains callback write errors", async () => {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});

		const harness = createHarness();
		let checkpointWrites = 0;
		harness.appendEntry.mockImplementation((customType, data) => {
			if (customType === REASONER_STATE_TYPE && data?.mode === "linked") {
				checkpointWrites += 1;
				if (checkpointWrites === 1) throw new Error("cannot persist checkpoint");
			}
			if (customType === "duplex-reasoner-turn") {
				throw new Error("cannot persist turn");
			}
		});
		await harness.startSession();
		await harness.exposeInput("create reasoner");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
		const checkpoint = {
			sessionFile: `${process.cwd()}/package.json`,
			leafId: "reasoner-leaf",
		};

		expect(() => reasonerOptions.onCheckpoint(checkpoint)).not.toThrow();
		expect(() => reasonerOptions.onCheckpoint(checkpoint)).not.toThrow();
		expect(checkpointWrites).toBe(2);
		expect(() =>
			reasonerOptions.onTurn({
				sequence: 1,
				text: "completed answer",
				tools: [],
				timestamp: Date.now(),
			}),
		).not.toThrow();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("could not persist the reasoner checkpoint"),
			"error",
		);
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("could not persist the completed reasoner turn"),
			"error",
		);
	});
});

describe("pi-duplex compaction coordination", () => {
	function installReasonerMock() {
		let reasonerOptions: any;
		const runtime = {
			isBusy: false,
			submit: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			compact: vi.fn(async () => true),
			dispose: vi.fn(async () => undefined),
		};
		vi.spyOn(ReasonerRuntime, "create").mockImplementation(async (options) => {
			reasonerOptions = options;
			return runtime as unknown as ReasonerRuntime;
		});
		return { runtime, getReasonerOptions: () => reasonerOptions };
	}

	async function startReasoner(harness: ReturnType<typeof createHarness>): Promise<void> {
		await harness.startSession();
		await harness.exposeInput("start reasoner");
		await harness.routeTool.execute(
			"route-1",
			{ action: "start" },
			undefined,
			undefined,
			harness.ctx,
		);
	}

	it("makes Pi's ordinary manual /compact compact both sessions", async () => {
		const { runtime, getReasonerOptions } = installReasonerMock();
		const harness = createHarness();
		await startReasoner(harness);
		getReasonerOptions().onSettled();

		await harness.emit("session_before_compact", {
			type: "session_before_compact",
			reason: "manual",
			customInstructions: "preserve architectural decisions",
		});
		await harness.emit("session_compact", {
			type: "session_compact",
			reason: "manual",
			willRetry: false,
		});

		expect(runtime.compact).toHaveBeenCalledWith("preserve architectural decisions");
		expect(harness.notify).toHaveBeenCalledWith(
			"Foreground and reasoner contexts compacted.",
			"info",
		);
	});

	it("supports foreground-only and reasoner-only manual commands", async () => {
		const { runtime, getReasonerOptions } = installReasonerMock();
		const harness = createHarness();
		await startReasoner(harness);
		getReasonerOptions().onSettled();

		await harness.commands.get("compact-foreground").handler(
			"focus on UI decisions",
			harness.ctx,
		);
		expect(harness.compact).toHaveBeenCalledWith(
			expect.objectContaining({ customInstructions: "focus on UI decisions" }),
		);
		await harness.emit("session_before_compact", {
			type: "session_before_compact",
			reason: "manual",
			customInstructions: "focus on UI decisions",
		});
		await harness.emit("session_compact", {
			type: "session_compact",
			reason: "manual",
			willRetry: false,
		});
		expect(runtime.compact).not.toHaveBeenCalled();

		await harness.commands.get("compact-reasoner").handler(
			"focus on implementation state",
			harness.ctx,
		);
		expect(runtime.compact).toHaveBeenCalledWith("focus on implementation state");
		expect(harness.notify).toHaveBeenCalledWith("Reasoner context compacted.", "info");
	});

	it("leaves automatic foreground and reasoner compaction independent", async () => {
		const { runtime, getReasonerOptions } = installReasonerMock();
		const harness = createHarness();
		await startReasoner(harness);
		getReasonerOptions().onSettled();

		await harness.emit("session_before_compact", {
			type: "session_before_compact",
			reason: "threshold",
		});
		await harness.emit("session_compact", {
			type: "session_compact",
			reason: "threshold",
			willRetry: false,
		});

		expect(runtime.compact).not.toHaveBeenCalled();
	});

	it("discards a manual compaction plan when foreground compaction fails", async () => {
		const { runtime, getReasonerOptions } = installReasonerMock();
		const harness = createHarness();
		await startReasoner(harness);
		getReasonerOptions().onSettled();

		await harness.emit("session_before_compact", {
			type: "session_before_compact",
			reason: "manual",
			willRetry: false,
			customInstructions: "stale instructions",
		});
		await harness.emit("session_compact_failed", {
			type: "session_compact_failed",
			reason: "manual",
			aborted: false,
			willRetry: false,
			fromExtension: false,
			errorMessage: "provider failed",
		});
		await harness.emit("session_compact", {
			type: "session_compact",
			reason: "manual",
			willRetry: false,
		});

		expect(runtime.compact).not.toHaveBeenCalled();
	});
});

describe("installed extension mode boundaries", () => {
	it.each(["print", "json", "rpc"] as const)(
		"is inert in Pi %s mode",
		async (mode) => {
			const harness = createHarness([], { mode });
			await harness.startSession();

			expect(harness.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
			expect(harness.appendEntry).not.toHaveBeenCalled();
			const [beforeStart] = await harness.emit("before_agent_start", {
				type: "before_agent_start",
				systemPrompt: "ordinary Pi",
			});
			expect(beforeStart).toBeUndefined();
			await expect(
				harness.routeTool.execute(
					"route-1",
					{ action: "start" },
					undefined,
					undefined,
					harness.ctx,
				),
			).rejects.toThrow("persistent interactive Pi session");
		},
	);

	it("disables itself without changing ordinary Pi under --no-session", async () => {
		const harness = createHarness([], { persistent: false });
		await harness.startSession();

		expect(harness.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("disabled under --no-session"),
			"warning",
		);
		const [beforeStart] = await harness.emit("before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "ordinary Pi",
		});
		expect(beforeStart).toBeUndefined();
	});
});
