import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
	Container,
	Loader,
	Markdown,
	Text,
	type Component,
	type EditorComponent,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	CustomEditor,
	FooterComponent,
	getMarkdownTheme,
	ModelSelectorComponent,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ReasonerRouter, RouteDispatchError, type RouteReceipt } from "./controller.js";
import { ExactInputTracker } from "./input-tracker.js";
import {
	buildForegroundSnapshotContext,
	DELEGATION_ACCEPTED_INSTRUCTION,
	FOREGROUND_SYSTEM_PROMPT,
} from "./prompts.js";
import { withReasonerEscape } from "./reasoner-escape-editor.js";
import {
	defaultReasonerModel,
	findPersistedReasonerModel,
	persistedReasonerModel as reasonerModelState,
	REASONER_MODEL_STATE_TYPE,
} from "./reasoner-model-state.js";
import {
	buildReasonerOutputMessage,
	buildReasonerOutputMessageDetails,
	findUnmirroredReasonerPublicOutputs,
	REASONER_OUTPUT_MESSAGE,
	REASONER_TURN_ENTRY,
	toReasonerPublicOutput,
	type ReasonerPublicOutput,
} from "./public-context.js";
import {
	getConfiguredReasonerModel,
	getConfiguredReasonerThinkingLevel,
	ReasonerRuntime,
	type ReasonerRestorePoint,
} from "./reasoner-runtime.js";
import {
	findUnresolvedRouteTransactions,
	preparedRouteTransaction,
	ROUTE_TRANSACTION_TYPE,
	type RouteTransactionRecord,
	type PreparedRouteTransaction,
} from "./route-transactions.js";
import {
	findPersistedReasonerState,
	forkedReasonerState,
	linkedReasonerState,
	REASONER_STATE_TYPE,
	type PersistedReasonerState,
} from "./session-state.js";
import {
	isSyntheticReasonerStop,
	ROUTE_ACTIONS,
	type ReasonerSnapshot,
	type ReasonerToolActivity,
	type ReasonerTurn,
} from "./types.js";

const ROUTE_TOOL = "delegate";
const RUNTIME_SNAPSHOT_MESSAGE = "duplex-runtime-snapshot";
const REASONER_WIDGET = "duplex-reasoner-live";
const MAX_REASONER_PREVIEW_CHARACTERS = 4_000;
const MAX_REASONER_PREVIEW_LINES = 8;
const STOP_RECOVERY_BLOCKER = "stop";
const RESET_RECOVERY_BLOCKER = "reset";
const FOREGROUND_PERSISTENCE_BLOCKER = "foreground-persistence";

interface PendingManualCompaction {
	readonly includeReasoner: boolean;
	readonly customInstructions?: string;
	readonly signal: AbortSignal;
}

type ReasonerCompactionOutcome = "compacted" | "nothing" | "not-started";

const EMPTY_SNAPSHOT: ReasonerSnapshot = {
	state: "idle",
	phase: "not started",
	activeTools: [],
	queuedMessages: 0,
};

export default function duplexExtension(pi: ExtensionAPI): void {
	const inputTracker = new ExactInputTracker();
	let currentContext: ExtensionContext | undefined;
	let reasoner: ReasonerRuntime | undefined;
	let controller: ReasonerRouter | undefined;
	let reasonerPromise: Promise<ReasonerRuntime> | undefined;
	let restoreState: PersistedReasonerState | undefined;
	let latestSnapshot = EMPTY_SNAPSHOT;
	let pendingReasonerOutputs: ReasonerPublicOutput[] = [];
	let latestLiveText = "";
	let latestActiveTools: readonly ReasonerToolActivity[] = [];
	let widgetTimer: ReturnType<typeof setTimeout> | undefined;
	let activityWidget: ReasonerActivityWidget | undefined;
	let shuttingDown = false;
	let requestFooterRender: (() => void) | undefined;
	let runtimeGeneration = 0;
	let resetting = false;
	let duplexEnabled = false;
	let foregroundAgentActive = false;
	let foregroundOnlyCompactionRequested = false;
	let pendingManualCompaction: PendingManualCompaction | undefined;
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let duplexEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let escapeStopPromise: Promise<void> | undefined;
	let reasonerModelPreference: string | undefined;
	const recoveryBlockers = new Set<string>();
	let uncertainTransactions: PreparedRouteTransaction[] = [];
	const activeTransactionIds = new Set<string>();
	const cancellingTransactionIds = new Set<string>();

	pi.registerEntryRenderer<ReasonerTurn>(
		REASONER_TURN_ENTRY,
		(entry, { expanded }, theme) => renderReasonerTurn(entry.data, expanded, theme),
	);

	pi.registerCommand("reset-reasoner", {
		description: "Detach the saved reasoner and start fresh after a broken or uncertain run",
		handler: async (_args, ctx) => {
			if (!isDuplexContext(ctx)) {
				ctx.ui.notify(
					"pi-duplex is active only in a persistent interactive Pi session.",
					"warning",
				);
				return;
			}
			if (resetting) {
				ctx.ui.notify("A reasoner reset is already in progress.", "warning");
				return;
			}
			if (escapeStopPromise) {
				ctx.ui.notify("Wait for the reasoner to finish stopping.", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify(
					"Wait for the foreground turn and its queued messages to finish before running /reset-reasoner.",
					"warning",
				);
				return;
			}
			const hasContinuity =
				Boolean(restoreState && restoreState.mode !== "none") ||
				uncertainTransactions.length > 0 ||
				activeTransactionIds.size > 0 ||
				Boolean(reasoner) ||
				Boolean(reasonerPromise) ||
				Boolean(reasonerModelPreference) ||
				recoveryBlockers.size > 0;
			if (!hasContinuity) {
				ctx.ui.notify("There is no linked reasoner to reset.", "info");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Reset reasoner?",
				"This detaches (but does not delete) the saved reasoner, clears its model selection, stops current work, and abandons unresolved routes. The next reasoner uses PI_DUPLEX_REASONER_MODEL.",
			);
			if (!confirmed) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages() || escapeStopPromise) {
				ctx.ui.notify("Foreground activity changed; run /reset-reasoner again when it is idle.", "warning");
				return;
			}

			resetting = true;
			const cancellation = beginTransactionCancellation();
			try {
				// Clear a stale model preference before detaching the reasoner. If the
				// second write fails, the still-linked reasoner retains its own model.
				pi.appendEntry(REASONER_MODEL_STATE_TYPE, defaultReasonerModel());
				const detachedState: PersistedReasonerState = { version: 1, mode: "none" };
				pi.appendEntry(REASONER_STATE_TYPE, detachedState);
				restoreState = detachedState;
				reasonerModelPreference = undefined;
				await disposeReasoner();
				completeTransactionCancellation(cancellation, "Reset by user");
				abandonUncertainTransactions("Reset by user");
				recoveryBlockers.clear();
				inputTracker.reset();
				latestSnapshot = EMPTY_SNAPSHOT;
				pendingReasonerOutputs = [];
				latestLiveText = "";
				latestActiveTools = [];
				updateUi();
				requestFooterRender?.();
				ctx.ui.notify(
					"Detached the saved reasoner. The next routed request starts fresh with PI_DUPLEX_REASONER_MODEL.",
					"info",
				);
			} catch (error) {
				cancelTransactionCancellation(cancellation);
				recoveryBlockers.add(RESET_RECOVERY_BLOCKER);
				throw error;
			} finally {
				resetting = false;
			}
		},
	});

	pi.registerCommand("compact-foreground", {
		description: "Compact only the foreground Pi session",
		handler: async (args, ctx) => {
			if (!isDuplexContext(ctx)) {
				ctx.ui.notify("pi-duplex is active only in a persistent interactive Pi session.", "warning");
				return;
			}
			if (foregroundOnlyCompactionRequested) {
				ctx.ui.notify("A foreground compaction request is already pending.", "warning");
				return;
			}

			foregroundOnlyCompactionRequested = true;
			const customInstructions = normalizeCompactionInstructions(args);
			ctx.compact({
				...(customInstructions ? { customInstructions } : {}),
				onComplete: () => {
					foregroundOnlyCompactionRequested = false;
					ctx.ui.notify("Foreground context compacted.", "info");
				},
				onError: (error) => {
					foregroundOnlyCompactionRequested = false;
					if (pendingManualCompaction?.includeReasoner === false) {
						pendingManualCompaction = undefined;
					}
					ctx.ui.notify(`Foreground compaction failed: ${error.message}`, "error");
				},
			});
		},
	});

	pi.registerCommand("compact-reasoner", {
		description: "Compact only the persistent reasoner session",
		handler: async (args, ctx) => {
			if (!isDuplexContext(ctx)) {
				ctx.ui.notify("pi-duplex is active only in a persistent interactive Pi session.", "warning");
				return;
			}
			try {
				const outcome = await compactReasoner(
					ctx,
					normalizeCompactionInstructions(args),
					ctx.signal,
				);
				notifyReasonerCompactionOutcome(ctx, outcome);
			} catch (error) {
				if (isAbortError(error)) {
					ctx.ui.notify("Reasoner compaction cancelled.", "warning");
					return;
				}
				showRuntimeError(
					new Error(`Reasoner compaction failed: ${normalizeError(error).message}`, {
						cause: error,
					}),
				);
			}
		},
	});

	pi.registerCommand("reasoner-model", {
		description: "Select the model used by the reasoner",
		handler: async (args, ctx) => {
			if (!isDuplexContext(ctx)) {
				ctx.ui.notify("pi-duplex is active only in a persistent interactive Pi session.", "warning");
				return;
			}
			if (!ctx.isIdle() || foregroundAgentActive) {
				ctx.ui.notify("Wait for the foreground agent to finish before changing models.", "warning");
				return;
			}
			if (resetting) {
				ctx.ui.notify("Wait for the reasoner reset to finish.", "warning");
				return;
			}
			if (escapeStopPromise) {
				ctx.ui.notify("Wait for the reasoner to finish stopping.", "warning");
				return;
			}
			if (uncertainTransactions.length > 0 || recoveryBlockers.size > 0) {
				ctx.ui.notify(
					"Resolve the reasoner's interrupted state with /reset-reasoner before changing models.",
					"warning",
				);
				return;
			}
			if (reasonerPromise || reasoner?.isBusy) {
				ctx.ui.notify(
					"Wait for the reasoner to finish or press Escape twice to stop it first.",
					"warning",
				);
				return;
			}

			try {
				const activeReasoner = reasoner;
				const currentReference = getKnownReasonerModel();
				const resources = activeReasoner?.modelSelectionResources ??
					await ReasonerRuntime.createModelSelectionResources({
						...(currentReference ? { currentModel: currentReference } : {}),
						configureModelRuntime: (modelRuntime) =>
							configureReasonerModelRuntime(ctx, currentReference, modelRuntime),
					});
				const selected = await ctx.ui.custom<Model<any> | undefined>(
					(tui, _theme, _keybindings, done) =>
						new ModelSelectorComponent(
							tui,
							resources.currentModel,
							resources.modelRuntime,
							resources.scopedModels,
							(model) => done(model),
							() => done(undefined),
							args.trim() || undefined,
						),
				);
				if (!selected) return;
				if (shuttingDown || activeReasoner !== reasoner || reasonerPromise) return;
				if (activeReasoner?.isBusy) {
					ctx.ui.notify("The reasoner became busy; choose the model again when it is idle.", "warning");
					return;
				}
				// AgentSession.setModel() silently clamps the existing thinking level.
				// Validate an explicit user setting against the replacement model first.
				getConfiguredReasonerThinkingLevel(selected);
				const reference = `${selected.provider}/${selected.id}`;
				try {
					// Persist first so a failed foreground write cannot leave an
					// unrecorded mutation in the nested reasoner session.
					pi.appendEntry(REASONER_MODEL_STATE_TYPE, reasonerModelState(reference));
					reasonerModelPreference = reference;
				} catch (error) {
					// SessionManager mutates its in-memory branch before writing. Even
					// a thrown append can therefore become durable on a later write.
					handleForegroundPersistenceFailure("the reasoner model change", error);
					return;
				}

				let checkpoint: ReasonerRuntime["checkpoint"];
				try {
					checkpoint = activeReasoner
						? await activeReasoner.setModel(selected)
						: (await ensureReasoner(ctx)).checkpoint;
				} catch (error) {
					if (activeReasoner) {
						handleForegroundPersistenceFailure("the reasoner model change", error);
					} else {
						showRuntimeError(normalizeError(error));
					}
					return;
				}
				try {
					if (checkpoint) persistCheckpoint(checkpoint);
				} catch (error) {
					handleForegroundPersistenceFailure("the reasoner model checkpoint", error);
					return;
				}
				requestFooterRender?.();
				ctx.ui.notify(`Reasoner model: ${reference}`, "info");
			} catch (error) {
				showRuntimeError(normalizeError(error));
			}
		},
	});

	pi.registerTool({
		name: ROUTE_TOOL,
		label: "Reasoner",
		description:
			"Route the current submitted user message to the persistent reasoning agent. " +
			"Use this instead of answering or clarifying; afterward, at most give one short generic acknowledgment. " +
			"Choose only an action; this tool intentionally has no text/message argument because the harness forwards the exact input.",
		promptSnippet: "Route an exact submitted message to the persistent reasoning agent",
		renderShell: "self",
		parameters: Type.Object(
			{
				action: StringEnum(ROUTE_ACTIONS),
			},
			{ additionalProperties: false },
		),
		renderCall: () => new HiddenComponent(),
		renderResult: () => new HiddenComponent(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!isDuplexContext(ctx)) {
				throw new Error("pi-duplex is active only in a persistent interactive Pi session.");
			}
			const dispatchGeneration = runtimeGeneration;
			if (resetting) throw abortError("A reasoner reset is in progress.");
			if (params.action !== "stop") signal?.throwIfAborted();
			if (
				params.action !== "stop" &&
				(uncertainTransactions.length > 0 || recoveryBlockers.size > 0)
			) {
				throw new Error(
					"A route from an interrupted process has an uncertain outcome. Run /reset-reasoner, then resubmit the request.",
				);
			}

			const envelopes = inputTracker.claimForRoute();
			if (params.action !== "stop" && envelopes.length === 0) {
				throw new Error("No current submitted user message is available to route.");
			}

			const transaction =
				params.action === "stop"
					? undefined
					: preparedRouteTransaction(randomUUID(), params.action, envelopes);
			let transactionPrepared = false;
			let admissionRecordAttempted = false;
			let acceptedCount = 0;
			let cancellation: string[] = [];

			try {
				if (transaction) {
					appendRouteTransaction(transaction);
					transactionPrepared = true;
				}
				cancellation = params.action === "stop" ? beginTransactionCancellation() : [];

				let receipt: RouteReceipt;
				if (params.action === "stop" && !reasoner && !reasonerPromise) {
					receipt = { acceptedCount: envelopes.length };
				} else {
					if (dispatchGeneration !== runtimeGeneration) {
						throw abortError("Reasoner dispatch was superseded by a session reset.");
					}
					const activeReasoner = await ensureReasoner(ctx);
					if (dispatchGeneration !== runtimeGeneration) {
						throw abortError("Reasoner dispatch was superseded by a session reset.");
					}
					controller ??= new ReasonerRouter(activeReasoner);
					if (params.action !== "stop") signal?.throwIfAborted();
					receipt = await controller.route(
						params.action,
						envelopes,
						params.action === "stop" ? undefined : signal,
					);
				}

				if (transaction) {
					acceptedCount = receipt.acceptedCount;
					// Track accepted work before the durable admission write. If that write
					// fails, settlement must still terminate the prepared transaction and
					// the accepted envelopes must never be offered for retry.
					activeTransactionIds.add(transaction.id);
					admissionRecordAttempted = true;
					appendRouteTransaction({
						version: 1,
						id: transaction.id,
						phase: "admitted",
						acceptedCount: receipt.acceptedCount,
						timestamp: Date.now(),
					});
				} else {
					completeTransactionCancellation(cancellation, "Stopped by user");
					for (const id of cancellation) recoveryBlockers.delete(routeRecoveryBlocker(id));
					recoveryBlockers.delete(STOP_RECOVERY_BLOCKER);
				}

				return {
					content: [{ type: "text", text: DELEGATION_ACCEPTED_INSTRUCTION }],
					details: receipt,
				};
			} catch (error) {
				let normalized = normalizeError(error);
				acceptedCount = Math.max(
					acceptedCount,
					error instanceof RouteDispatchError ? error.dispatchedCount : 0,
				);
				if (transaction) {
					if (acceptedCount > 0) {
						activeTransactionIds.add(transaction.id);
						if (transactionPrepared && !admissionRecordAttempted) {
							const persistenceError = tryAppendRouteTransaction({
								version: 1,
								id: transaction.id,
								phase: "admitted",
								acceptedCount,
								timestamp: Date.now(),
							});
							if (persistenceError) {
								recoveryBlockers.add(routeRecoveryBlocker(transaction.id));
								normalized = routePersistenceError(normalized, persistenceError);
							}
						}
					} else {
						activeTransactionIds.delete(transaction.id);
						if (transactionPrepared) {
							const persistenceError = tryAppendTerminalRouteTransaction(
								transaction.id,
								"failed",
								normalized.message,
							);
							if (persistenceError) {
								recoveryBlockers.add(routeRecoveryBlocker(transaction.id));
								normalized = routePersistenceError(normalized, persistenceError);
							}
						}
					}
					if (!transactionPrepared || admissionRecordAttempted) {
						// A failed prepare write may already have advanced Pi's in-memory
						// append-only branch, and a failed admission write leaves accepted work
						// without a known-durable record. Require an explicit reset either way.
						recoveryBlockers.add(routeRecoveryBlocker(transaction.id));
					}
				}
				if (params.action === "stop") {
					cancelTransactionCancellation(cancellation);
					for (const id of cancellation) {
						if (activeTransactionIds.has(id)) {
							recoveryBlockers.add(routeRecoveryBlocker(id));
						}
					}
					recoveryBlockers.add(STOP_RECOVERY_BLOCKER);
				}
				if (dispatchGeneration === runtimeGeneration) {
					inputTracker.releaseForRetry(envelopes.slice(acceptedCount));
				}
				if (!isExpectedRouteCancellation(error, signal)) showRuntimeError(normalized);
				throw normalized;
			}
		},
	});

	pi.on("input", (event, ctx) => {
		if (!isDuplexContext(ctx)) return { action: "continue" };
		if (event.source === "extension") {
			inputTracker.observe(event.streamingBehavior);
			return { action: "continue" };
		}
		if (resetting) {
			if (ctx.hasUI) ctx.ui.notify("Wait for the reasoner reset to finish.", "warning");
			return { action: "handled" } as const;
		}
		inputTracker.capture(event.text, event.images, event.streamingBehavior);
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		inputTracker.acceptIdlePrompt();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${FOREGROUND_SYSTEM_PROMPT}`,
		};
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		inputTracker.beginTurn();
	});

	pi.on("message_start", (event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		if (event.message.role !== "user") return;
		inputTracker.markNextUserMessageVisible();
	});

	pi.on("turn_end", (event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		inputTracker.endTurn(isSuccessfulForegroundTurn(event.message));
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		foregroundAgentActive = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		foregroundAgentActive = false;
		inputTracker.settle();
		flushReasonerOutputMessages();
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!isDuplexContext(ctx) || event.reason !== "manual") return;
		const includeReasoner = !foregroundOnlyCompactionRequested;
		foregroundOnlyCompactionRequested = false;
		pendingManualCompaction = {
			includeReasoner,
			signal: event.signal,
			...(event.customInstructions
				? { customInstructions: event.customInstructions }
				: {}),
		};
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		flushReasonerOutputMessages();
		if (event.reason !== "manual") return;
		const plan = pendingManualCompaction;
		pendingManualCompaction = undefined;
		if (!plan) return;
		if (plan.includeReasoner === false) return;

		try {
			const outcome = await compactReasoner(
				ctx,
				plan?.customInstructions,
				plan?.signal,
			);
			if (outcome === "compacted") {
				ctx.ui.notify("Foreground and reasoner contexts compacted.", "info");
			} else if (outcome === "nothing") {
				ctx.ui.notify(
					"Foreground context compacted; the reasoner had nothing additional to compact.",
					"info",
				);
			} else {
				ctx.ui.notify(
					"Foreground context compacted; no reasoner session has started yet.",
					"info",
				);
			}
		} catch (error) {
			if (isAbortError(error)) {
				ctx.ui.notify("Foreground context compacted; reasoner compaction was cancelled.", "warning");
				return;
			}
			showRuntimeError(
				new Error(
					`Foreground context compacted, but reasoner compaction failed: ${normalizeError(error).message}`,
					{ cause: error },
				),
			);
		}
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (!isDuplexContext(ctx) || event.reason !== "manual") return;
		pendingManualCompaction = undefined;
	});

	pi.on("context", (event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		const messages = event.messages.filter(
			(message) => !(message.role === "custom" && message.customType === RUNTIME_SNAPSHOT_MESSAGE),
		);
		messages.push({
			role: "custom",
			customType: RUNTIME_SNAPSHOT_MESSAGE,
			content: buildForegroundSnapshotContext(latestSnapshot),
			display: false,
			timestamp: Date.now(),
		});
		return { messages };
	});

	pi.on("session_start", (event, ctx) => {
		shuttingDown = false;
		duplexEnabled = ctx.mode === "tui" && Boolean(ctx.sessionManager.getSessionFile());
		inputTracker.reset();
		latestSnapshot = EMPTY_SNAPSHOT;
		pendingReasonerOutputs = [];
		latestLiveText = "";
		latestActiveTools = [];
		activityWidget = undefined;
		activeTransactionIds.clear();
		cancellingTransactionIds.clear();
		resetting = false;
		foregroundAgentActive = false;
		foregroundOnlyCompactionRequested = false;
		pendingManualCompaction = undefined;
		escapeStopPromise = undefined;
		reasonerModelPreference = undefined;
		recoveryBlockers.clear();

		if (!duplexEnabled) {
			currentContext = undefined;
			restoreState = undefined;
			uncertainTransactions = [];
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== ROUTE_TOOL));
			if (ctx.mode === "tui" && ctx.hasUI) {
				ctx.ui.notify(
					"pi-duplex requires a persistent session and is disabled under --no-session.",
					"warning",
				);
			}
			return;
		}

		currentContext = ctx;
		const activeBranch = ctx.sessionManager.getBranch();
		reasonerModelPreference = selectedReasonerModel(activeBranch);
		pendingReasonerOutputs = findUnmirroredReasonerPublicOutputs(
			ctx.sessionManager.buildContextEntries(),
		);
		uncertainTransactions = findUnresolvedRouteTransactions(activeBranch);
		pi.setActiveTools([ROUTE_TOOL]);

		const activeState = findPersistedReasonerState(activeBranch);
		if (event.reason === "fork") {
			restoreState = forkedReasonerState(activeState);
			pi.appendEntry(REASONER_STATE_TYPE, restoreState);
		} else {
			restoreState = activeState;
		}
		try {
			getEffectiveReasonerModel();
		} catch (error) {
			ctx.ui.notify(normalizeError(error).message, "error");
		}

		installFooter(ctx);
		installEscapeHandling(ctx);
		updateUi();
		flushReasonerOutputMessages();

		notifyUncertainTransactions(ctx);
	});

	pi.on("session_before_switch", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		if (!isReasonerTransitionUnsafe()) return;
		notifyBusyNavigation(ctx);
		return { cancel: true };
	});

	pi.on("session_before_fork", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		if (!isReasonerTransitionUnsafe()) return;
		notifyBusyNavigation(ctx);
		return { cancel: true };
	});

	pi.on("session_before_tree", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		if (!isReasonerTransitionUnsafe()) return;
		notifyBusyNavigation(ctx);
		return { cancel: true };
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		await disposeReasoner();
		const activeBranch = ctx.sessionManager.getBranch();
		restoreState = findPersistedReasonerState(activeBranch);
		reasonerModelPreference = selectedReasonerModel(activeBranch);
		pendingReasonerOutputs = findUnmirroredReasonerPublicOutputs(
			ctx.sessionManager.buildContextEntries(),
		);
		uncertainTransactions = findUnresolvedRouteTransactions(activeBranch);
		activeTransactionIds.clear();
		cancellingTransactionIds.clear();
		recoveryBlockers.clear();
		inputTracker.reset();
		latestSnapshot = EMPTY_SNAPSHOT;
		latestLiveText = "";
		latestActiveTools = [];
		foregroundAgentActive = false;
		updateUi();
		requestFooterRender?.();
		flushReasonerOutputMessages();
		notifyUncertainTransactions(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		requestFooterRender?.();
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		requestFooterRender?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!isDuplexContext(ctx)) return;
		shuttingDown = true;
		let cancellation: string[] = [];
		if (widgetTimer) clearTimeout(widgetTimer);
		widgetTimer = undefined;
		if (currentContext?.mode === "tui") {
			currentContext.ui.setWidget(REASONER_WIDGET, undefined);
			currentContext.ui.setFooter(undefined);
			restoreEditor(currentContext);
		}
		activityWidget = undefined;
		requestFooterRender = undefined;
		try {
			await escapeStopPromise;
			cancellation = beginTransactionCancellation();
			await disposeReasoner();
			completeTransactionCancellation(cancellation, "Foreground session closed");
		} catch (error) {
			cancelTransactionCancellation(cancellation);
			throw error;
		}
		currentContext = undefined;
		duplexEnabled = false;
		pendingReasonerOutputs = [];
		foregroundAgentActive = false;
		foregroundOnlyCompactionRequested = false;
		pendingManualCompaction = undefined;
		escapeStopPromise = undefined;
		reasonerModelPreference = undefined;
	});

	async function ensureReasoner(ctx: ExtensionContext): Promise<ReasonerRuntime> {
		if (resetting) throw abortError("A reasoner reset is in progress.");
		if (reasoner) return reasoner;
		if (reasonerPromise) return reasonerPromise;

		latestSnapshot = {
			...EMPTY_SNAPSHOT,
			state: "working",
			phase: "initializing",
		};
		scheduleUiUpdate();

		const requestedModel = getEffectiveReasonerModel();
		const restore = toRestorePoint(restoreState, reasonerModelPreference);
		const generation = runtimeGeneration;
		const creation = ReasonerRuntime.create({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			model: requestedModel,
			configureModelRuntime: (modelRuntime) =>
				configureReasonerModelRuntime(ctx, requestedModel, modelRuntime),
			...(restore ? { restore } : {}),
			onSnapshot(snapshot, liveText, activeTools) {
				if (shuttingDown || generation !== runtimeGeneration) return;
				latestSnapshot = snapshot;
				latestLiveText = liveText;
				latestActiveTools = activeTools;
				scheduleUiUpdate();
			},
			onTurn(turn) {
				if (shuttingDown || generation !== runtimeGeneration) return;
				try {
					publishReasonerTurn(turn);
				} catch (error) {
					handleForegroundPersistenceFailure("the completed reasoner turn", error);
				}
			},
			onCheckpoint(checkpoint) {
				if (shuttingDown || generation !== runtimeGeneration) return;
				try {
					persistCheckpoint(checkpoint);
				} catch (error) {
					handleForegroundPersistenceFailure("the reasoner checkpoint", error);
				}
			},
			onSettled() {
				if (shuttingDown || generation !== runtimeGeneration) return;
				settleActiveTransactions();
			},
			onError(error) {
				if (shuttingDown || generation !== runtimeGeneration) return;
				showRuntimeError(error);
			},
		})
			.then(async (created) => {
				if (shuttingDown || generation !== runtimeGeneration) {
					await created.dispose();
					throw new Error("The reasoner start was superseded by a session reset or shutdown.");
				}
				reasoner = created;
				return created;
			})
			.finally(() => {
				if (reasonerPromise === creation) reasonerPromise = undefined;
			});
		reasonerPromise = creation;

		return creation;
	}

	async function compactReasoner(
		ctx: ExtensionContext,
		customInstructions?: string,
		signal?: AbortSignal,
	): Promise<ReasonerCompactionOutcome> {
		if (resetting) throw abortError("A reasoner reset is in progress.");
		if (uncertainTransactions.length > 0 || recoveryBlockers.size > 0) {
			throw new Error("Reasoner state is uncertain; resolve recovery before compacting it.");
		}
		const hasReasonerSession =
			Boolean(reasoner) ||
			Boolean(reasonerPromise) ||
			Boolean(restoreState && restoreState.mode !== "none");
		if (!hasReasonerSession) return "not-started";

		const activeReasoner = await ensureReasoner(ctx);
		const compacted = signal
			? await activeReasoner.compact(customInstructions, signal)
			: await activeReasoner.compact(customInstructions);
		return compacted ? "compacted" : "nothing";
	}

	function notifyReasonerCompactionOutcome(
		ctx: ExtensionContext,
		outcome: ReasonerCompactionOutcome,
	): void {
		if (outcome === "compacted") {
			ctx.ui.notify("Reasoner context compacted.", "info");
		} else if (outcome === "nothing") {
			ctx.ui.notify("The reasoner has nothing additional to compact.", "info");
		} else {
			ctx.ui.notify("No reasoner session has started yet.", "info");
		}
	}

	function publishReasonerTurn(turn: ReasonerTurn): void {
		const persistenceErrors: Error[] = [];
		if (turn.checkpoint) {
			try {
				persistCheckpoint(turn.checkpoint);
			} catch (error) {
				persistenceErrors.push(normalizeError(error));
			}
		}
		try {
			pi.appendEntry<ReasonerTurn>(REASONER_TURN_ENTRY, turn);
		} catch (error) {
			persistenceErrors.push(normalizeError(error));
		}
		queueReasonerOutputMessage(toReasonerPublicOutput(turn));
		latestLiveText = "";
		latestActiveTools = [];
		updateUi();
		requestFooterRender?.();
		if (persistenceErrors.length > 0) {
			throw new AggregateError(
				persistenceErrors,
				"One or more foreground session writes failed while publishing a reasoner turn.",
			);
		}
	}

	function queueReasonerOutputMessage(output: ReasonerPublicOutput): void {
		pendingReasonerOutputs.push(output);
		flushReasonerOutputMessages();
	}

	function flushReasonerOutputMessages(): void {
		const ctx = currentContext;
		if (
			!duplexEnabled ||
			shuttingDown ||
			foregroundAgentActive ||
			!ctx ||
			!ctx.isIdle()
		) {
			return;
		}

		while (pendingReasonerOutputs.length > 0) {
			const output = pendingReasonerOutputs[0];
			if (!output) return;
			try {
				pi.sendMessage(
					{
						customType: REASONER_OUTPUT_MESSAGE,
						content: buildReasonerOutputMessage(output),
						display: false,
						details: buildReasonerOutputMessageDetails(output),
					},
					{ triggerTurn: false },
				);
				pendingReasonerOutputs.shift();
			} catch (error) {
				handleForegroundPersistenceFailure("a reasoner context message", error);
				return;
			}
		}
	}

	function persistCheckpoint(checkpoint: NonNullable<ReasonerTurn["checkpoint"]>): void {
		if (!existsSync(checkpoint.sessionFile)) return;
		if (
			restoreState?.mode === "linked" &&
			restoreState.sessionFile === checkpoint.sessionFile &&
			restoreState.leafId === checkpoint.leafId
		) {
			return;
		}
		const linkedState = linkedReasonerState(checkpoint);
		pi.appendEntry(REASONER_STATE_TYPE, linkedState);
		restoreState = linkedState;
	}

	async function disposeReasoner(): Promise<void> {
		runtimeGeneration += 1;
		const pendingCreation = reasonerPromise;
		reasonerPromise = undefined;
		const pending = pendingCreation ? await pendingCreation.catch(() => undefined) : undefined;
		const activeReasoner = reasoner ?? pending;
		reasoner = undefined;
		controller = undefined;
		await activeReasoner?.dispose();
	}

	function appendRouteTransaction(record: RouteTransactionRecord): void {
		pi.appendEntry<RouteTransactionRecord>(ROUTE_TRANSACTION_TYPE, record);
	}

	function tryAppendRouteTransaction(record: RouteTransactionRecord): Error | undefined {
		try {
			appendRouteTransaction(record);
			return undefined;
		} catch (error) {
			return normalizeError(error);
		}
	}

	function appendTerminalRouteTransaction(
		id: string,
		phase: "settled" | "failed" | "abandoned",
		reason?: string,
	): void {
		appendRouteTransaction({
			version: 1,
			id,
			phase,
			...(reason ? { reason } : {}),
			timestamp: Date.now(),
		});
	}

	function tryAppendTerminalRouteTransaction(
		id: string,
		phase: "settled" | "failed" | "abandoned",
		reason?: string,
	): Error | undefined {
		try {
			appendTerminalRouteTransaction(id, phase, reason);
			return undefined;
		} catch (error) {
			return normalizeError(error);
		}
	}

	function settleActiveTransactions(): void {
		let firstPersistenceError: Error | undefined;
		let failedWrites = 0;
		for (const id of activeTransactionIds) {
			if (cancellingTransactionIds.has(id)) continue;
			const persistenceError = tryAppendTerminalRouteTransaction(id, "settled");
			if (persistenceError) {
				recoveryBlockers.add(routeRecoveryBlocker(id));
				firstPersistenceError ??= persistenceError;
				failedWrites += 1;
				continue;
			}
			activeTransactionIds.delete(id);
			recoveryBlockers.delete(routeRecoveryBlocker(id));
		}
		if (failedWrites === 0 && cancellingTransactionIds.size === 0) {
			recoveryBlockers.delete(STOP_RECOVERY_BLOCKER);
		}
		if (firstPersistenceError) {
			const suffix = failedWrites === 1 ? "" : ` (${failedWrites} writes failed)`;
			showRuntimeError(
				new Error(
					`pi-duplex could not persist reasoner route settlement${suffix}: ${firstPersistenceError.message}`,
					{ cause: firstPersistenceError },
				),
			);
		}
	}

	function handleForegroundPersistenceFailure(scope: string, error: unknown): void {
		const normalized = normalizeError(error);
		recoveryBlockers.add(FOREGROUND_PERSISTENCE_BLOCKER);
		showRuntimeError(
			new Error(`pi-duplex could not persist ${scope}: ${normalized.message}`, { cause: normalized }),
		);
	}

	function beginTransactionCancellation(): string[] {
		const ids = [...activeTransactionIds];
		for (const id of ids) cancellingTransactionIds.add(id);
		return ids;
	}

	function completeTransactionCancellation(ids: readonly string[], reason: string): void {
		for (const id of ids) {
			appendTerminalRouteTransaction(id, "abandoned", reason);
			activeTransactionIds.delete(id);
			cancellingTransactionIds.delete(id);
		}
	}

	function cancelTransactionCancellation(ids: readonly string[]): void {
		for (const id of ids) cancellingTransactionIds.delete(id);
	}

	function abandonUncertainTransactions(reason: string): void {
		for (const transaction of uncertainTransactions) {
			appendTerminalRouteTransaction(transaction.id, "abandoned", reason);
		}
		uncertainTransactions = [];
	}

	function notifyUncertainTransactions(ctx: ExtensionContext): void {
		if (!ctx.hasUI || uncertainTransactions.length === 0) return;
		const noun = uncertainTransactions.length === 1 ? "route has" : "routes have";
		ctx.ui.notify(
			`${uncertainTransactions.length} reasoner ${noun} an uncertain outcome after an interrupted process. Run /reset-reasoner, then resubmit anything still needed.`,
			"warning",
		);
	}

	function showRuntimeError(error: Error): void {
		if (currentContext?.hasUI) currentContext.ui.notify(error.message, "error");
		latestSnapshot = {
			...latestSnapshot,
			state: "error",
			phase: "error",
		};
		updateUi();
		requestFooterRender?.();
	}

	function scheduleUiUpdate(): void {
		if (widgetTimer) return;
		widgetTimer = setTimeout(() => {
			widgetTimer = undefined;
			updateUi();
			requestFooterRender?.();
		}, 40);
	}

	function updateUi(): void {
		const ctx = currentContext;
		if (!ctx || ctx.mode !== "tui") return;

		const isActive = latestSnapshot.state === "working" || latestSnapshot.state === "stopping";
		if (!isActive && !latestLiveText.trim()) {
			ctx.ui.setWidget(REASONER_WIDGET, undefined);
			activityWidget = undefined;
			return;
		}

		const visibleText = truncateLiveText(latestLiveText);
		if (activityWidget) {
			activityWidget.update(latestSnapshot, visibleText, latestActiveTools);
			return;
		}

		ctx.ui.setWidget(REASONER_WIDGET, (tui, theme) => {
			activityWidget = new ReasonerActivityWidget(
				tui,
				theme,
				latestSnapshot,
				visibleText,
				latestActiveTools,
			);
			return activityWidget;
		});
	}

	function installFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const sessionProxy = createFooterSessionProxy(
				ctx,
				() => latestSnapshot,
				() => reasonerModelPreference ?? savedReasonerModel(restoreState),
			);
			const footer = new FooterComponent(sessionProxy, footerData);
			// ExtensionContext does not expose the foreground compaction setting.
			// Omit the native `(auto)` claim rather than defaulting it to a lie.
			footer.setAutoCompactEnabled(false);
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				render: (width: number) => footer.render(width),
				invalidate: () => footer.invalidate(),
				dispose: () => {
					unsubscribeBranch();
					footer.dispose();
					requestFooterRender = undefined;
				},
			};
		});
	}

	function installEscapeHandling(ctx: ExtensionContext): void {
		previousEditorFactory = ctx.ui.getEditorComponent();
		duplexEditorFactory = (tui, theme, keybindings): EditorComponent => {
			const base = previousEditorFactory?.(tui, theme, keybindings) ??
				new CustomEditor(tui, theme, keybindings);
			return withReasonerEscape(
				base,
				() =>
					ctx.isIdle() &&
					!foregroundAgentActive &&
					!escapeStopPromise &&
					(Boolean(reasonerPromise) || Boolean(reasoner?.isBusy)),
				() => stopReasonerFromEscape(),
			);
		};
		ctx.ui.setEditorComponent(duplexEditorFactory);
	}

	function restoreEditor(ctx: ExtensionContext): void {
		if (duplexEditorFactory && ctx.ui.getEditorComponent() === duplexEditorFactory) {
			ctx.ui.setEditorComponent(previousEditorFactory);
		}
		previousEditorFactory = undefined;
		duplexEditorFactory = undefined;
	}

	function stopReasonerFromEscape(): void {
		if (escapeStopPromise) return;
		const operation = stopReasonerWork("Stopped with Escape").catch((error) => {
			showRuntimeError(normalizeError(error));
		});
		let tracked!: Promise<void>;
		tracked = operation.finally(() => {
			if (escapeStopPromise === tracked) escapeStopPromise = undefined;
		});
		escapeStopPromise = tracked;
	}

	async function stopReasonerWork(reason: string): Promise<void> {
		const pending = reasonerPromise;
		const activeReasoner = reasoner ?? (pending ? await pending : undefined);
		if (!activeReasoner) return;

		const cancellation = beginTransactionCancellation();
		try {
			controller ??= new ReasonerRouter(activeReasoner);
			await controller.route("stop", []);
			completeTransactionCancellation(cancellation, reason);
			for (const id of cancellation) recoveryBlockers.delete(routeRecoveryBlocker(id));
			recoveryBlockers.delete(STOP_RECOVERY_BLOCKER);
		} catch (error) {
			cancelTransactionCancellation(cancellation);
			for (const id of cancellation) {
				if (activeTransactionIds.has(id)) recoveryBlockers.add(routeRecoveryBlocker(id));
			}
			recoveryBlockers.add(STOP_RECOVERY_BLOCKER);
			throw error;
		}
	}

	function getEffectiveReasonerModel(): string {
		return reasonerModelPreference ?? savedReasonerModel(restoreState) ??
			getConfiguredReasonerModel();
	}

	function getKnownReasonerModel(): string | undefined {
		try {
			return getEffectiveReasonerModel();
		} catch {
			return undefined;
		}
	}

	async function configureReasonerModelRuntime(
		ctx: ExtensionContext,
		requestedModel: string | undefined,
		modelRuntime: ModelRuntime,
	): Promise<void> {
		const registeredProviders = ctx.modelRegistry.getRegisteredProviderIds();
		for (const providerId of registeredProviders) {
			const provider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
			if (provider) {
				modelRuntime.registerNativeProvider(provider);
				continue;
			}
			const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
			if (config) modelRuntime.registerProvider(providerId, config);
		}

		// Pi's --api-key is an in-memory override rather than stored auth.
		// Copy only runtime credentials, never resolved OAuth or environment keys.
		const runtimeProviders = new Set([
			ctx.model?.provider,
			requestedModel ? modelProvider(requestedModel) : undefined,
			...registeredProviders,
		]);
		for (const providerId of runtimeProviders) {
			if (!providerId) continue;
			if (ctx.modelRegistry.getProviderAuthStatus(providerId).source !== "runtime") continue;
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
			if (apiKey) await modelRuntime.setRuntimeApiKey(providerId, apiKey);
		}
	}

	function selectedReasonerModel(entries: readonly SessionEntry[]): string | undefined {
		const selection = findPersistedReasonerModel(entries);
		return selection?.mode === "selected" ? selection.reference : undefined;
	}

	function isReasonerTransitionUnsafe(): boolean {
		return resetting || Boolean(escapeStopPromise) || Boolean(reasonerPromise) ||
			Boolean(reasoner?.isBusy);
	}

	function isDuplexContext(ctx: ExtensionContext): boolean {
		return duplexEnabled && ctx.mode === "tui";
	}
}

class HiddenComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

class ReasonerActivityWidget implements Component {
	private readonly preview: Markdown;
	private readonly loader: Loader;
	private liveText: string;

	constructor(
		private readonly tui: TUI,
		theme: Theme,
		snapshot: ReasonerSnapshot,
		liveText: string,
		activeTools: readonly ReasonerToolActivity[],
	) {
		this.liveText = liveText;
		this.preview = new Markdown(liveText, 1, 0, getMarkdownTheme(), {
			color: (value) => theme.fg("accent", value),
		});
		this.loader = new Loader(
			tui,
			(value) => theme.fg("accent", value),
			(value) => theme.fg("dim", value),
			formatReasonerActivity(snapshot, activeTools),
		);
	}

	update(
		snapshot: ReasonerSnapshot,
		liveText: string,
		activeTools: readonly ReasonerToolActivity[],
	): void {
		this.liveText = liveText;
		this.preview.setText(liveText);
		this.loader.setMessage(formatReasonerActivity(snapshot, activeTools));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const previewLines = this.liveText.trim()
			? this.preview.render(width).slice(-MAX_REASONER_PREVIEW_LINES)
			: [];
		// Loader extends Text and can wrap a long tool summary into many rows. Keep
		// the live widget bounded even in a narrow terminal.
		return [...previewLines, ...this.loader.render(width).slice(0, 2)];
	}

	invalidate(): void {
		this.preview.invalidate();
		this.loader.invalidate();
	}

	dispose(): void {
		this.loader.stop();
	}
}

function renderReasonerTurn(
	turn: ReasonerTurn | undefined,
	expanded: boolean,
	theme: Theme,
): Component | undefined {
	if (!turn) return undefined;
	const container = new Container();
	if (!isSyntheticReasonerStop(turn)) {
		container.addChild(
			new Markdown(turn.text, 1, 0, getMarkdownTheme(), {
				color: (value) => theme.fg("accent", value),
			}),
		);
	}

	const status = formatTurnStatus(turn);
	if (status) {
		container.addChild(
			new Text(theme.fg(turn.errorMessage ? "error" : "warning", status), 1, 0),
		);
	}

	if (expanded && turn.tools.length > 0) {
		for (const tool of turn.tools) {
			const color = tool.isError ? "error" : "dim";
			container.addChild(new Text(theme.fg(color, `↳ ${tool.summary}`), 1, 0));
		}
	}

	if (expanded && turn.errorMessage && !turn.text.includes(turn.errorMessage)) {
		container.addChild(new Text(theme.fg("error", turn.errorMessage), 1, 0));
	}
	return container;
}

function formatTurnStatus(turn: ReasonerTurn): string | undefined {
	if (turn.errorMessage) return "Reasoner error";
	if (turn.stopReason === "aborted") return "Reasoner stopped";
	if (turn.superseded) return "Superseded by a newer user instruction";
	return undefined;
}

function formatReasonerActivity(
	snapshot: ReasonerSnapshot,
	activeTools: readonly ReasonerToolActivity[],
): string {
	const queue = snapshot.queuedMessages > 0 ? ` · ${snapshot.queuedMessages} queued` : "";
	if (activeTools.length > 0) {
		const firstTool = activeTools[0]?.summary.slice(0, 160) ?? "using tools";
		const more = activeTools.length > 1 ? ` +${activeTools.length - 1}` : "";
		return `Reasoner · ${firstTool}${more}${queue}`;
	}
	if (snapshot.activeTools.length > 0) {
		return `Reasoner · using ${snapshot.activeTools.join(", ")}${queue}`;
	}
	if (snapshot.state === "stopping") return "Reasoner · stopping";
	if (snapshot.phase === "initializing") return "Reasoner · initializing";
	if (snapshot.phase === "responding") return `Reasoner · responding${queue}`;
	if (snapshot.phase === "steering") return `Reasoner · incorporating update${queue}`;
	if (snapshot.phase === "queued follow-up") return `Reasoner · queueing follow-up${queue}`;
	if (snapshot.phase === "compacting context") return "Reasoner · compacting context";
	return `Reasoner · thinking${queue}`;
}

function truncateLiveText(text: string, maxCharacters = MAX_REASONER_PREVIEW_CHARACTERS): string {
	if (text.length <= maxCharacters) return text;
	return `…\n${text.slice(-maxCharacters)}`;
}

function toRestorePoint(
	state: PersistedReasonerState | undefined,
	preferredModel?: string,
): ReasonerRestorePoint | undefined {
	if (!state || state.mode === "none") return undefined;
	const model = preferredModel ?? state.model;
	if (state.mode === "linked") {
		return {
			sessionFile: state.sessionFile,
			leafId: state.leafId,
			fork: false,
			...(model ? { model } : {}),
		};
	}
	return {
		sessionFile: state.sourceSessionFile,
		leafId: state.sourceLeafId,
		fork: true,
		...(model ? { model } : {}),
	};
}

function savedReasonerModel(state: PersistedReasonerState | undefined): string | undefined {
	return state && state.mode !== "none" ? state.model : undefined;
}

function modelProvider(reference: string): string {
	const separator = reference.indexOf("/");
	return separator > 0 ? reference.slice(0, separator) : reference;
}

function isSuccessfulForegroundTurn(message: unknown): boolean {
	if (!message || typeof message !== "object" || !("role" in message)) return true;
	if (message.role !== "assistant" || !("stopReason" in message)) return true;
	return !["aborted", "error", "length"].includes(String(message.stopReason));
}

function notifyBusyNavigation(ctx: ExtensionContext): void {
	if (ctx.hasUI) {
		ctx.ui.notify("Stop or wait for the reasoning agent before changing session branches.", "warning");
	}
}

function createFooterSessionProxy(
	ctx: ExtensionContext,
	getReasonerSnapshot: () => ReasonerSnapshot,
	getPersistedReasonerModel: () => string | undefined,
): AgentSession {
	return {
		get state() {
			const foregroundModel = ctx.model;
			if (!foregroundModel) return { model: undefined };
			const foregroundThinking = foregroundModel.reasoning
				? ` · ${ctx.thinkingLevel ?? "off"}`
				: "";
			const reasonerModel = formatReasonerModel(
				getReasonerSnapshot(),
				getPersistedReasonerModel(),
			);
			return {
				model: {
					...foregroundModel,
					id: `${foregroundModel.id}${foregroundThinking}  ·  reasoner ${reasonerModel}`,
					reasoning: false,
				},
				thinkingLevel: "off",
			};
		},
		sessionManager: ctx.sessionManager,
		getContextUsage: () => ctx.getContextUsage(),
		modelRuntime: {
			isUsingSubscription: (provider: string) => {
				if (ctx.model?.provider !== provider) return false;
				try {
					return ctx.modelRegistry.isUsingOAuth(ctx.model) &&
						ctx.modelRegistry.getProvider(provider)?.auth.oauth?.isSubscription === true;
				} catch {
					return false;
				}
			},
		},
	} as unknown as AgentSession;
}

function formatReasonerModel(
	snapshot: ReasonerSnapshot,
	persistedModel?: string,
): string {
	let reference = snapshot.model ?? persistedModel;
	if (!reference) {
		try {
			reference = getConfiguredReasonerModel();
		} catch {
			return "not configured";
		}
	}
	return reference.replaceAll(/[\u0000-\u001f\u007f]/g, " ").slice(0, 96);
}

function normalizeCompactionInstructions(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed || undefined;
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function routePersistenceError(routeError: Error, persistenceError: Error): Error {
	if (routeError === persistenceError) return routeError;
	return new Error(
		`${routeError.message} pi-duplex also could not persist the route outcome: ${persistenceError.message}`,
		{ cause: persistenceError },
	);
}

function routeRecoveryBlocker(transactionId: string): string {
	return `route:${transactionId}`;
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function isExpectedRouteCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	if (
		error instanceof RouteDispatchError &&
		error.message === "Reasoner dispatch was superseded by a stop request."
	) {
		return true;
	}
	const candidate = error instanceof RouteDispatchError ? error.cause : error;
	return candidate instanceof Error && candidate.name === "AbortError";
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error &&
		(error.name === "AbortError" || error.message === "Compaction cancelled");
}
