import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editTool, readTool, writeTool } from "./file-tools.ts";
import { resolveInside } from "./paths.ts";
import { defaultTools } from "./registry.ts";

async function workspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "vernier-"));
}

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

describe("resolveInside", () => {
	it("accepts a path under the workspace", () => {
		expect(resolveInside("/tmp/ws", "src/a.ts")).toBe("/tmp/ws/src/a.ts");
	});

	it("rejects traversal out of the workspace", () => {
		expect(() => resolveInside("/tmp/ws", "../../etc/passwd")).toThrow(/leaves the workspace/);
	});

	it("rejects an absolute path outside the workspace", () => {
		expect(() => resolveInside("/tmp/ws", "/etc/passwd")).toThrow(/leaves the workspace/);
	});
});

describe("edit", () => {
	it("replaces a unique occurrence", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "a.txt"), "alpha beta gamma");
		const out = await editTool.run({ path: "a.txt", old_string: "beta", new_string: "delta" }, ctx(cwd));

		expect(out.ok).toBe(true);
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("alpha delta gamma");
	});

	it("refuses an ambiguous match rather than guessing", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "a.txt"), "x\nx\n");
		const out = await editTool.run({ path: "a.txt", old_string: "x", new_string: "y" }, ctx(cwd));

		expect(out.ok).toBe(false);
		expect(out.error?.kind).toBe("invalid_args");
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("x\nx\n");
	});

	it("reports a missing match without touching the file", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "a.txt"), "hello");
		const out = await editTool.run({ path: "a.txt", old_string: "nope", new_string: "y" }, ctx(cwd));

		expect(out.ok).toBe(false);
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("hello");
	});
});

describe("read and write", () => {
	it("round-trips a file", async () => {
		const cwd = await workspace();
		await writeTool.run({ path: "nested/dir/b.txt", content: "written" }, ctx(cwd));
		const out = await readTool.run({ path: "nested/dir/b.txt" }, ctx(cwd));

		expect(out.ok).toBe(true);
		expect(out.content).toBe("written");
	});

	it("turns a path escape into a tool error, not a crash", async () => {
		const cwd = await workspace();
		const out = await readTool.run({ path: "../escape.txt" }, ctx(cwd));

		expect(out.ok).toBe(false);
		expect(out.error?.kind).toBe("invalid_args");
	});
});

describe("registry", () => {
	it("answers an unknown tool instead of throwing, so the transcript stays paired", async () => {
		const cwd = await workspace();
		const result = await defaultTools().run({ id: "c1", name: "nope", args: {} }, ctx(cwd));

		expect(result).toMatchObject({ callId: "c1", toolName: "nope", ok: false });
		expect(result.error?.kind).toBe("not_found");
	});

	it("runs bash and reports a non-zero exit as a failure", async () => {
		const cwd = await workspace();
		const tools = defaultTools();

		const ok = await tools.run({ id: "c1", name: "bash", args: { command: "echo hi" } }, ctx(cwd));
		expect(ok.ok).toBe(true);
		expect(ok.content.trim()).toBe("hi");

		const bad = await tools.run({ id: "c2", name: "bash", args: { command: "exit 3" } }, ctx(cwd));
		expect(bad.ok).toBe(false);
		expect(bad.error?.message).toContain("exit code 3");
	});

	it("kills a command that outruns its timeout", async () => {
		const cwd = await workspace();
		const result = await defaultTools().run(
			{ id: "c3", name: "bash", args: { command: "sleep 5", timeout_ms: 150 } },
			ctx(cwd),
		);

		expect(result.ok).toBe(false);
		expect(result.error?.kind).toBe("timeout");
		expect(result.error?.retryable).toBe(true);
	});
});
