import { describe, expect, it } from "vitest";
import { ExactInputTracker } from "../src/input-tracker.js";

describe("ExactInputTracker", () => {
	it("promotes an accepted idle prompt only when its user message starts", () => {
		const tracker = new ExactInputTracker();
		const text = "keep  two spaces, `code`, and punctuation?!";
		tracker.capture(text);

		tracker.acceptIdlePrompt();
		tracker.beginTurn();
		expect(tracker.claimForRoute()).toEqual([]);

		expect(tracker.markNextUserMessageVisible()).toEqual({ sequence: 1, text });
		expect(tracker.claimForRoute()).toEqual([{ sequence: 1, text }]);
		expect(tracker.pendingCount).toBe(0);
	});

	it("routes the exact raw idle submission after Pi expands the visible prompt", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("/review src/controller.ts");

		tracker.acceptIdlePrompt();
		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()).toEqual({
			sequence: 1,
			text: "/review src/controller.ts",
		});
		expect(tracker.claimForRoute()).toEqual([
			{ sequence: 1, text: "/review src/controller.ts" },
		]);
	});

	it("follows Pi's one-at-a-time delivery without exposing the next input early", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("first", undefined, "steer");
		tracker.capture("second", undefined, "steer");

		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("first");
		expect(tracker.claimForRoute().map((item) => item.text)).toEqual(["first"]);
		expect(tracker.pendingCount).toBe(1);
		tracker.endTurn();

		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("second");
		expect(tracker.claimForRoute().map((item) => item.text)).toEqual(["second"]);
		expect(tracker.pendingCount).toBe(0);
	});

	it("promotes every message Pi delivers together in all-at-once mode", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("first", undefined, "followUp");
		tracker.capture("second", undefined, "followUp");

		tracker.beginTurn();
		tracker.markNextUserMessageVisible();
		tracker.markNextUserMessageVisible();

		expect(tracker.claimForRoute().map((item) => item.text)).toEqual(["first", "second"]);
		expect(tracker.pendingCount).toBe(0);
	});

	it("matches Pi's steering-before-follow-up delivery rather than capture order", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("later follow-up", undefined, "followUp");
		tracker.capture("urgent steer", undefined, "steer");

		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("urgent steer");
		expect(tracker.claimForRoute().map((item) => item.text)).toEqual(["urgent steer"]);
		expect(tracker.pendingCount).toBe(1);

		tracker.endTurn();
		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("later follow-up");
	});

	it("uses steering-before-follow-up order when later transforms change both messages", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("raw follow-up", undefined, "followUp");
		tracker.capture("raw steer", undefined, "steer");
		tracker.beginTurn();

		expect(tracker.markNextUserMessageVisible()?.text).toBe("raw steer");
		expect(tracker.claimForRoute().map((item) => item.text)).toEqual(["raw steer"]);
		expect(tracker.pendingCount).toBe(1);

		tracker.endTurn();
		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("raw follow-up");
	});

	it("does not let coincidental text equality override Pi's delivery lane", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("same as transformed steer", undefined, "followUp");
		tracker.capture("raw steer", undefined, "steer");
		tracker.beginTurn();

		expect(tracker.markNextUserMessageVisible()?.text).toBe("raw steer");
	});

	it("keeps a follow-up turn fixed when a new steer arrives after turn_start", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("ready follow-up", undefined, "followUp");
		tracker.beginTurn();
		tracker.capture("late steer", undefined, "steer");

		expect(tracker.markNextUserMessageVisible()?.text).toBe("ready follow-up");
		tracker.endTurn();
		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("late steer");
	});

	it("consumes extension-generated user messages without making them routable", () => {
		const tracker = new ExactInputTracker();
		tracker.observe("steer");
		tracker.capture("user follow-up", undefined, "followUp");
		tracker.beginTurn();

		expect(tracker.markNextUserMessageVisible()).toBeUndefined();
		expect(tracker.claimForRoute()).toEqual([]);
		tracker.endTurn();
		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("user follow-up");
	});

	it("replaces a stale idle candidate after failed Pi preflight", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("stale prompt");
		tracker.capture("replacement prompt");

		expect(tracker.pendingCount).toBe(1);
		tracker.acceptIdlePrompt();
		tracker.beginTurn();
		expect(tracker.markNextUserMessageVisible()?.text).toBe("replacement prompt");
		expect(tracker.claimForRoute()).toEqual([
			{ sequence: 2, text: "replacement prompt" },
		]);
	});

	it("releases an unaccepted reservation for exactly one retry turn", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("retry me", undefined, "steer");
		tracker.beginTurn();
		tracker.markNextUserMessageVisible();
		const claimed = tracker.claimForRoute();

		tracker.releaseForRetry(claimed);
		tracker.endTurn();
		tracker.beginTurn();

		expect(tracker.claimForRoute()).toEqual([{ sequence: 1, text: "retry me" }]);
		expect(tracker.pendingCount).toBe(0);
	});

	it("preserves still-visible input after a failed, aborted, or length-limited turn", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("not answered yet");
		tracker.acceptIdlePrompt();
		tracker.beginTurn();
		tracker.markNextUserMessageVisible();

		tracker.endTurn(false);
		tracker.beginTurn();

		expect(tracker.claimForRoute()).toEqual([{ sequence: 1, text: "not answered yet" }]);
	});

	it("consumes a visible message after a successful direct answer", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("what is 2 + 2?");
		tracker.acceptIdlePrompt();
		tracker.beginTurn();
		tracker.markNextUserMessageVisible();

		tracker.endTurn();

		expect(tracker.pendingCount).toBe(0);
	});

	it("settle drops abandoned input from every delivery stage", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("idle candidate");
		tracker.capture("visible", undefined, "steer");
		tracker.capture("awaiting", undefined, "followUp");
		tracker.beginTurn();
		tracker.markNextUserMessageVisible();
		const claimed = tracker.claimForRoute();
		tracker.releaseForRetry(claimed);

		expect(tracker.pendingCount).toBe(3);
		tracker.settle();

		expect(tracker.pendingCount).toBe(0);
		expect(tracker.markNextUserMessageVisible()).toBeUndefined();
	});

	it("reset drops all state when Pi changes sessions", () => {
		const tracker = new ExactInputTracker();
		tracker.capture("idle candidate");
		tracker.capture("queued input", undefined, "steer");

		tracker.reset();
		tracker.beginTurn();

		expect(tracker.pendingCount).toBe(0);
		expect(tracker.claimForRoute()).toEqual([]);
		expect(tracker.markNextUserMessageVisible()).toBeUndefined();
	});
});
