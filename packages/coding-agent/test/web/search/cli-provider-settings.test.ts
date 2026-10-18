import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runSearchCommand } from "../../../src/cli/web-search-cli";
import Search from "../../../src/commands/web-search";

import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOmpProfile = process.env.OMP_PROFILE;
const originalPiProfile = process.env.PI_PROFILE;

let tempAgentDir: TempDir | undefined;
let originalExitCode: typeof process.exitCode;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://www.startpage.com/") {
				return new Response("<html><body></body></html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.startsWith("https://www.startpage.com/sp/search")) {
				return new Response(
					'<div class="result"><a class="result-link" href="https://startpage.example"><h2>Startpage result</h2></a><p class="description">startpage</p></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			if (url === "https://html.duckduckgo.com/html/") {
				return new Response(
					'<div class="result"><a class="result__a" href="https://duckduckgo.example">DuckDuckGo result</a><a class="result__snippet">duckduckgo</a></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	resetSettingsForTest();
	tempAgentDir = TempDir.createSync("@omp-search-cli-");
	setAgentDir(tempAgentDir.path());
	const settings = await Settings.init({ inMemory: true, cwd: tempAgentDir.path() });
	settings.setModelRole("web", "web/startpage");
	cfgRetryFallbackChains.set(settings, { web: [] });
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	process.exitCode = originalExitCode ?? 0;
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	restoreEnv("PI_PROFILE", originalPiProfile);
	__resetDirsFromEnvForTests();
	// runSearchCommand opens <agentDir>/models.db; Windows cannot delete an open database.
	closeModelCache();
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand model role settings", () => {
	it("honors modelRoles.web for the implicit request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "role selection smoke test", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("startpage.example");
		expect(plain).not.toContain("duckduckgo.example");
	});

	it("treats --model as a one-shot override of modelRoles.web", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({
			query: "explicit model override",
			model: "web/duckduckgo",
			limit: 1,
			expanded: false,
		});

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("duckduckgo.example");
		expect(plain).not.toContain("startpage.example");
	});

	it("--json writes a single envelope with full sources and no ANSI", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "json envelope", model: "web/duckduckgo", limit: 1, expanded: true, json: true });

		expect(stdout.endsWith("\n")).toBe(true);
		expect(stdout.trim().split("\n")).toHaveLength(1);
		expect(stdout).not.toContain("\u001b");
		const envelope = JSON.parse(stdout);
		expect(envelope.error).toBeUndefined();
		expect(envelope.response.provider).toBe("duckduckgo");
		expect(envelope.response.sources.map((s: { url: string }) => s.url)).toContain("https://duckduckgo.example");
		expect(process.exitCode).not.toBe(1);
	});

	it("--json reports provider errors in the envelope and exits nonzero", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => new Response("boom", { status: 500 }), { preconnect: fetch.preconnect }),
		);
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "json error", model: "web/duckduckgo", limit: 1, expanded: true, json: true });

		const envelope = JSON.parse(stdout);
		expect(typeof envelope.error).toBe("string");
		expect(envelope.response.sources).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("omp q --json forwards through the Search command class", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});
		const config = { bin: "omp", version: "0.0.0-test", commands: new Map() };

		await new Search(["--json", "--model", "web/duckduckgo", "--limit", "1", "command", "class"], config).run();

		const envelope = JSON.parse(stdout);
		expect(envelope.response.sources.map((s: { url: string }) => s.url)).toContain("https://duckduckgo.example");
		expect(stdout).not.toContain("\u001b");
	});

	it("omp q --json passes a leading-dash query after the -- terminator unchanged", async () => {
		const queries: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
					const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
					if (url === "https://html.duckduckgo.com/html/")
						queries.push(new URLSearchParams(String(init?.body)).get("q") ?? "");
					return new Response(
						'<div class="result"><a class="result__a" href="https://duckduckgo.example">DuckDuckGo result</a><a class="result__snippet">duckduckgo</a></div>',
						{ status: 200, headers: { "Content-Type": "text/html" } },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		);
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});
		const config = { bin: "omp", version: "0.0.0-test", commands: new Map() };

		await new Search(["--json", "--model", "web/duckduckgo", "--", "-site:example.com topic"], config).run();

		expect(JSON.parse(stdout).response.sources.length).toBeGreaterThan(0);
		// The pipeline parses directives before the provider, so assert the word payload reached it (not a flag error).
		expect(queries.length).toBeGreaterThan(0);
		expect(queries.every(q => q.includes("topic"))).toBe(true);
	});
});
