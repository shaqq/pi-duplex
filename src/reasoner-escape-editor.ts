import type { EditorComponent } from "@earendil-works/pi-tui";

interface AppEscapeEditor {
	actionHandlers: Map<unknown, unknown>;
	onEscape?: () => void;
}

const REASONER_ESCAPE_WINDOW_MS = 500;

/**
 * Compose with CustomEditor's app-level Escape handler. The editor itself
 * still receives input first, preserving autocomplete and custom modal-editor
 * behavior; overlays are unaffected because they own focus while visible.
 */
export function withReasonerEscape(
	base: EditorComponent,
	shouldStopReasoner: () => boolean,
	stopReasoner: () => void,
): EditorComponent {
	if (!isAppEscapeEditor(base)) return base;
	const previousEscape = base.onEscape;
	let piEscape: (() => void) | undefined;
	let reasonerEscapeArmedAt = 0;

	return new Proxy(base, {
		get(target, property) {
			// Report no handler until Pi installs its dynamic native callback.
			if (property === "onEscape") return piEscape;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			if (property === "onEscape") {
				piEscape = typeof value === "function" ? value : undefined;
				target.onEscape = () => {
					if (previousEscape) {
						reasonerEscapeArmedAt = 0;
						previousEscape.call(target);
						return;
					}
					if (!shouldStopReasoner()) {
						reasonerEscapeArmedAt = 0;
						piEscape?.();
						return;
					}

					const now = Date.now();
					if (now - reasonerEscapeArmedAt <= REASONER_ESCAPE_WINDOW_MS) {
						reasonerEscapeArmedAt = 0;
						stopReasoner();
						return;
					}

					// ExtensionContext does not expose standalone bash/compaction state.
					// Give Pi's native handler the first press; a quick second press is
					// reserved for the active reasoner.
					reasonerEscapeArmedAt = now;
					piEscape?.();
				};
				return true;
			}
			return Reflect.set(target, property, value, target);
		},
	});
}

function isAppEscapeEditor(editor: EditorComponent): editor is EditorComponent & AppEscapeEditor {
	return "actionHandlers" in editor && editor.actionHandlers instanceof Map;
}
