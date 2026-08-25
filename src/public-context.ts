import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stringifyEmbeddedJson } from "./embedded-json.js";
import { isRecord } from "./guards.js";
import type { ReasonerTurn } from "./types.js";

/** Durable, TUI-visible reasoner turn. This entry does not enter model context. */
export const REASONER_TURN_ENTRY = "duplex-reasoner-turn";
/** Hidden Pi custom message that mirrors public reasoner prose into model context. */
export const REASONER_OUTPUT_MESSAGE = "duplex-reasoner-output";

type ReasonerPublicOutputStatus =
	| "committed"
	| "superseded"
	| "stopped"
	| "error";

/**
 * The user-visible portion of a reasoner turn that the foreground may use.
 * Tool payloads, private thinking, checkpoints, and the nested transcript never
 * cross this boundary.
 */
export interface ReasonerPublicOutput {
	readonly sequence: number;
	readonly text: string;
	readonly status: ReasonerPublicOutputStatus;
	readonly timestamp: number;
}

interface ReasonerOutputMessageDetails {
	readonly version: 1;
	readonly outputKey: string;
}

export function toReasonerPublicOutput(turn: ReasonerTurn): ReasonerPublicOutput {
	return {
		sequence: turn.sequence,
		text: turn.text,
		status: getPublicOutputStatus(turn),
		timestamp: turn.timestamp,
	};
}

/**
 * Serialize one prior, user-visible reasoner response as machine-owned context.
 * JSON delimiters are escaped so reasoner prose cannot close the outer marker.
 * There is intentionally no pi-duplex length or count limit: these are
 * ordinary Pi context messages and Pi's compaction owns their lifecycle.
 */
export function buildReasonerOutputMessage(output: ReasonerPublicOutput): string {
	const payload = {
		kind: "prior_reasoner_response",
		sequence: output.sequence,
		status: output.status,
		timestamp: output.timestamp,
		text: output.text,
	};
	return `<duplex_reasoner_output>\n${stringifyEmbeddedJson(payload)}\n</duplex_reasoner_output>`;
}

export function buildReasonerOutputMessageDetails(
	output: ReasonerPublicOutput,
): ReasonerOutputMessageDetails {
	return {
		version: 1,
		outputKey: reasonerOutputKey(output),
	};
}

/**
 * Find visible reasoner turns in a compaction-aware foreground branch that do
 * not yet have a corresponding context message. The visible entry is the
 * durable outbox; this lets a resumed extension repair a process interruption
 * between rendering the turn and mirroring it into model context.
 */
export function findUnmirroredReasonerPublicOutputs(
	entries: readonly SessionEntry[],
): ReasonerPublicOutput[] {
	const mirroredKeys = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== REASONER_OUTPUT_MESSAGE) {
			continue;
		}
		const details = parseMessageDetails(entry.details);
		if (details) mirroredKeys.add(details.outputKey);
	}

	const outputs: ReasonerPublicOutput[] = [];
	const queuedKeys = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== REASONER_TURN_ENTRY) continue;
		const output = parseReasonerPublicOutput(entry.data);
		if (!output) continue;
		const key = reasonerOutputKey(output);
		if (mirroredKeys.has(key) || queuedKeys.has(key)) continue;
		queuedKeys.add(key);
		outputs.push(output);
	}
	return outputs;
}

function reasonerOutputKey(output: Pick<ReasonerPublicOutput, "sequence" | "timestamp">): string {
	return `${output.sequence}:${output.timestamp}`;
}

function parseReasonerPublicOutput(value: unknown): ReasonerPublicOutput | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.sequence !== "number" || !Number.isFinite(value.sequence)) return undefined;
	if (typeof value.text !== "string" || value.text.length === 0) return undefined;
	if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return undefined;

	return {
		sequence: value.sequence,
		text: value.text,
		status: getPublicOutputStatus(value),
		timestamp: value.timestamp,
	};
}

function parseMessageDetails(value: unknown): ReasonerOutputMessageDetails | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== 1 || typeof value.outputKey !== "string") return undefined;
	return {
		version: 1,
		outputKey: value.outputKey,
	};
}

function getPublicOutputStatus(value: {
	errorMessage?: unknown;
	stopReason?: unknown;
	superseded?: unknown;
}): ReasonerPublicOutputStatus {
	if (typeof value.errorMessage === "string" && value.errorMessage.length > 0) return "error";
	if (value.stopReason === "aborted") return "stopped";
	if (value.superseded === true) return "superseded";
	return "committed";
}
