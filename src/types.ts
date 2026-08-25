import type { ImageContent } from "@earendil-works/pi-ai";

export const ROUTE_ACTIONS = ["start", "steer", "queue", "stop"] as const;
export const REASONER_STOPPED_FALLBACK = "Reasoner work was stopped.";

export type RouteAction = (typeof ROUTE_ACTIONS)[number];

export interface ExactUserEnvelope {
	readonly sequence: number;
	readonly text: string;
	readonly images?: ImageContent[];
}

type ReasonerState = "idle" | "working" | "stopping" | "error";

export interface ReasonerSnapshot {
	readonly state: ReasonerState;
	readonly phase: string;
	readonly model?: string;
	readonly activeTools: readonly string[];
	readonly queuedMessages: number;
}

export interface ReasonerToolActivity {
	readonly summary: string;
	readonly isError: boolean;
}

export interface ReasonerCheckpoint {
	readonly sessionFile: string;
	readonly leafId: string;
	readonly model?: string;
}

export interface ReasonerTurn {
	readonly sequence: number;
	readonly text: string;
	readonly tools: readonly ReasonerToolActivity[];
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly superseded: boolean;
	readonly checkpoint?: ReasonerCheckpoint;
	readonly timestamp: number;
}

export function isSyntheticReasonerStop(
	turn: Pick<ReasonerTurn, "text" | "stopReason">,
): boolean {
	return turn.stopReason === "aborted" && turn.text === REASONER_STOPPED_FALLBACK;
}
