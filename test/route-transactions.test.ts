import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	findUnresolvedRouteTransactions,
	preparedRouteTransaction,
	ROUTE_TRANSACTION_TYPE,
	type RouteTransactionRecord,
} from "../src/route-transactions.js";

function entry(id: string, data: RouteTransactionRecord): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date(data.timestamp).toISOString(),
		customType: ROUTE_TRANSACTION_TYPE,
		data,
	} as SessionEntry;
}

describe("route transaction recovery", () => {
	it("retains exact prepared envelopes until a terminal record appears", () => {
		const prepared = preparedRouteTransaction(
			"route-1",
			"steer",
			[{ sequence: 7, text: "preserve  this exactly" }],
			1,
		);
		const admitted: RouteTransactionRecord = {
			version: 1,
			id: "route-1",
			phase: "admitted",
			acceptedCount: 1,
			timestamp: 2,
		};

		expect(
			findUnresolvedRouteTransactions([entry("1", prepared), entry("2", admitted)]),
		).toEqual([prepared]);
	});

	it.each(["settled", "failed", "abandoned"] as const)(
		"treats %s as terminal",
		(phase) => {
			const prepared = preparedRouteTransaction(
				"route-1",
				"start",
				[{ sequence: 1, text: "task" }],
				1,
			);
			const terminal: RouteTransactionRecord = {
				version: 1,
				id: "route-1",
				phase,
				timestamp: 2,
			};

			expect(
				findUnresolvedRouteTransactions([entry("1", prepared), entry("2", terminal)]),
			).toEqual([]);
		},
	);

	it("uses only the records supplied from the active branch", () => {
		const abandonedBranch = preparedRouteTransaction(
			"other-branch",
			"queue",
			[{ sequence: 1, text: "not on this branch" }],
			1,
		);
		expect(findUnresolvedRouteTransactions([])).toEqual([]);
		expect(findUnresolvedRouteTransactions([entry("1", abandonedBranch)])).toHaveLength(1);
	});
});
