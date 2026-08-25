import { describe, expect, it } from "vitest";
import {
	DELEGATION_ACCEPTED_INSTRUCTION,
	FOREGROUND_SYSTEM_PROMPT,
} from "../src/prompts.js";

describe("foreground delegation contract", () => {
	it("makes direct response and delegation mutually exclusive", () => {
		expect(FOREGROUND_SYSTEM_PROMPT).toContain("Choose exactly one mode");
		expect(FOREGROUND_SYSTEM_PROMPT).toContain("Do not call delegate");
		expect(FOREGROUND_SYSTEM_PROMPT).toContain("emit no text before the tool call");
		expect(FOREGROUND_SYSTEM_PROMPT).toContain(
			"the reasoner owns all substantive content and clarification",
		);
	});

	it("reinforces the short acknowledgment limit after routing", () => {
		expect(DELEGATION_ACCEPTED_INSTRUCTION).toContain("Either end this turn now");
		expect(DELEGATION_ACCEPTED_INSTRUCTION).toContain("one short generic acknowledgment");
		expect(DELEGATION_ACCEPTED_INSTRUCTION).toContain("Do not answer, clarify");
	});
});
