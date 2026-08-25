import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	getSupportedThinkingLevels,
	type ImageContent,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "./guards.js";
import { REASONER_SYSTEM_PROMPT } from "./prompts.js";
import {
	REASONER_STOPPED_FALLBACK,
	type ReasonerCheckpoint,
	type ReasonerSnapshot,
	type ReasonerToolActivity,
	type ReasonerTurn,
	type RouteAction,
} from "./types.js";

const DEFAULT_REASONER_THINKING = "max";
const MAX_TOOL_SUMMARY_CHARACTERS = 240;

export interface ReasonerRestorePoint {
	readonly sessionFile: string;
	readonly leafId: string;
	readonly fork: boolean;
	readonly model?: string;
}

export interface ReasonerRuntimeOptions {
	cwd: string;
	projectTrusted: boolean;
	model: string;
	configureModelRuntime?: (runtime: ModelRuntime) => Promise<void> | void;
	restore?: ReasonerRestorePoint;
	onSnapshot?: (
		snapshot: ReasonerSnapshot,
		liveText: string,
		activeTools: readonly ReasonerToolActivity[],
	) => void;
	onTurn?: (turn: ReasonerTurn) => void;
	onCheckpoint?: (checkpoint: ReasonerCheckpoint) => void;
	onSettled?: () => void;
	onError?: (error: Error) => void;
}

export interface ReasonerModelSelectionOptions {
	readonly currentModel?: string;
	readonly configureModelRuntime?: (runtime: ModelRuntime) => Promise<void> | void;
}

interface MutableToolActivity {
	id: string;
	name: string;
	summary: string;
	isError: boolean;
}

interface DeferredSubmission {
	text: string;
	images?: ImageContent[];
	phase: string;
	streamingBehavior: "steer" | "followUp";
	resolve: () => void;
	reject: (error: Error) => void;
}

export class ReasonerRuntime {
	private readonly activeTools = new Map<string, MutableToolActivity>();
	private turnTools: MutableToolActivity[] = [];
	private liveText = "";
	private state: ReasonerSnapshot["state"] = "idle";
	private phase = "idle";
	private queuedMessages = 0;
	private pendingSteering = 0;
	private hasError = false;
	private turnSequence = 0;
	private pendingTerminalTurn: ReasonerTurn | undefined;
	private readonly pendingFullRuns = new Set<Promise<void>>();
	private readonly deferredSubmissions: DeferredSubmission[] = [];
	private manualCompactionPromise: Promise<boolean> | undefined;
	private manualCompactionAbortController: AbortController | undefined;
	private manualCompactionActive = false;
	private postRunBoundary = false;
	private flushingDeferred = false;
	private disposing = false;
	private disposePromise: Promise<void> | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(
		private readonly session: AgentSession,
		private readonly options: ReasonerRuntimeOptions,
	) {
		this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
		this.emitSnapshot();
	}

	static async create(options: ReasonerRuntimeOptions): Promise<ReasonerRuntime> {
		const agentDir = getAgentDir();
		const modelRuntime = await createReasonerModelRuntime(options.configureModelRuntime);

		// A nested file-backed SettingsManager defaults projectTrusted to true and
		// can resolve/install project-configured packages during resource reload.
		// Keep nested settings isolated and propagate trust only to context files.
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: options.projectTrusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: !options.projectTrusted,
			appendSystemPrompt: [REASONER_SYSTEM_PROMPT],
		});
		await resourceLoader.reload();

		const reasonerDir = join(agentDir, "duplex", "reasoners");
		ensurePrivateDirectory(reasonerDir);
		const sessionManager = createReasonerSessionManager(options, reasonerDir);
		// A first entry gives every foreground link a concrete checkpoint.
		if (!sessionManager.getLeafId()) sessionManager.appendSessionInfo("pi-duplex reasoner");
		// A restored reasoner owns its saved model selection. The environment value
		// is only the default for a new reasoner, just as Pi restores its own model.
		const restoredModel = options.restore
			? options.restore.model ?? formatSessionModel(sessionManager.buildSessionContext().model)
			: undefined;
		const model = resolveReasonerModel(
			modelRuntime,
			parseReasonerModel(restoredModel ?? options.model),
		);
		const thinkingLevel = getConfiguredReasonerThinkingLevel(model);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: options.cwd,
			agentDir,
			modelRuntime,
			model,
			thinkingLevel,
			tools: ["read", "bash", "edit", "write"],
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		const startupError = modelFallbackMessage ??
			(!session.model
				? "The reasoner has no available model."
				: !modelRuntime.hasConfiguredAuth(session.model.provider)
					? `No credentials are configured for ${session.model.provider}. Use Pi's /login or configure its API key, then retry.`
					: undefined);
		if (startupError) {
			session.dispose();
			throw new Error(startupError);
		}
		makeSessionFilePrivate(session.sessionFile);

		return new ReasonerRuntime(session, options);
	}

	static async createModelSelectionResources(options: ReasonerModelSelectionOptions = {}) {
		const modelRuntime = await createReasonerModelRuntime(options.configureModelRuntime);
		let currentModel: Model<any> | undefined;
		if (options.currentModel) {
			try {
				const requested = parseReasonerModel(options.currentModel);
				currentModel = modelRuntime.getModel(requested.provider, requested.id);
			} catch {
				// A malformed or retired saved model must not prevent opening the picker.
			}
		}
		return {
			currentModel,
			modelRuntime,
			scopedModels: [],
		};
	}

	get isBusy(): boolean {
		return (
			this.state === "working" ||
			this.state === "stopping" ||
			this.session.isStreaming ||
			this.pendingFullRuns.size > 0 ||
			Boolean(this.manualCompactionPromise) ||
			this.deferredSubmissions.length > 0
		);
	}

	get checkpoint(): ReasonerCheckpoint | undefined {
		const sessionFile = this.session.sessionFile;
		const leafId = this.session.sessionManager.getLeafId();
		const model = this.session.model
			? `${this.session.model.provider}/${this.session.model.id}`
			: undefined;
		return sessionFile && leafId
			? { sessionFile, leafId, ...(model ? { model } : {}) }
			: undefined;
	}

	get snapshot(): ReasonerSnapshot {
		const model = this.session.model
			? `${this.session.model.provider}/${this.session.model.id}`
			: undefined;
		return {
			state: this.state,
			phase: this.phase,
			...(model ? { model } : {}),
			activeTools: [...this.activeTools.values()].map((tool) => tool.name),
			queuedMessages: this.queuedMessages,
		};
	}

	get modelSelectionResources() {
		return {
			currentModel: this.session.model,
			modelRuntime: this.session.modelRuntime,
			scopedModels: this.session.scopedModels,
		};
	}

	async setModel(model: Model<any>): Promise<ReasonerCheckpoint | undefined> {
		if (this.isBusy) throw new Error("Wait for the reasoner to finish or stop it first.");
		await this.session.setModel(model);
		this.emitSnapshot();
		return this.checkpoint;
	}

	/** Resolve after Pi admits or queues the message while supervising the run. */
	submit(
		action: Exclude<RouteAction, "stop">,
		text: string,
		images?: ImageContent[],
	): Promise<void> {
		const phase =
			action === "start" ? "starting" : action === "steer" ? "steering" : "queued follow-up";
		return this.submitMessage(text, images, phase, action === "queue" ? "followUp" : "steer");
	}

	/**
	 * AgentSession.prompt() chooses start-versus-queue atomically. Direct
	 * steer()/followUp() calls can orphan a message if the session becomes idle
	 * between the controller's occupancy check and queue admission.
	 */
	private submitMessage(
		text: string,
		images: ImageContent[] | undefined,
		phase: string,
		streamingBehavior: "steer" | "followUp",
	): Promise<void> {
		if (this.disposing) return Promise.reject(abortError("The reasoner is shutting down."));
		if (this.postRunBoundary || this.flushingDeferred || this.manualCompactionPromise) {
			this.markWorking(this.manualCompactionPromise ? "queued behind compaction" : phase);
			return new Promise<void>((resolve, reject) => {
				this.deferredSubmissions.push({
					text,
					...(images ? { images: [...images] } : {}),
					phase,
					streamingBehavior,
					resolve,
					reject,
				});
			});
		}
		return this.startSubmission(text, images, phase, streamingBehavior);
	}

	private startSubmission(
		text: string,
		images: ImageContent[] | undefined,
		phase: string,
		streamingBehavior: "steer" | "followUp",
	): Promise<void> {
		if (this.disposing) return Promise.reject(abortError("The reasoner is shutting down."));
		this.markWorking(phase);
		let admitted = false;
		let admissionSettled = false;
		let resolveAdmission!: () => void;
		let rejectAdmission!: (error: Error) => void;
		const admission = new Promise<void>((resolveAdmissionPromise, rejectAdmissionPromise) => {
			resolveAdmission = () => {
				if (admissionSettled) return;
				admissionSettled = true;
				resolveAdmissionPromise();
			};
			rejectAdmission = (error) => {
				if (admissionSettled) return;
				admissionSettled = true;
				rejectAdmissionPromise(error);
			};
		});

		const fullRun = this.session.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior,
			...(images ? { images } : {}),
			preflightResult: (success) => {
				if (!success || admitted) return;
				admitted = true;
				if (this.disposing) {
					rejectAdmission(abortError("The reasoner was reset before prompt delivery."));
					queueMicrotask(() => {
						this.session.clearQueue();
						this.session.abortCompaction();
						void this.session.abort().catch(() => undefined);
					});
				} else {
					resolveAdmission();
				}
			},
		});
		this.pendingFullRuns.add(fullRun);

		void fullRun.then(
			() => {
				this.pendingFullRuns.delete(fullRun);
				// Defensive fallback for a future Pi path that completes without calling
				// preflightResult after handling the input internally.
				if (!admitted) {
					admitted = true;
					if (this.disposing) {
						rejectAdmission(abortError("The reasoner was reset before prompt delivery."));
					} else {
						resolveAdmission();
					}
				}
			},
			(error: unknown) => {
				this.pendingFullRuns.delete(fullRun);
				const normalized = normalizeError(error);
				if (!this.disposing) this.fail(normalized, admitted);
				if (!admitted) rejectAdmission(normalized);
			},
		);

		return admission;
	}

	/** Compact at the next idle boundary without aborting active reasoner work. */
	compact(customInstructions?: string, externalSignal?: AbortSignal): Promise<boolean> {
		if (this.disposing) return Promise.reject(abortError("The reasoner is shutting down."));
		if (this.manualCompactionPromise) return this.manualCompactionPromise;
		if (externalSignal?.aborted) {
			return Promise.reject(abortError("Reasoner compaction was cancelled."));
		}

		const abortController = new AbortController();
		const relayExternalAbort = () => abortController.abort();
		externalSignal?.addEventListener("abort", relayExternalAbort, { once: true });
		this.manualCompactionAbortController = abortController;
		const operation = this.compactOnce(customInstructions, abortController.signal);
		const tracked = operation.finally(() => {
			externalSignal?.removeEventListener("abort", relayExternalAbort);
			if (this.manualCompactionPromise === tracked) {
				this.manualCompactionPromise = undefined;
				this.manualCompactionAbortController = undefined;
			}
			if (!this.disposing && this.deferredSubmissions.length > 0) {
				void this.flushDeferredSubmissions();
			}
		});
		this.manualCompactionPromise = tracked;
		return tracked;
	}

	private async compactOnce(
		customInstructions: string | undefined,
		signal: AbortSignal,
	): Promise<boolean> {
		this.manualCompactionActive = true;
		this.markWorking(this.session.isIdle ? "compacting context" : "waiting to compact context");
		try {
			signal.throwIfAborted();
			await waitForIdleOrAbort(this.session, signal);
			signal.throwIfAborted();
			if (this.disposing) throw abortError("The reasoner is shutting down.");
			this.markWorking("compacting context");
			const abortActiveCompaction = () => this.session.abortCompaction();
			signal.addEventListener("abort", abortActiveCompaction, { once: true });
			try {
				await this.session.compact(customInstructions);
			} finally {
				signal.removeEventListener("abort", abortActiveCompaction);
			}
			this.resetIdleState();
			return true;
		} catch (error) {
			const normalized = normalizeError(error);
			if (isManualCompactionNoop(normalized.message)) {
				this.resetIdleState();
				return false;
			}
			if (normalized.name === "AbortError" || normalized.message === "Compaction cancelled") {
				this.resetIdleState();
				throw normalized;
			}
			this.fail(normalized, false);
			throw normalized;
		} finally {
			this.manualCompactionActive = false;
		}
	}

	async abort(): Promise<void> {
		this.state = "stopping";
		this.phase = "stopping";
		this.touch();
		try {
			this.rejectDeferredSubmissions(abortError("Reasoner work was stopped."));
			this.manualCompactionAbortController?.abort();
			this.session.clearQueue();
			this.session.abortCompaction();
			await this.session.abort();
			const pendingCompaction = this.manualCompactionPromise;
			await Promise.allSettled([
				...this.pendingFullRuns,
				...(pendingCompaction ? [pendingCompaction] : []),
			]);
			this.resetIdleState();
		} catch (error) {
			const normalized = normalizeError(error);
			this.fail(normalized, false);
			throw normalized;
		}
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeOnce();
		return this.disposePromise;
	}

	private async disposeOnce(): Promise<void> {
		this.disposing = true;
		this.rejectDeferredSubmissions(abortError("The reasoner session was reset."));
		this.manualCompactionAbortController?.abort();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session.clearQueue();
		this.session.abortCompaction();
		if (!this.session.isIdle) await this.session.abort().catch(() => undefined);
		const pendingCompaction = this.manualCompactionPromise;
		await Promise.allSettled([
			...this.pendingFullRuns,
			...(pendingCompaction ? [pendingCompaction] : []),
		]);
		// A prompt may cross preflight after the first idle check. Its preflight
		// callback schedules an abort; make the final state quiescent before dispose.
		this.session.clearQueue();
		this.session.abortCompaction();
		if (!this.session.isIdle) await this.session.abort().catch(() => undefined);
		this.session.dispose();
	}

	private handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.postRunBoundary = false;
				this.turnTools = [];
				this.pendingTerminalTurn = undefined;
				this.markWorking("thinking");
				void this.flushDeferredSubmissions();
				break;
			case "message_start":
				if (isAssistantMessage(event.message)) {
					this.liveText = extractAssistantText(event.message);
					this.phase = this.liveText ? "responding" : "thinking";
					this.touch();
				}
				break;
			case "message_update":
				if (isAssistantMessage(event.message)) {
					this.liveText = extractAssistantText(event.message);
					if (event.assistantMessageEvent.type === "text_delta") this.phase = "responding";
					else if (event.assistantMessageEvent.type === "thinking_delta" && !this.liveText) {
						this.phase = "thinking";
					}
					this.touch();
				}
				break;
			case "tool_execution_start": {
				const activity: MutableToolActivity = {
					id: event.toolCallId,
					name: event.toolName,
					summary: summarizeToolCall(event.toolName, event.args),
					isError: false,
				};
				this.activeTools.set(event.toolCallId, activity);
				this.turnTools.push(activity);
				this.phase = `using ${event.toolName}`;
				this.touch();
				break;
			}
			case "tool_execution_end": {
				const activity = this.activeTools.get(event.toolCallId) ??
					[...this.turnTools].reverse().find((tool) => tool.id === event.toolCallId);
				if (activity) activity.isError = event.isError;
				this.activeTools.delete(event.toolCallId);
				this.phase = this.activeTools.size > 0 ? "using tools" : "thinking";
				this.touch();
				break;
			}
			case "turn_end":
				this.handleTurnEnd(event.message);
				break;
			case "agent_end":
				this.postRunBoundary = true;
				this.handleAgentEnd(event.willRetry);
				break;
			case "queue_update":
				this.pendingSteering = event.steering.length;
				this.queuedMessages = event.steering.length + event.followUp.length;
				this.touch();
				break;
			case "compaction_start":
				this.markWorking("compacting context");
				break;
			case "compaction_end":
				this.handleCompactionEnd(
					event.reason,
					event.willRetry,
					event.aborted,
					event.errorMessage,
				);
				this.emitCheckpoint();
				break;
			case "auto_retry_start":
				this.markWorking(`retrying ${event.attempt}/${event.maxAttempts}`);
				break;
			case "auto_retry_end":
				if (event.success) {
					this.hasError = false;
					this.markWorking("thinking");
				} else if (event.finalError && (this.pendingTerminalTurn || !this.hasError)) {
					this.finalizePendingTerminal(event.finalError);
				}
				break;
			case "agent_settled":
				this.postRunBoundary = false;
				if (this.pendingTerminalTurn) this.finalizePendingTerminal();
				this.state = this.hasError ? "error" : "idle";
				this.phase = this.hasError ? "error" : "idle";
				this.queuedMessages = 0;
				this.pendingSteering = 0;
				this.liveText = "";
				this.activeTools.clear();
				this.turnTools = [];
				this.touch();
				this.emitCheckpoint();
				this.options.onSettled?.();
				if (this.deferredSubmissions.length > 0) {
					void this.flushDeferredSubmissions();
				}
				break;
		}
	}

	private handleTurnEnd(message: unknown): void {
		if (!isAssistantMessage(message)) return;
		const text = extractAssistantText(message).trim();
		const stopReason = message.stopReason;
		// Pi attaches an explanatory errorMessage to cancellation. Cancellation is
		// a control outcome, not a provider/runtime failure.
		const errorMessage = stopReason === "aborted" ? undefined : message.errorMessage;
		if (!text && !errorMessage && stopReason !== "aborted") {
			this.liveText = "";
			this.touch();
			return;
		}

		const checkpoint = this.checkpoint;
		const turn: ReasonerTurn = {
			sequence: ++this.turnSequence,
			text: text || (stopReason === "aborted" ? REASONER_STOPPED_FALLBACK : `I couldn't continue: ${errorMessage}`),
			tools: this.turnTools.map((tool): ReasonerToolActivity => ({
				summary: tool.summary,
				isError: tool.isError,
			})),
			stopReason,
			...(errorMessage ? { errorMessage } : {}),
			superseded: this.pendingSteering > 0,
			...(checkpoint ? { checkpoint } : {}),
			timestamp: Date.now(),
		};

		if (stopReason === "aborted") {
			this.options.onTurn?.(turn);
			this.turnTools = [];
		} else if (stopReason === "error" || stopReason === "length" || errorMessage) {
			this.pendingTerminalTurn = turn;
		} else {
			this.options.onTurn?.(turn);
			this.turnTools = [];
		}
		this.liveText = "";
		this.touch();
	}

	private handleAgentEnd(willRetry: boolean): void {
		const pending = this.pendingTerminalTurn;
		if (!pending) return;
		if (willRetry) {
			this.pendingTerminalTurn = undefined;
			this.hasError = false;
			this.markWorking("retrying");
			return;
		}
		// Keep terminal-looking errors pending until compaction has had a chance
		// to recover context overflow. agent_settled finalizes ordinary failures.
	}

	private handleCompactionEnd(
		reason: "manual" | "threshold" | "overflow",
		willRetry: boolean,
		aborted: boolean,
		errorMessage?: string,
	): void {
		if (reason === "manual" && this.manualCompactionActive) {
			if (aborted) {
				this.pendingTerminalTurn = undefined;
				this.turnTools = [];
				this.touch();
				return;
			}
			if (errorMessage && !isManualCompactionNoop(errorMessage)) {
				this.state = "error";
				this.phase = "error";
				this.hasError = true;
				this.touch();
				return;
			}
			this.resetIdleState();
			return;
		}
		if (aborted) {
			// STOP can abort overflow recovery after the failed/truncated turn has
			// been staged. That staged turn is part of the cancelled operation, not
			// a terminal context-limit failure that should reach the transcript.
			this.pendingTerminalTurn = undefined;
			this.turnTools = [];
			this.touch();
			return;
		}
		if (this.pendingTerminalTurn?.stopReason === "length") {
			if (willRetry) {
				this.pendingTerminalTurn = undefined;
				this.hasError = false;
				this.markWorking("retrying after compaction");
				return;
			}
			this.finalizePendingTerminal(errorMessage ?? "The reasoner reached its context limit.");
			return;
		}
		if (errorMessage && !willRetry) {
			if (this.pendingTerminalTurn) this.finalizePendingTerminal(errorMessage);
			else this.fail(new Error(errorMessage), true);
		}
		else this.markWorking("thinking");
	}

	private async flushDeferredSubmissions(): Promise<void> {
		if (this.flushingDeferred || this.disposing || this.manualCompactionPromise) return;
		this.flushingDeferred = true;
		try {
			while (!this.disposing) {
				const submission = this.deferredSubmissions.shift();
				if (!submission) break;
				try {
					await this.startSubmission(
						submission.text,
						submission.images,
						submission.phase,
						submission.streamingBehavior,
					);
					submission.resolve();
				} catch (error) {
					submission.reject(normalizeError(error));
				}
			}
		} finally {
			this.flushingDeferred = false;
		}
	}

	private rejectDeferredSubmissions(error: Error): void {
		for (const submission of this.deferredSubmissions.splice(0)) submission.reject(error);
	}

	private finalizePendingTerminal(errorOverride?: string): void {
		const pending = this.pendingTerminalTurn;
		if (!pending) {
			if (errorOverride) this.fail(new Error(errorOverride), true);
			return;
		}

		const errorMessage = errorOverride ?? pending.errorMessage ?? pending.text;
		const finalTurn: ReasonerTurn = errorOverride
			? {
					...pending,
					text: pending.text.startsWith("I couldn't continue:")
						? `I couldn't continue: ${errorOverride}`
						: pending.text,
					errorMessage: errorOverride,
				}
			: pending;
		this.options.onTurn?.(finalTurn);
		this.pendingTerminalTurn = undefined;
		this.turnTools = [];
		this.state = "error";
		this.phase = "error";
		this.hasError = true;
		this.options.onError?.(new Error(errorMessage));
		this.touch();
	}

	private markWorking(phase: string): void {
		this.state = "working";
		this.phase = phase;
		this.hasError = false;
		this.touch();
	}

	private fail(error: Error, report: boolean): void {
		this.state = "error";
		this.phase = "error";
		this.hasError = true;
		this.touch();
		if (report) this.options.onError?.(error);
	}

	private resetIdleState(): void {
		this.state = "idle";
		this.phase = "idle";
		this.hasError = false;
		this.liveText = "";
		this.queuedMessages = 0;
		this.pendingSteering = 0;
		this.pendingTerminalTurn = undefined;
		this.activeTools.clear();
		this.turnTools = [];
		this.touch();
	}

	private touch(): void {
		this.emitSnapshot();
	}

	private emitSnapshot(): void {
		this.options.onSnapshot?.(
			this.snapshot,
			this.liveText,
			[...this.activeTools.values()].map((tool) => ({
				summary: tool.summary,
				isError: tool.isError,
			})),
		);
	}

	private emitCheckpoint(): void {
		const checkpoint = this.checkpoint;
		if (checkpoint) this.options.onCheckpoint?.(checkpoint);
	}
}

function createReasonerSessionManager(
	options: ReasonerRuntimeOptions,
	reasonerDir: string,
): SessionManager {
	if (!options.restore) return SessionManager.create(options.cwd, reasonerDir);

	const restoredPath = validateRestoredPath(options.restore.sessionFile, reasonerDir);
	const source = SessionManager.open(restoredPath, reasonerDir, options.cwd);
	validateSessionHeader(source, options.cwd);

	if (!source.getEntry(options.restore.leafId)) {
		throw new Error("The saved reasoner checkpoint no longer exists.");
	}
	if (options.restore.fork) {
		const forkedPath = source.createBranchedSession(options.restore.leafId);
		if (!forkedPath) throw new Error("Could not create a persistent reasoner fork.");
		makeSessionFilePrivate(forkedPath);
		const forked = SessionManager.open(forkedPath, reasonerDir, options.cwd);
		validateSessionHeader(forked, options.cwd);
		return forked;
	}
	source.branch(options.restore.leafId);
	return source;
}

function validateRestoredPath(path: string, reasonerDir: string): string {
	if (!existsSync(path)) throw new Error("The saved reasoner session no longer exists.");
	if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || !path.endsWith(".jsonl")) {
		throw new Error("The saved reasoner session is not a regular JSONL file.");
	}

	const realDirectory = realpathSync(reasonerDir);
	const realPath = realpathSync(path);
	const pathFromDirectory = relative(realDirectory, realPath);
	if (
		pathFromDirectory === "" ||
		pathFromDirectory === ".." ||
		pathFromDirectory.startsWith(`..${sep}`) ||
		isAbsolute(pathFromDirectory)
	) {
		throw new Error("The saved reasoner session is outside pi-duplex's session directory.");
	}
	return realPath;
}

function validateSessionHeader(sessionManager: SessionManager, cwd: string): void {
	const header = sessionManager.getHeader();
	if (!header || resolve(header.cwd) !== resolve(cwd)) {
		throw new Error("The saved reasoner session belongs to a different workspace.");
	}
}

function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	try {
		chmodSync(path, 0o700);
	} catch {
		// Windows and restrictive filesystems may not expose POSIX permissions.
	}
}

function makeSessionFilePrivate(path: string | undefined): void {
	if (!path) return;
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort on non-POSIX filesystems.
	}
}

export function getConfiguredReasonerModel(): string {
	return parseReasonerModel(requireReasonerModelSetting()).reference;
}

function requireReasonerModelSetting(): string {
	const value = process.env.PI_DUPLEX_REASONER_MODEL;
	if (!value?.trim()) {
		throw new Error(
			"PI_DUPLEX_REASONER_MODEL is required. Set it to a provider/model before starting Pi.",
		);
	}
	return value;
}

function parseReasonerModel(value: string): {
	provider: string;
	id: string;
	reference: string;
} {
	const trimmed = value.trim();
	const reference = trimmed;
	const separator = reference.indexOf("/");
	const provider = reference.slice(0, separator).trim();
	const id = reference.slice(separator + 1).trim();
	if (separator <= 0 || !provider || !id) {
		throw new Error(
			`Invalid PI_DUPLEX_REASONER_MODEL=${JSON.stringify(reference)}. Expected provider/model.`,
		);
	}
	return { provider, id, reference: `${provider}/${id}` };
}

function formatSessionModel(
	model: { provider: string; modelId: string } | null,
): string | undefined {
	return model ? `${model.provider}/${model.modelId}` : undefined;
}

function resolveReasonerModel(
	modelRuntime: ModelRuntime,
	requested: ReturnType<typeof parseReasonerModel>,
): Model<any> {
	const model = modelRuntime.getModel(requested.provider, requested.id);
	if (!model) {
		const available = modelRuntime
			.getModels(requested.provider)
			.map((candidate) => candidate.id)
			.sort()
			.join(", ");
		throw new Error(
			`Reasoner model ${requested.reference} is unavailable.` +
				(available ? ` Available models: ${available}.` : ""),
		);
	}
	if (!modelRuntime.hasConfiguredAuth(requested.provider)) {
		throw new Error(
			`No credentials are configured for ${requested.provider}. Use Pi's /login or configure its API key, then retry.`,
		);
	}
	return model;
}

type PiThinkingLevel = NonNullable<
	NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

export function getConfiguredReasonerThinkingLevel(model: Model<any>): PiThinkingLevel {
	const configured = process.env.PI_DUPLEX_REASONER_THINKING?.trim();
	if (!configured) return DEFAULT_REASONER_THINKING as PiThinkingLevel;

	const supported = getSupportedThinkingLevels(model);
	if (!supported.includes(configured as PiThinkingLevel)) {
		throw new Error(
			`PI_DUPLEX_REASONER_THINKING=${JSON.stringify(configured)} is not supported by ` +
				`${model.provider}/${model.id}. Supported levels: ${supported.join(", ")}.`,
		);
	}
	return configured as PiThinkingLevel;
}

async function createReasonerModelRuntime(
	configure?: (runtime: ModelRuntime) => Promise<void> | void,
): Promise<ModelRuntime> {
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	await configure?.(modelRuntime);
	await modelRuntime.refresh({ allowNetwork: false });
	return modelRuntime;
}

function summarizeToolCall(name: string, args: unknown): string {
	const record = isRecord(args) ? args : {};
	let detail = "";
	if (name === "bash" && typeof record.command === "string") detail = record.command;
	else if (
		(name === "read" || name === "edit" || name === "write") &&
		typeof record.path === "string"
	) {
		detail = record.path;
	}

	const cleanDetail = sanitizeSingleLine(detail, MAX_TOOL_SUMMARY_CHARACTERS);
	return cleanDetail ? `${name} ${cleanDetail}` : name;
}

function sanitizeSingleLine(value: string, limit: number): string {
	const cleaned = value
		.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replaceAll(/[\u0000-\u001f\u007f]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim();
	return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isManualCompactionNoop(message: string): boolean {
	return message.includes("Nothing to compact") || message.includes("Already compacted");
}

async function waitForIdleOrAbort(session: AgentSession, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw abortError("Reasoner compaction was cancelled.");
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => rejectAbort(abortError("Reasoner compaction was cancelled."));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([session.waitForIdle(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function isAssistantMessage(message: unknown): message is {
	role: "assistant";
	content: Array<{ type: string; text?: string }>;
	stopReason: string;
	errorMessage?: string;
} {
	if (!message || typeof message !== "object") return false;
	const candidate = message as { role?: unknown; content?: unknown };
	return candidate.role === "assistant" && Array.isArray(candidate.content);
}

function extractAssistantText(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("");
}
