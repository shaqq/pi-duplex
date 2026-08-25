import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./guards.js";

export const REASONER_MODEL_STATE_TYPE = "duplex-reasoner-model";

export type PersistedReasonerModel =
	| { readonly version: 1; readonly mode: "selected"; readonly reference: string }
	| { readonly version: 1; readonly mode: "default" };

export function persistedReasonerModel(reference: string): PersistedReasonerModel {
	return { version: 1, mode: "selected", reference };
}

export function defaultReasonerModel(): PersistedReasonerModel {
	return { version: 1, mode: "default" };
}

/** The caller must pass only entries from the foreground's active branch. */
export function findPersistedReasonerModel(
	entries: readonly SessionEntry[],
): PersistedReasonerModel | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== REASONER_MODEL_STATE_TYPE) continue;
		if (!isRecord(entry.data)) continue;
		if (entry.data.version !== 1 || typeof entry.data.mode !== "string") continue;
		if (entry.data.mode === "default") return { version: 1, mode: "default" };
		if (entry.data.mode === "selected" && typeof entry.data.reference === "string") {
			return { version: 1, mode: "selected", reference: entry.data.reference };
		}
	}
	return undefined;
}
