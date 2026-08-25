import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExactUserEnvelope } from "./types.js";

/**
 * Keeps the model out of the payload path while following Pi's actual delivery
 * order. Captured input is not routable until Pi emits a user message_start,
 * which proves that the foreground model can see that submission.
 *
 * Idle prompts are accepted in before_agent_start. This also lets a later idle
 * prompt replace an earlier prompt that failed Pi preflight and emitted no agent
 * events. Streaming prompts enter Pi's steer/follow-up queues immediately and
 * become visible one at a time (or all at once) as Pi delivers them.
 */
export class ExactInputTracker {
	private nextSequence = 1;
	private idleCandidate: PendingDelivery | undefined;
	private awaitingDelivery: PendingDelivery[] = [];
	private visibleThisTurn: ExactUserEnvelope[] = [];
	private retryNextTurn: ExactUserEnvelope[] = [];
	private deliveryLaneThisTurn: DeliveryLane | undefined;

	capture(
		text: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
	): void {
		const envelope: ExactUserEnvelope = {
			sequence: this.nextSequence++,
			text,
			...(images ? { images: [...images] } : {}),
		};

		this.trackDelivery(envelope, streamingBehavior);
	}

	/**
	 * Preserve Pi's delivery ordering for extension-generated user messages
	 * without ever making those messages available to the routing tool.
	 */
	observe(streamingBehavior?: "steer" | "followUp"): void {
		this.trackDelivery(undefined, streamingBehavior);
	}

	/** Mark the current idle prompt as accepted by Pi's preflight. */
	acceptIdlePrompt(): void {
		if (!this.idleCandidate) return;
		this.awaitingDelivery.push(this.idleCandidate);
		this.idleCandidate = undefined;
	}

	beginTurn(): void {
		this.visibleThisTurn = this.retryNextTurn;
		this.retryNextTurn = [];
		this.deliveryLaneThisTurn = this.nextPendingLane();
	}

	/**
	 * Promote the captured input Pi actually exposed, following Pi's queue order.
	 * Text equality is deliberately not used: the input event fires before later
	 * extension transforms and built-in skill/template expansion, while
	 * message_start contains the final text.
	 */
	markNextUserMessageVisible(): ExactUserEnvelope | undefined {
		const index = this.nextDeliveryIndex();
		if (index < 0) return undefined;
		const [delivery] = this.awaitingDelivery.splice(index, 1);
		const envelope = delivery?.envelope;
		if (envelope) this.visibleThisTurn.push(envelope);
		return envelope;
	}

	private trackDelivery(
		envelope: ExactUserEnvelope | undefined,
		streamingBehavior: "steer" | "followUp" | undefined,
	): void {
		const delivery: PendingDelivery = {
			...(envelope ? { envelope } : {}),
			lane: streamingBehavior ?? "current",
		};

		if (streamingBehavior) {
			this.awaitingDelivery.push(delivery);
		} else {
			// An idle prompt that fails authentication/model preflight produces no
			// agent events. The next idle submission supersedes that stale candidate.
			this.idleCandidate = delivery;
		}
	}

	private nextDeliveryIndex(): number {
		const lane = this.deliveryLaneThisTurn;
		if (!lane) return -1;
		const laneIndex = this.awaitingDelivery.findIndex((delivery) => delivery.lane === lane);
		if (laneIndex >= 0) return laneIndex;
		// Pi may drain steering after emitting the initial prompt in the same turn.
		// Other turns stay fixed to the queue Pi selected before turn_start.
		if (lane === "current") {
			return this.awaitingDelivery.findIndex((delivery) => delivery.lane === "steer");
		}
		return -1;
	}

	private nextPendingLane(): DeliveryLane | undefined {
		return DELIVERY_ORDER.find((lane) =>
			this.awaitingDelivery.some((delivery) => delivery.lane === lane),
		);
	}

	/** Reserve all inputs that the foreground can actually see in this turn. */
	claimForRoute(): ExactUserEnvelope[] {
		const claimed = this.visibleThisTurn;
		this.visibleThisTurn = [];
		return claimed;
	}

	/**
	 * Restore an unaccepted reservation for one retry turn. The original user
	 * message remains in the foreground context alongside the failed tool result.
	 */
	releaseForRetry(envelopes: readonly ExactUserEnvelope[]): void {
		if (envelopes.length === 0) return;
		this.retryNextTurn = [...envelopes, ...this.retryNextTurn].sort(
			(left, right) => left.sequence - right.sequence,
		);
	}

	endTurn(success = true): void {
		if (!success) this.releaseForRetry(this.visibleThisTurn);
		// Anything still visible after a successful turn was answered directly by
		// the foreground. Failed, aborted, and length-limited turns retain it for
		// one retry turn instead.
		this.visibleThisTurn = [];
		this.deliveryLaneThisTurn = undefined;
	}

	settle(): void {
		// agent_settled guarantees Pi has no queued user messages left. Avoid
		// associating an abandoned/aborted queued input with a later prompt.
		this.reset();
	}

	reset(): void {
		this.idleCandidate = undefined;
		this.awaitingDelivery = [];
		this.visibleThisTurn = [];
		this.retryNextTurn = [];
		this.deliveryLaneThisTurn = undefined;
	}

	get pendingCount(): number {
		return (
			(this.idleCandidate ? 1 : 0) +
			this.awaitingDelivery.length +
			this.visibleThisTurn.length +
			this.retryNextTurn.length
		);
	}
}

type DeliveryLane = "current" | "steer" | "followUp";

interface PendingDelivery {
	readonly envelope?: ExactUserEnvelope;
	readonly lane: DeliveryLane;
}

const DELIVERY_ORDER: readonly DeliveryLane[] = ["current", "steer", "followUp"];
