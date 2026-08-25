import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	defaultReasonerModel,
	findPersistedReasonerModel,
	persistedReasonerModel,
	REASONER_MODEL_STATE_TYPE,
} from "../src/reasoner-model-state.js";

function entry(id: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: `2026-08-24T00:00:0${id}Z`,
		customType: REASONER_MODEL_STATE_TYPE,
		data,
	} as SessionEntry;
}

describe("reasoner model preference", () => {
	it("persists independently of whether the reasoner session has written a message", () => {
		const first = persistedReasonerModel("anthropic/claude-one");
		const second = persistedReasonerModel("moonshotai/kimi-next");

		expect(findPersistedReasonerModel([entry("1", first), entry("2", second)]))
			.toEqual(second);
	});

	it("uses a later default tombstone to clear an unavailable selection", () => {
		expect(
			findPersistedReasonerModel([
				entry("1", persistedReasonerModel("missing-provider/removed-model")),
				entry("2", defaultReasonerModel()),
			]),
		).toEqual({ version: 1, mode: "default" });
	});

	it("ignores malformed records", () => {
		expect(findPersistedReasonerModel([entry("1", []), entry("2", { version: 1 })]))
			.toBeUndefined();
	});
});
