/** M4's hardening plugin replaces this with elision that keeps the original on disk. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function truncate(text: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, Math.floor(limit * 0.7));
	const tail = text.slice(-Math.floor(limit * 0.2));
	return `${head}\n\n... [${text.length - head.length - tail.length} characters elided] ...\n\n${tail}`;
}
