import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	findPersistedReasonerState,
	forkedReasonerState,
	linkedReasonerState,
	REASONER_STATE_TYPE,
} from "../src/session-state.js";

function customEntry(id: string, data: unknown, customType = REASONER_STATE_TYPE): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: `2026-08-17T00:00:0${id}Z`,
		customType,
		data,
	} as SessionEntry;
}

describe("reasoner session state", () => {
	it("round-trips a linked checkpoint and derives an immutable fork source", () => {
		const linked = linkedReasonerState({
			sessionFile: "/sessions/reasoner.jsonl",
			leafId: "reasoner-leaf",
			model: "anthropic/claude-test",
		});

		expect(linked).toEqual({
			version: 1,
			mode: "linked",
			sessionFile: "/sessions/reasoner.jsonl",
			leafId: "reasoner-leaf",
			model: "anthropic/claude-test",
		});
		expect(forkedReasonerState(linked)).toEqual({
			version: 1,
			mode: "fork",
			sourceSessionFile: "/sessions/reasoner.jsonl",
			sourceLeafId: "reasoner-leaf",
			model: "anthropic/claude-test",
		});
	});

	it("uses the newest valid state on the caller-provided active branch", () => {
		const activeBranch = [
			customEntry("1", {
				version: 1,
				mode: "linked",
				sessionFile: "/sessions/old.jsonl",
				leafId: "old-leaf",
			}),
			customEntry("2", { version: 2, mode: "linked", sessionFile: "/invalid.jsonl" }),
			customEntry("3", { unrelated: true }, "another-extension"),
			customEntry("4", {
				version: 1,
				mode: "fork",
				sourceSessionFile: "/sessions/source.jsonl",
				sourceLeafId: "source-leaf",
			}),
		];

		expect(findPersistedReasonerState(activeBranch)).toEqual({
			version: 1,
			mode: "fork",
			sourceSessionFile: "/sessions/source.jsonl",
			sourceLeafId: "source-leaf",
		});
	});

	it("treats a latest none record as a branch-local tombstone", () => {
		const activeBranch = [
			customEntry("1", {
				version: 1,
				mode: "linked",
				sessionFile: "/sessions/reasoner.jsonl",
				leafId: "leaf-before-reset",
			}),
			customEntry("2", { version: 1, mode: "none" }),
		];

		expect(findPersistedReasonerState(activeBranch)).toEqual({ version: 1, mode: "none" });
		expect(forkedReasonerState(findPersistedReasonerState(activeBranch))).toEqual({
			version: 1,
			mode: "none",
		});
	});

	it("skips malformed recent records", () => {
		const entries = [
			customEntry("1", {
				version: 1,
				mode: "linked",
				sessionFile: "/sessions/valid.jsonl",
				leafId: "valid-leaf",
			}),
			customEntry("2", { version: 1, mode: "linked", sessionFile: 42 }),
		];

		expect(findPersistedReasonerState(entries)).toEqual({
			version: 1,
			mode: "linked",
			sessionFile: "/sessions/valid.jsonl",
			leafId: "valid-leaf",
		});
	});

	it("returns undefined when the active branch has no valid state", () => {
		expect(
			findPersistedReasonerState([
				customEntry("1", null),
				customEntry("2", { version: 1, mode: "fork" }),
			]),
		).toBeUndefined();
	});
});
