import type { EditorComponent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { withReasonerEscape } from "../src/reasoner-escape-editor.js";

function createBase(autocomplete = false): EditorComponent & {
	actionHandlers: Map<unknown, unknown>;
	onEscape?: () => void;
} {
	let text = "";
	const editor: EditorComponent & {
		actionHandlers: Map<unknown, unknown>;
		onEscape?: () => void;
	} = {
		actionHandlers: new Map(),
		render: () => [],
		invalidate: vi.fn(),
		handleInput: vi.fn((data: string) => {
			if (data === "escape" && !autocomplete) editor.onEscape?.();
		}),
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
	};
	return editor;
}

describe("reasoner Escape editor", () => {
	it("gives Pi the first Escape and stops the reasoner on a quick second press", () => {
		const base = createBase();
		const stop = vi.fn();
		const nativeEscape = vi.fn();
		const editor = withReasonerEscape(base, () => true, stop) as typeof base;
		editor.onEscape = nativeEscape;

		editor.handleInput("escape");
		expect(nativeEscape).toHaveBeenCalledOnce();
		expect(stop).not.toHaveBeenCalled();

		editor.handleInput("escape");

		expect(stop).toHaveBeenCalledOnce();
		expect(base.handleInput).toHaveBeenCalledTimes(2);
		expect(nativeEscape).toHaveBeenCalledOnce();
	});

	it("leaves foreground and autocomplete Escape behavior to Pi", () => {
		const foregroundBase = createBase();
		const foregroundStop = vi.fn();
		const foregroundEscape = vi.fn();
		const foregroundEditor = withReasonerEscape(
			foregroundBase,
			() => false,
			foregroundStop,
		) as typeof foregroundBase;
		foregroundEditor.onEscape = foregroundEscape;
		foregroundEditor.handleInput("escape");
		expect(foregroundStop).not.toHaveBeenCalled();
		expect(foregroundEscape).toHaveBeenCalledOnce();
		expect(foregroundBase.handleInput).toHaveBeenCalledWith("escape");

		const autocompleteBase = createBase(true);
		const autocompleteStop = vi.fn();
		const autocompleteEscape = vi.fn();
		const autocompleteEditor = withReasonerEscape(
			autocompleteBase,
			() => true,
			autocompleteStop,
		) as typeof autocompleteBase;
		autocompleteEditor.onEscape = autocompleteEscape;
		autocompleteEditor.handleInput("escape");
		expect(autocompleteStop).not.toHaveBeenCalled();
		expect(autocompleteEscape).not.toHaveBeenCalled();
		expect(autocompleteBase.handleInput).toHaveBeenCalledWith("escape");
	});

	it("preserves an existing custom Escape handler while the reasoner is active", () => {
		const base = createBase();
		const customEscape = vi.fn();
		const nativeEscape = vi.fn();
		base.onEscape = customEscape;
		const stop = vi.fn();
		const editor = withReasonerEscape(base, () => true, stop) as typeof base;

		editor.onEscape = nativeEscape;
		editor.handleInput("escape");

		expect(customEscape).toHaveBeenCalledOnce();
		expect(nativeEscape).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
	});

	it("does not steal Escape from a modal editor that consumes it before CustomEditor", () => {
		const base = createBase();
		base.handleInput = vi.fn();
		const stop = vi.fn();
		const editor = withReasonerEscape(base, () => true, stop) as typeof base;
		editor.onEscape = vi.fn();

		editor.handleInput("escape");

		expect(base.handleInput).toHaveBeenCalledWith("escape");
		expect(stop).not.toHaveBeenCalled();
	});
});
