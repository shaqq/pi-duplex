import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./guards.js";
import type { ReasonerCheckpoint } from "./types.js";

export const REASONER_STATE_TYPE = "duplex-reasoner-state";

export type PersistedReasonerState =
	| {
			readonly version: 1;
			readonly mode: "linked";
			readonly sessionFile: string;
			readonly leafId: string;
			readonly model?: string;
	  }
	| {
			readonly version: 1;
			readonly mode: "fork";
			readonly sourceSessionFile: string;
			readonly sourceLeafId: string;
			readonly model?: string;
	  }
	| {
			readonly version: 1;
			readonly mode: "none";
	  };

export function linkedReasonerState(checkpoint: ReasonerCheckpoint): PersistedReasonerState {
	return {
		version: 1,
		mode: "linked",
		sessionFile: checkpoint.sessionFile,
		leafId: checkpoint.leafId,
		...(checkpoint.model ? { model: checkpoint.model } : {}),
	};
}

export function forkedReasonerState(
	state: PersistedReasonerState | undefined,
): PersistedReasonerState {
	if (!state || state.mode === "none") return { version: 1, mode: "none" };
	if (state.mode === "fork") return state;
	return {
		version: 1,
		mode: "fork",
		sourceSessionFile: state.sessionFile,
		sourceLeafId: state.leafId,
		...(state.model ? { model: state.model } : {}),
	};
}

/** The caller must pass only entries from the foreground's active branch. */
export function findPersistedReasonerState(
	entries: readonly SessionEntry[],
): PersistedReasonerState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== REASONER_STATE_TYPE) continue;
		const parsed = parsePersistedReasonerState(entry.data);
		if (parsed) return parsed;
	}
	return undefined;
}

function parsePersistedReasonerState(value: unknown): PersistedReasonerState | undefined {
	if (!isRecord(value)) return undefined;

	if (value.version !== 1 || typeof value.mode !== "string") return undefined;
	if (value.model !== undefined && typeof value.model !== "string") return undefined;
	if (value.mode === "none") return { version: 1, mode: "none" };
	if (
		value.mode === "linked" &&
		typeof value.sessionFile === "string" &&
		typeof value.leafId === "string"
	) {
		return {
			version: 1,
			mode: "linked",
			sessionFile: value.sessionFile,
			leafId: value.leafId,
			...(typeof value.model === "string" ? { model: value.model } : {}),
		};
	}
	if (
		value.mode === "fork" &&
		typeof value.sourceSessionFile === "string" &&
		typeof value.sourceLeafId === "string"
	) {
		return {
			version: 1,
			mode: "fork",
			sourceSessionFile: value.sourceSessionFile,
			sourceLeafId: value.sourceLeafId,
			...(typeof value.model === "string" ? { model: value.model } : {}),
		};
	}
	return undefined;
}
