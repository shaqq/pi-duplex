/** JSON safe to place inside one of pi-duplex's XML-like prompt boundaries. */
export function stringifyEmbeddedJson(value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("The embedded value is not JSON-serializable.");
	return json
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026");
}
