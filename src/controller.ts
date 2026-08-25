import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExactUserEnvelope, RouteAction } from "./types.js";

export interface ReasonerPort {
	readonly isBusy: boolean;
	/** Resolves when Pi admits or queues the message, not when the run ends. */
	submit(
		action: Exclude<RouteAction, "stop">,
		text: string,
		images?: ImageContent[],
	): Promise<void>;
	abort(): Promise<void>;
}

export interface RouteReceipt {
	readonly acceptedCount: number;
}

export class RouteDispatchError extends Error {
	constructor(
		message: string,
		readonly dispatchedCount: number,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "RouteDispatchError";
	}
}

/**
 * Serializes foreground routing decisions onto Pi's session admission APIs.
 * Only the short admission/queue step is awaited; the full reasoning run stays
 * supervised by ReasonerRuntime so the foreground remains duplex-responsive.
 */
export class ReasonerRouter {
	private admissionBarrier: Promise<void> = Promise.resolve();
	private pendingStops = 0;

	constructor(private readonly reasoner: ReasonerPort) {}

	route(
		action: RouteAction,
		envelopes: readonly ExactUserEnvelope[],
		signal?: AbortSignal,
	): Promise<RouteReceipt> {
		const isStop = action === "stop";
		if (isStop) this.pendingStops += 1;

		const admission = this.admissionBarrier.then(() =>
			this.routeNow(action, envelopes, isStop ? undefined : signal),
		);
		// STOP is a controller-level cancellation request, so it must survive a
		// route tool whose foreground AbortSignal has already been cancelled. Keep
		// the latch set until the serialized abort attempt itself has settled.
		const operation = isStop
			? admission.finally(() => {
					this.pendingStops -= 1;
				})
			: admission;

		this.admissionBarrier = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async routeNow(
		action: RouteAction,
		envelopes: readonly ExactUserEnvelope[],
		signal?: AbortSignal,
	): Promise<RouteReceipt> {
		if (action === "stop") {
			await this.reasoner.abort();
			return { acceptedCount: envelopes.length };
		}

		signal?.throwIfAborted();

		if (envelopes.length === 0) {
			throw new Error("No submitted user message is available for this routing turn.");
		}

		let logicallyBusy = this.reasoner.isBusy;
		for (const [index, envelope] of envelopes.entries()) {
			try {
				signal?.throwIfAborted();
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				throw new RouteDispatchError(normalized.message, index, { cause: normalized });
			}
			if (this.pendingStops > 0) {
				throw new RouteDispatchError("Reasoner dispatch was superseded by a stop request.", index);
			}

			let effectiveAction: Exclude<RouteAction, "stop">;

			if (!logicallyBusy) {
				effectiveAction = "start";
				logicallyBusy = true;
			} else if (action === "queue") {
				effectiveAction = "queue";
			} else {
				// START while work is active is safely normalized to a steer.
				effectiveAction = "steer";
			}

			try {
				await this.reasoner.submit(effectiveAction, envelope.text, envelope.images);
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				throw new RouteDispatchError(normalized.message, index, { cause: normalized });
			}

		}

		return { acceptedCount: envelopes.length };
	}
}
