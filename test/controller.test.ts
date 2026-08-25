import { describe, expect, it, vi } from "vitest";
import {
	ReasonerRouter,
	RouteDispatchError,
	type ReasonerPort,
} from "../src/controller.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createPort(initiallyBusy = false) {
	let busy = initiallyBusy;
	const submit = vi.fn<ReasonerPort["submit"]>(async (action) => {
		if (action === "start") busy = true;
	});
	const abort = vi.fn<ReasonerPort["abort"]>(async () => {
		busy = false;
	});

	return {
		get isBusy() {
			return busy;
		},
		setBusy(value: boolean) {
			busy = value;
		},
		submit,
		abort,
	};
}

describe("ReasonerRouter", () => {
	it("resolves only after Pi admits the exact message", async () => {
		const gate = deferred();
		const port = createPort();
		port.submit.mockImplementationOnce(async () => {
			await gate.promise;
			port.setBusy(true);
		});
		const route = new ReasonerRouter(port).route("start", [
			{ sequence: 1, text: "exact  request" },
		]);
		await Promise.resolve();

		expect(port.submit).toHaveBeenCalledWith("start", "exact  request", undefined);
		let admitted = false;
		void route.then(() => {
			admitted = true;
		});
		await Promise.resolve();
		expect(admitted).toBe(false);

		gate.resolve();
		await expect(route).resolves.toEqual({ acceptedCount: 1 });
	});

	it.each([
		[false, "steer", "start"],
		[false, "queue", "start"],
		[true, "start", "steer"],
		[true, "steer", "steer"],
		[true, "queue", "queue"],
	] as const)("normalizes busy=%s %s to %s", async (busy, requested, effective) => {
		const port = createPort(busy);
		const receipt = await new ReasonerRouter(port).route(requested, [
			{ sequence: 1, text: "request" },
		]);

		expect(port.submit).toHaveBeenCalledWith(effective, "request", undefined);
		expect(receipt).toEqual({ acceptedCount: 1 });
	});

	it("preserves order while admitting a batch", async () => {
		const calls: string[] = [];
		const port = createPort();
		port.submit.mockImplementation(async (action, text) => {
			calls.push(`${action}:${text}`);
			if (action === "start") port.setBusy(true);
		});

		const receipt = await new ReasonerRouter(port).route("steer", [
			{ sequence: 1, text: "first  exact" },
			{ sequence: 2, text: "second?!" },
		]);

		expect(calls).toEqual(["start:first  exact", "steer:second?!"]);
		expect(receipt).toEqual({ acceptedCount: 2 });
	});

	it("reports partial admission", async () => {
		const port = createPort();
		port.submit
			.mockImplementationOnce(async () => port.setBusy(true))
			.mockRejectedValueOnce(new Error("steering queue closed"));

		const error = await new ReasonerRouter(port)
			.route("start", [
				{ sequence: 1, text: "first" },
				{ sequence: 2, text: "second" },
				{ sequence: 3, text: "third" },
			])
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(RouteDispatchError);
		expect(error).toMatchObject({ message: "steering queue closed", dispatchedCount: 1 });
		expect(port.submit).toHaveBeenCalledTimes(2);
	});

	it("serializes admissions", async () => {
		const gate = deferred();
		const port = createPort();
		port.submit.mockImplementationOnce(async () => {
			await gate.promise;
			port.setBusy(true);
		});
		const controller = new ReasonerRouter(port);

		const first = controller.route("start", [{ sequence: 1, text: "first" }]);
		await Promise.resolve();
		const second = controller.route("queue", [{ sequence: 2, text: "second" }]);
		await Promise.resolve();
		expect(port.submit).toHaveBeenCalledTimes(1);

		gate.resolve();
		await Promise.all([first, second]);
		expect(port.submit).toHaveBeenLastCalledWith("queue", "second", undefined);
	});

	it("lets STOP preempt the rest of a partially admitted batch", async () => {
		const gate = deferred();
		const port = createPort();
		port.submit.mockImplementationOnce(async () => {
			await gate.promise;
			port.setBusy(true);
		});
		const controller = new ReasonerRouter(port);
		const starting = controller
			.route("start", [
				{ sequence: 1, text: "first" },
				{ sequence: 2, text: "second" },
			])
			.catch((reason: unknown) => reason);
		await Promise.resolve();
		const stopping = controller.route("stop", [{ sequence: 3, text: "stop" }]);

		gate.resolve();
		expect(await starting).toMatchObject({ dispatchedCount: 1 });
		await expect(stopping).resolves.toEqual({ acceptedCount: 1 });
		expect(port.submit).toHaveBeenCalledTimes(1);
		expect(port.abort).toHaveBeenCalledOnce();
	});

	it("runs STOP despite a cancelled tool signal and releases its latch", async () => {
		const port = createPort(true);
		port.abort.mockRejectedValueOnce(new Error("abort failed"));
		const controller = new ReasonerRouter(port);
		const foreground = new AbortController();
		foreground.abort();

		await expect(controller.route("stop", [], foreground.signal)).rejects.toThrow("abort failed");
		port.setBusy(false);
		await expect(
			controller.route("start", [{ sequence: 1, text: "new work" }]),
		).resolves.toEqual({ acceptedCount: 1 });
	});

	it("reports partial admission when the foreground aborts a batch", async () => {
		const port = createPort();
		const foreground = new AbortController();
		port.submit.mockImplementationOnce(async () => {
			port.setBusy(true);
			foreground.abort();
		});

		const error = await new ReasonerRouter(port)
			.route(
				"start",
				[
					{ sequence: 1, text: "accepted" },
					{ sequence: 2, text: "not accepted" },
				],
				foreground.signal,
			)
			.catch((reason: unknown) => reason);

		expect(error).toMatchObject({ dispatchedCount: 1 });
		expect(port.submit).toHaveBeenCalledOnce();
	});

	it("keeps cancellation latched until queued STOP requests settle", async () => {
		const gate = deferred();
		const port = createPort(true);
		port.abort.mockImplementationOnce(async () => gate.promise);
		const controller = new ReasonerRouter(port);
		const firstStop = controller.route("stop", []);
		await Promise.resolve();
		const start = controller
			.route("start", [{ sequence: 1, text: "must not start" }])
			.catch((reason: unknown) => reason);
		const secondStop = controller.route("stop", []);

		gate.resolve();
		await firstStop;
		expect(await start).toMatchObject({ dispatchedCount: 0 });
		await secondStop;
		expect(port.submit).not.toHaveBeenCalled();
		expect(port.abort).toHaveBeenCalledTimes(2);
	});
});
