import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./guards.js";
import type { ExactUserEnvelope, RouteAction } from "./types.js";

export const ROUTE_TRANSACTION_TYPE = "duplex-route-transaction";

export interface PreparedRouteTransaction {
	readonly version: 1;
	readonly id: string;
	readonly phase: "prepared";
	readonly action: Exclude<RouteAction, "stop">;
	readonly envelopes: readonly ExactUserEnvelope[];
	readonly timestamp: number;
}

export type RouteTransactionRecord =
	| PreparedRouteTransaction
	| {
			readonly version: 1;
			readonly id: string;
			readonly phase: "admitted";
			readonly acceptedCount: number;
			readonly timestamp: number;
	  }
	| {
			readonly version: 1;
			readonly id: string;
			readonly phase: "settled" | "failed" | "abandoned";
			readonly reason?: string;
			readonly timestamp: number;
	  };

export function preparedRouteTransaction(
	id: string,
	action: Exclude<RouteAction, "stop">,
	envelopes: readonly ExactUserEnvelope[],
	timestamp = Date.now(),
): PreparedRouteTransaction {
	return {
		version: 1,
		id,
		phase: "prepared",
		action,
		envelopes: envelopes.map((envelope) => ({
			...envelope,
			...(envelope.images ? { images: [...envelope.images] } : {}),
		})),
		timestamp,
	};
}

/** The caller must pass only entries from the foreground's active branch. */
export function findUnresolvedRouteTransactions(
	entries: readonly SessionEntry[],
): PreparedRouteTransaction[] {
	const prepared = new Map<string, PreparedRouteTransaction>();
	const latest = new Map<string, RouteTransactionRecord>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ROUTE_TRANSACTION_TYPE) continue;
		const record = parseRouteTransactionRecord(entry.data);
		if (!record) continue;
		if (record.phase === "prepared") prepared.set(record.id, record);
		latest.set(record.id, record);
	}

	const unresolved: PreparedRouteTransaction[] = [];
	for (const [id, transaction] of prepared) {
		const state = latest.get(id);
		if (!state || !["prepared", "admitted"].includes(state.phase)) continue;
		unresolved.push(transaction);
	}
	return unresolved.sort((left, right) => left.timestamp - right.timestamp);
}

function parseRouteTransactionRecord(value: unknown): RouteTransactionRecord | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string") return undefined;
	if (typeof value.timestamp !== "number" || typeof value.phase !== "string") return undefined;

	if (value.phase === "prepared") {
		if (
			!["start", "steer", "queue"].includes(String(value.action)) ||
			!Array.isArray(value.envelopes) ||
			!value.envelopes.every(isExactEnvelope)
		) {
			return undefined;
		}
		return value as unknown as PreparedRouteTransaction;
	}

	if (value.phase === "admitted" && Number.isInteger(value.acceptedCount)) {
		return value as unknown as RouteTransactionRecord;
	}
	if (["settled", "failed", "abandoned"].includes(value.phase)) {
		return value as unknown as RouteTransactionRecord;
	}
	return undefined;
}

function isExactEnvelope(value: unknown): value is ExactUserEnvelope {
	return (
		isRecord(value) &&
		Number.isInteger(value.sequence) &&
		typeof value.text === "string" &&
		(value.images === undefined || Array.isArray(value.images))
	);
}
