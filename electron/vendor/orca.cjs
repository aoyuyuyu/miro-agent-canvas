Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let node_os = require("node:os");
let node_path = require("node:path");
let node_fs = require("node:fs");
let node_net = require("node:net");
let node_crypto = require("node:crypto");
let zod = require("zod");
let node_child_process = require("node:child_process");
let node_buffer = require("node:buffer");
let node_async_hooks = require("node:async_hooks");
//#region vendor/orca/src/shared/runtime-bootstrap.ts
function findTransport(metadata, ...kinds) {
	const transports = metadata.transports;
	if (transports && Array.isArray(transports)) return transports.find((t) => kinds.includes(t.kind)) ?? null;
	const legacy = metadata.transport;
	if (legacy && kinds.includes(legacy.kind)) return legacy;
	return null;
}
const PRIMARY_RUNTIME_METADATA_FILE = "orca-runtime.json";
function getRuntimeMetadataPath(userDataPath) {
	return (0, node_path.join)(userDataPath, PRIMARY_RUNTIME_METADATA_FILE);
}
const SECRET_KEYS = /* @__PURE__ */ new Set([
	"launchToken",
	"connectionIncarnation",
	"attachmentId",
	"compatibilityEvidence",
	"orchestrationCompatibilityEvidence",
	"ORCA_AGENT_LAUNCH_TOKEN",
	"ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION",
	"ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT"
]);
function redactOrchestrationCompatibilitySecrets(value) {
	return redactValue(value, /* @__PURE__ */ new WeakSet());
}
function redactValue(value, seen) {
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_KEYS.has(key) ? "[redacted]" : redactValue(entry, seen)]));
}
//#endregion
//#region vendor/orca/src/cli/runtime/types.ts
var RuntimeClientError = class extends Error {
	code;
	data;
	constructor(code, message, data) {
		super(message);
		this.code = code;
		this.data = redactOrchestrationCompatibilitySecrets(data);
	}
};
//#endregion
//#region vendor/orca/src/cli/runtime/metadata.ts
function readMetadata(userDataPath) {
	const metadataPath = getRuntimeMetadataPath(userDataPath);
	try {
		const metadata = JSON.parse((0, node_fs.readFileSync)(metadataPath, "utf8"));
		if (!metadata || !findTransport(metadata, "unix", "named-pipe") || !metadata.authToken) throw new RuntimeClientError("runtime_unavailable", `Orca runtime metadata is incomplete at ${metadataPath}`);
		return metadata;
	} catch (error) {
		if (error instanceof RuntimeClientError) throw error;
		throw new RuntimeClientError("runtime_unavailable", `Could not read Orca runtime metadata at ${metadataPath}. Start the Orca app first.`);
	}
}
function getDefaultUserDataPath(platform = process.platform, homeDir = (0, node_os.homedir)()) {
	if (process.env.ORCA_USER_DATA_PATH) return process.env.ORCA_USER_DATA_PATH;
	if (platform === "darwin") return (0, node_path.join)(homeDir, "Library", "Application Support", "orca");
	if (platform === "win32") {
		const appData = process.env.APPDATA;
		if (!appData) throw new RuntimeClientError("runtime_unavailable", "APPDATA is not set, so the Orca runtime metadata path cannot be resolved.");
		return (0, node_path.join)(appData, "orca");
	}
	return (0, node_path.join)(process.env.XDG_CONFIG_HOME || (0, node_path.join)(homeDir, ".config"), "orca");
}
//#endregion
//#region vendor/orca/src/shared/runtime-rpc-envelope.ts
const MetaSuccess = zod.z.object({ runtimeId: zod.z.string() }).strip();
const MetaFailure = zod.z.object({ runtimeId: zod.z.union([zod.z.string(), zod.z.null()]) }).strip().optional();
const Success = zod.z.object({
	id: zod.z.string(),
	ok: zod.z.literal(true),
	result: zod.z.unknown(),
	_meta: MetaSuccess
}).strip();
const Failure = zod.z.object({
	id: zod.z.string(),
	ok: zod.z.literal(false),
	error: zod.z.object({
		code: zod.z.string(),
		message: zod.z.string(),
		data: zod.z.unknown().optional()
	}).strip(),
	_meta: MetaFailure
}).strip();
const Keepalive = zod.z.object({ _keepalive: zod.z.literal(true) }).strip();
const RuntimeRpcEnvelopeSchema = zod.z.union([
	Success,
	Failure,
	Keepalive
]);
function isKeepaliveFrame(frame) {
	return typeof frame === "object" && frame !== null && "_keepalive" in frame && frame._keepalive === true;
}
//#endregion
//#region vendor/orca/src/shared/timer-delay.ts
const MAX_TIMER_DELAY_MS = 2147483647;
function isSafeTimerDelayMs(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
}
//#endregion
//#region vendor/orca/src/cli/runtime/runtime-pid-liveness.ts
function isProcessRunning(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}
//#endregion
//#region vendor/orca/src/cli/runtime/runtime-access-denied.ts
function runtimeAccessDeniedError(socketError, pid) {
	const systemCode = "code" in socketError ? socketError.code : void 0;
	if (systemCode !== "EPERM" && systemCode !== "EACCES" || !isProcessRunning(pid)) return null;
	const codexSandbox = Boolean(process.env.CODEX_SANDBOX);
	return new RuntimeClientError("runtime_access_denied", codexSandbox ? `The Codex sandbox blocked this command from connecting to Orca (${systemCode}). Orca may be running normally.` : `Permission denied connecting to Orca (${systemCode}). Orca may be running normally; this command's sandbox or OS permissions block the connection.`, {
		systemCode,
		nextSteps: [codexSandbox ? "Re-run this command with escalated permissions, outside the Codex sandbox." : "Re-run this command outside its sandbox, or as a user allowed to reach the Orca runtime.", "Do not restart Orca or run 'orca open'; a restart cannot grant this command access."]
	});
}
//#endregion
//#region vendor/orca/src/cli/runtime/transport.ts
async function sendRequest(metadata, method, params, timeoutMs, envelope) {
	if (!isSafeTimerDelayMs(timeoutMs)) throw new RuntimeClientError("invalid_argument", `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`);
	return await new Promise((resolve, reject) => {
		const transport = findTransport(metadata, "unix", "named-pipe");
		if (!transport) {
			reject(new RuntimeClientError("runtime_unavailable", "No compatible transport found in Orca runtime metadata."));
			return;
		}
		const socket = (0, node_net.createConnection)(transport.endpoint);
		let lineSegments = [];
		let settled = false;
		const requestId = (0, node_crypto.randomUUID)();
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			lineSegments = [];
			socket.destroy();
			reject(new RuntimeClientError("runtime_timeout", "Timed out waiting for the Orca runtime to respond."));
		}, timeoutMs);
		const finish = (result) => {
			if (settled) return;
			settled = true;
			lineSegments = [];
			clearTimeout(timeout);
			socket.end();
			if (result.ok === false) reject(result.error);
			else resolve(result.response);
		};
		socket.setEncoding("utf8");
		socket.once("error", (error) => {
			finish({
				ok: false,
				error: runtimeAccessDeniedError(error, metadata.pid) ?? new RuntimeClientError("runtime_unavailable", "Could not connect to the running Orca app. Restart Orca and try again.")
			});
		});
		socket.once("close", () => {
			finish({
				ok: false,
				error: new RuntimeClientError("runtime_unavailable", "The Orca runtime closed the connection before responding. Restart Orca and try again.")
			});
		});
		socket.on("data", (chunk) => {
			let cursor = 0;
			while (cursor < chunk.length && !settled) {
				const newlineIndex = chunk.indexOf("\n", cursor);
				if (newlineIndex === -1) {
					lineSegments.push(chunk.slice(cursor));
					return;
				}
				const segment = chunk.slice(cursor, newlineIndex);
				let line = segment;
				if (lineSegments.length > 0) {
					lineSegments.push(segment);
					line = lineSegments.join("");
					lineSegments = [];
				}
				cursor = newlineIndex + 1;
				if (line.trim().length === 0) continue;
				let raw;
				try {
					raw = JSON.parse(line);
				} catch {
					finish({
						ok: false,
						error: new RuntimeClientError("invalid_runtime_response", "The Orca runtime returned an invalid response frame.")
					});
					return;
				}
				if (isKeepaliveFrame(raw)) {
					timeout.refresh();
					continue;
				}
				const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw);
				if (!parsed.success) {
					finish({
						ok: false,
						error: new RuntimeClientError("invalid_runtime_response", "The Orca runtime returned an invalid response frame.")
					});
					return;
				}
				const frame = parsed.data;
				if ("_keepalive" in frame) {
					timeout.refresh();
					continue;
				}
				const response = frame;
				if (response.id !== requestId) {
					finish({
						ok: false,
						error: new RuntimeClientError("invalid_runtime_response", "The Orca runtime returned a mismatched response id.")
					});
					return;
				}
				if (response._meta?.runtimeId && response._meta.runtimeId !== metadata.runtimeId) {
					finish({
						ok: false,
						error: new RuntimeClientError("runtime_unavailable", "The Orca runtime changed while the request was in flight. Retry the command.")
					});
					return;
				}
				finish({
					ok: true,
					response
				});
				return;
			}
		});
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({
				id: requestId,
				authToken: metadata.authToken,
				method,
				params,
				orchestrationCapability: envelope?.orchestrationCapability,
				orchestrationContractVersion: envelope?.orchestrationContractVersion,
				orchestrationRequestId: envelope?.orchestrationRequestId,
				compatibilityInvocationId: envelope?.compatibilityInvocationId,
				orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence
			})}\n`);
		});
	});
}
//#endregion
//#region vendor/orca/src/shared/child-process/windows-command-line.ts
/**
* Windows command-line construction.
*
* Two parsers read the line Orca hands to CreateProcess, and they disagree:
*
* - The target program's own startup code (`CommandLineToArgvW`, which the CRT and
*   Node both use) understands `\"` as a literal quote and `\\` as a literal
*   backslash.
* - `cmd.exe` — unavoidable for a `.cmd`/`.bat` target — does NOT. It counts `"`
*   naively to track quote state, and inside that state it still expands `%VAR%`.
*
* So a `\"` written for the first parser silently flips cmd's quote parity, and
* every later `&` `|` `<` `>` on the line stops being data and becomes an
* operator. Measured on Windows 11 with a real `.cmd` shim: `["a b", 'c"d',
* "e%F%g", "h&i", "j^k"]` came back as `["a b", 'c"d', "e^%F^%g", "h"]` — the
* `&` truncated the argument AND ran the remainder as a command.
*
* The encoding below satisfies both parsers at once and round-trips all of the
* adversarial cases; see windows-command-line.test.ts for the corpus.
*/
/**
* Quote one argument for `CommandLineToArgvW`, writing an embedded `"` as `""`
* rather than `\"`.
*
* Why `""` and not `\"`: both spellings decode to a literal quote, but only `""`
* leaves cmd's naive quote count even. Since the same encoding has to survive a
* cmd hop for `.cmd` targets, we pay the (identical-length) `""` spelling
* everywhere rather than keep two dialects.
*
* Backslashes are still doubled before a quote and at the end of a quoted run,
* because that part `CommandLineToArgvW` does interpret.
*/
function quoteWindows(value, escapePercent) {
	if (!(escapePercent ? /[\\"%]/ : /[\\"]/).test(value)) return `"${value}"`;
	let quoted = "\"";
	let backslashes = 0;
	for (const char of value) {
		if (char === "\\") {
			backslashes += 1;
			continue;
		}
		if (char === "\"") {
			quoted += `${"\\".repeat(backslashes * 2)}""`;
			backslashes = 0;
			continue;
		}
		if (escapePercent && char === "%") {
			quoted += `${"\\".repeat(backslashes * 2)}"^%"`;
			backslashes = 0;
			continue;
		}
		quoted += `${"\\".repeat(backslashes)}${char}`;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
/**
* Quote one argument that has to survive a cmd hop as well.
*
* Separate from `quoteWindowsArgument` rather than a boolean parameter: the
* two differ only in whether `%` is neutralised, and a flag there is easy to
* pass by accident — `values.map(quoteWindowsArgument)` hands `map`'s index in
* as the flag, which is exactly how this was first written.
*/
function quoteWindowsCmdArgument(value) {
	return quoteWindows(value, true);
}
function validateWindowsCmdArguments(values) {
	for (const value of values) if (/[\r\n]/.test(value)) throw new Error("cmd.exe cannot receive an argument containing a line break");
}
/**
* Build the argv Node should spawn to run `program` with `args` through
* `cmd.exe`, for targets cmd must interpret (`.cmd`, `.bat`).
*
* Callers must pass the result with `windowsVerbatimArguments: true` so Node
* hands the line through untouched, and must NOT set `shell: true` — that
* concatenates arguments without escaping (Node warns DEP0190) and silently
* disables `windowsHide`.
*
* `/d` skips AutoRun commands from the registry, which would otherwise run
* arbitrary user configuration before our command. `/v:off` pins delayed
* expansion off so a `!` in an argument stays literal even where the Command
* Processor registry default turns it on. `/s` makes cmd strip exactly the
* outer quote pair and treat the rest verbatim.
*/
function buildWindowsCmdShimCommandLine(program, args) {
	validateWindowsCmdArguments([program, ...args]);
	return `/d /v:off /s /c "${[program, ...args].map(quoteWindowsCmdArgument).join(" ")}"`;
}
const CMD_INTERPRETED_EXTENSIONS = [".cmd", ".bat"];
/** Whether `program` is a target Windows can only start through `cmd.exe`. */
function isCmdInterpretedProgram(program) {
	const lower = program.toLowerCase();
	return CMD_INTERPRETED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
//#endregion
//#region vendor/orca/src/shared/child-process/windows-cmd-shim-resolution.ts
/**
* Resolve an npm/pnpm-generated `.cmd` shim to the program it would have run.
*
* Why: a `.cmd` target forces the spawn through `cmd.exe /c` with every
* argument caret-escaped (see windows-command-line.ts for that encoding). A
* long `cmd.exe /c` line whose caret-escaped payload is natural-language agent
* prompt text is what Microsoft Defender for Endpoint's command-line model
* scores as obfuscation, and `codex.cmd` sits in the spawn cluster of a real
* MDE incident against Orca. These shims are generated files whose entire body
* is "find node, run this script", so reading one and spawning
* `node.exe <script> <args…>` removes cmd.exe — and with it the escaping —
* from the process tree.
*
* It also removes a real limitation: cmd's parser ends the command at a raw
* CR/LF whatever the quote state, so a multi-line agent prompt through a `.cmd`
* shim has to be rejected outright. The resolved path has no such problem.
*
* Everything here is deliberately all-or-nothing. A file that does not match a
* known shape exactly, or whose resolved target cannot be confirmed on disk,
* returns null and the caller keeps today's `cmd.exe /c` behaviour. A
* mis-resolution silently runs the wrong program or drops arguments, which is
* far worse than an EDR alert.
*/
/** Escape hatch if resolution ever picks the wrong target in the field. */
const DISABLE_FLAG = "ORCA_DISABLE_CMD_SHIM_RESOLUTION";
/** Real shims are under 2KB; anything larger is not one of these generators. */
const MAX_SHIM_BYTES = 65536;
/** Both spellings of the shim's own directory. Each already ends in `\`, so the
* separator the shim writes after it is optional and inert. */
const DP0 = String.raw`(?:%~dp0|%dp0%)\\?`;
const DP0_NODE_EXE = `"${DP0}node\\.exe"`;
const dp0Path = (group) => `"${DP0}(?<${group}>[^"\\r\\n]+)"`;
const ECHO_OFF = String.raw`@echo off\n`;
/** npm's `cmd-shim` captures its own directory through a subroutine. */
const FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`;
/** pnpm prepends its virtual-store directories so the script can resolve deps. */
const NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`;
const PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`;
/**
* Current `cmd-shim`: picks the interpreter into `%_prog%`, then runs it from a
* single trailing line. This is the shape of `codex.cmd`.
*/
const NPM_PROG_NODE_SHIM = new RegExp(String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path("script")} +%\*$`, "i");
/**
* Legacy `cmd-shim` and pnpm's `@zkochan/cmd-shim`: the same script spelled once
* per interpreter branch.
*/
const BRANCHED_NODE_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path("script")} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path("scriptElse")} +%\*\n\)$`, "i");
/** `cmd-shim` for a target that needs no interpreter (a bundled `.exe`). */
const NPM_DIRECT_SHIM = new RegExp(String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path("target")} +%\*$`, "i");
/** pnpm's equivalent, which omits `@echo off` and keeps only `@SETLOCAL`. */
const PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path("target")} +%\*$`, "i");
const UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/;
/** A target with no interpreter must be something CreateProcess can start on
* its own. Extensionless or `.cmd` targets need cmd's own PATHEXT search, which
* is exactly the hop being removed. */
const DIRECT_TARGET_EXTENSIONS = [".exe", ".com"];
/**
* A captured path must be relative to the shim's own directory and free of the
* characters that mean we misread the file — `%` is an unexpanded variable, the
* rest are cmd operators we are not emulating.
*/
function isPlainRelativePath(spelled) {
	return !UNSAFE_SHIM_PATH.test(spelled) && !node_path.win32.isAbsolute(spelled);
}
/** Collapse a shim to comparable text: shims differ only in line endings,
* indentation and blank lines between generators and versions. */
function canonicalize(contents) {
	return contents.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
}
/**
* Recognise a generated shim. Pure, so the shapes are testable off Windows.
*
* Returns paths exactly as the shim spells them, relative to its own directory.
*/
function parseWindowsCmdShim(contents) {
	const canonical = canonicalize(contents);
	const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups;
	if (prog?.script) return isPlainRelativePath(prog.script) ? {
		kind: "node",
		script: prog.script
	} : null;
	const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups;
	if (branched?.script) {
		if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) return null;
		const nodePath = branched.nodePath;
		if (nodePath === void 0) return {
			kind: "node",
			script: branched.script
		};
		if (nodePath.includes("%") || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) return null;
		return {
			kind: "node",
			script: branched.script,
			nodePathPrefix: nodePath
		};
	}
	for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
		const target = pattern.exec(canonical)?.groups?.target;
		if (target) return isPlainRelativePath(target) ? {
			kind: "direct",
			target
		} : null;
	}
	return null;
}
/** Shim bodies do not change between spawns, but an upgrade rewrites them —
* hence the mtime/size half of the key. */
const parseCache = /* @__PURE__ */ new Map();
const PARSE_CACHE_LIMIT = 256;
/**
* The interpreter each shim directory resolves to, keyed by that directory and
* the PATH that was searched.
*
* Why cached at all: the parse cache spares the shim read but not this walk, so
* a 30-entry PATH cost 30 `stat`s on every spawn of an already-parsed shim —
* synchronous I/O on `resolveSpawn`, where one dead network mount in PATH
* blocks the calling thread each time.
*
* Held for the process's life, and the two stale directions are treated
* differently on purpose:
*
* - A stale `null` is left alone. A `node.exe` installed after the first probe
*   is not picked up until restart, which only means the working cmd.exe
*   fallback stays in use — and re-probing to catch that is the whole cost this
*   cache exists to avoid.
* - A stale path is revalidated on every hit, because it is the direction that
*   breaks. `resolveSpawn` would otherwise keep returning an interpreter that
*   has since been uninstalled, failing the spawn with ENOENT where an uncached
*   process falls back to cmd.exe and succeeds. Verified by execution: without
*   the check, deleting the cached `node.exe` still yielded its path.
*
* Known gap: PATH is in the key, so a caller that rebuilds `env` per spawn with
* a varying PATH — a per-worktree `.bin` prepended, say — misses every time and
* pays the full walk. Correct, just no faster than before. The 256 cap and the
* wholesale clear mean those misses cost memory nothing, so this is a bound on
* who benefits rather than a leak.
*/
const nodeCache = /* @__PURE__ */ new Map();
const NODE_CACHE_LIMIT = 256;
function statFile(path) {
	try {
		const stats = (0, node_fs.statSync)(path);
		return stats.isFile() ? stats : null;
	} catch {
		return null;
	}
}
function readParsedShim(program) {
	const stats = statFile(program);
	if (!stats || stats.size > MAX_SHIM_BYTES) return null;
	const cached = parseCache.get(program);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.parsed;
	let contents;
	try {
		contents = (0, node_fs.readFileSync)(program, "utf8");
	} catch {
		return null;
	}
	const parsed = parseWindowsCmdShim(contents);
	if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
	parseCache.set(program, {
		mtimeMs: stats.mtimeMs,
		size: stats.size,
		parsed
	});
	return parsed;
}
/** Win32 resolves environment names case-insensitively; a JS object does not. */
function firstEnvKey(env, name) {
	const lower = name.toLowerCase();
	return Object.keys(env).find((key) => key.toLowerCase() === lower && env[key] !== void 0);
}
/** cmd's own default when PATHEXT is unset or empty. The order is the point:
* `.COM` outranks `.EXE`, so a `node.com` is what cmd runs even with a
* `node.exe` sitting beside it. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
/**
* The interpreter the shim itself would pick: a `node.exe` beside it, else
* whatever a bare `node` resolves to on PATH.
*
* The sibling test is exact, matching the shim's own literal
* `IF EXIST "%~dp0\node.exe"`. The PATH scan follows cmd's rule instead: the
* first directory holding ANY PATHEXT spelling of `node` wins, and inside that
* directory PATHEXT order decides. So a `node.com` early on PATH beats a
* `node.exe` later, and only the `.exe` outcome is one we can start directly.
* Every other winning spelling returns null and keeps the cmd.exe path, which a
* `.bat`/`.cmd` node would have needed anyway.
*
* Scanning past a non-`.exe` winner to a `node.exe` further down PATH is the
* tempting shortcut and the one bug this module must never have: it silently
* runs a different binary than the shim does. Every decision here stays a
* strict subset of what cmd.exe would pick, or gives up.
*
* Not searched: the working directory, which cmd would consult first for a bare
* name. Preferring a `node.exe` that happens to sit in the cwd over the
* installed one is a Windows footgun, not a behaviour worth reproducing.
*/
function resolveShimNode(directory, env) {
	const pathKey = firstEnvKey(env, "PATH");
	const pathValue = (pathKey ? env[pathKey] : void 0) ?? "";
	const pathExtKey = firstEnvKey(env, "PATHEXT");
	const pathExtValue = (pathExtKey ? env[pathExtKey] : void 0) || DEFAULT_PATHEXT;
	const key = `${directory}\n${pathValue}\n${pathExtValue}`;
	const cached = nodeCache.get(key);
	if (cached !== void 0 && (cached === null || statFile(cached))) return cached;
	const resolved = probeShimNode(directory, pathValue, pathExtValue);
	if (nodeCache.size >= NODE_CACHE_LIMIT) nodeCache.clear();
	nodeCache.set(key, resolved);
	return resolved;
}
function probeShimNode(directory, pathValue, pathExtValue) {
	const sibling = node_path.win32.join(directory, "node.exe");
	if (statFile(sibling)) return sibling;
	const extensions = pathExtValue.split(";").map((extension) => extension.trim().toLowerCase()).filter((extension) => extension.startsWith("."));
	for (const entry of pathValue.split(";")) {
		const trimmed = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!trimmed || !node_path.win32.isAbsolute(trimmed)) continue;
		for (const extension of extensions) {
			const candidate = node_path.win32.join(trimmed, `node${extension}`);
			if (!statFile(candidate)) continue;
			return extension === ".exe" ? candidate : null;
		}
	}
	return null;
}
function withNodePath(env, prefix) {
	const key = firstEnvKey(env, "NODE_PATH") ?? "NODE_PATH";
	const existing = env[key];
	return {
		...env,
		[key]: existing ? `${prefix};${existing}` : prefix
	};
}
/**
* Resolve `program` to the executable its shim body would have launched, or
* null to keep the `cmd.exe /c` path.
*
* `env` is the environment the child will actually receive, because both the
* PATH lookup for `node` and the NODE_PATH prepend depend on it.
*/
function resolveWindowsCmdShim(program, env) {
	const disableKey = firstEnvKey(env, DISABLE_FLAG);
	if (disableKey && env[disableKey]) return null;
	if (!node_path.win32.isAbsolute(program)) return null;
	const parsed = readParsedShim(program);
	if (!parsed) return null;
	const directory = node_path.win32.dirname(program);
	if (parsed.kind === "direct") {
		const target = node_path.win32.resolve(directory, parsed.target);
		const lower = target.toLowerCase();
		if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) return null;
		return statFile(target) ? {
			program: target,
			prefixArgs: []
		} : null;
	}
	const script = node_path.win32.resolve(directory, parsed.script);
	if (!statFile(script)) return null;
	const node = resolveShimNode(directory, env);
	if (!node) return null;
	return {
		program: node,
		prefixArgs: [script],
		...parsed.nodePathPrefix ? { env: withNodePath(env, parsed.nodePathPrefix) } : {}
	};
}
//#endregion
//#region vendor/orca/src/shared/child-process/spawn-resolution.ts
/**
* Translate a spec into the exact `child_process.spawn` call to make.
*
* Exported so the Windows branch is testable from macOS/Linux: the decisions
* below are the whole point of the spawn chokepoint, and they must not be
* observable only on the platform that breaks.
*
* Pure except on the win32 `.cmd` branch, where shim resolution does a `stat`
* and (on a cache miss) one bounded read of the shim itself. Both are inside
* try/catch and any failure falls back to the cmd.exe path, so the function
* still cannot throw or reach anything but the program path it was handed.
*/
function resolveSpawn(spec, platform) {
	const args = spec.args ?? [];
	const base = {
		cwd: spec.cwd,
		env: spec.env,
		stdio: spec.stdio ?? [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true,
		detached: spec.detached,
		windowsVerbatimArguments: spec.windowsVerbatimArguments,
		shell: false,
		...spec.terminationBarrier && platform !== "win32" ? { detached: true } : {}
	};
	if (platform !== "win32" || !isCmdInterpretedProgram(spec.program)) return {
		file: spec.program,
		args,
		options: base
	};
	const shim = resolveWindowsCmdShim(spec.program, spec.env ?? process.env);
	if (shim) return {
		file: shim.program,
		args: [...shim.prefixArgs, ...args],
		options: {
			...base,
			...shim.env ? { env: shim.env } : {},
			windowsVerbatimArguments: void 0
		}
	};
	return {
		file: spec.env?.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
		args: [buildWindowsCmdShimCommandLine(spec.program, args)],
		options: {
			...base,
			windowsVerbatimArguments: true
		}
	};
}
function admitProcessTreeKill(kill) {
	try {
		return true;
	} catch {
		return true;
	}
}
//#endregion
//#region vendor/orca/src/shared/child-process/process-tree-termination.ts
const PROBE_INTERVAL_MS = 25;
const SUBPROCESS_TIMEOUT_MS = 2e3;
const MAX_PS_OUTPUT_BYTES = 8388608;
/**
* Signal the child's whole tree.
*
* POSIX precondition: the child must have been spawned `detached`. The signal
* goes to the process group `-child.pid`, so a child that is not its own group
* leader would hand it to whatever group it inherited instead.
*
* Runs in every host — Electron main, the daemon, the relay, the CLI — so the
* own-Chromium guard arrives through `process-tree-kill-gate`, which main
* installs and every other host leaves admitting. The exit check below is what
* keeps the Windows branch off a pid that is no longer ours on those hosts.
*
* Both arms ask before walking the tree, so a refused pid never gets a
* pid-addressed kill; that also means the recorded crumb says "about to kill",
* not "killed". The root is still killed through its handle, which cannot reach
* the recycled pid the refusal was about, so a refusal is never a leak. Main's
* gate only ever refuses the `win-taskkill-tree` scope — a POSIX group holds
* only what Orca put in it — so the POSIX refusal arm is the seam's contract,
* not something any installed gate exercises today.
*/
function signalProcessTree(child, signal) {
	if (!child.pid) {
		killRoot(child, signal);
		return Promise.resolve(true);
	}
	if (process.platform === "win32") {
		if (hasExited(child)) {
			killRoot(child, signal);
			return Promise.resolve(false);
		}
		return taskkillTree(child, child.pid, signal);
	}
	if (!admitProcessTreeKill({
		pid: child.pid,
		site: "run-process-tree",
		scope: "posix-process-group"
	})) {
		killRoot(child, signal);
		return Promise.resolve(false);
	}
	try {
		process.kill(-child.pid, signal);
		return Promise.resolve(true);
	} catch {
		return Promise.resolve(!processGroupExists(child.pid));
	}
}
async function forceTerminateProcessTree(child) {
	if (!await signalProcessTree(child, "SIGKILL")) return false;
	if (process.platform !== "win32" && child.pid) return waitForPosixProcessGroupQuiescence(child.pid);
	return true;
}
/** A stubbed child leaves both undefined; only a real code or signal proves exit. */
function hasExited(child) {
	return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
}
function taskkillTree(child, rootPid, signal) {
	if (!admitProcessTreeKill({
		pid: rootPid,
		site: "run-process-tree",
		scope: "win-taskkill-tree"
	})) {
		killRoot(child, signal);
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		let killer;
		try {
			killer = (0, node_child_process.spawn)("taskkill", [
				"/pid",
				String(rootPid),
				"/t",
				"/f"
			], {
				stdio: "ignore",
				windowsHide: true,
				shell: false
			});
		} catch {
			killRoot(child, signal);
			resolve(false);
			return;
		}
		let settled = false;
		const finish = (fallback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (fallback) killRoot(child, signal);
			resolve(!fallback);
		};
		killer.once("error", () => finish(true));
		killer.once("close", (code) => finish(code !== 0));
		const timer = setTimeout(() => {
			killer.kill();
			finish(true);
		}, SUBPROCESS_TIMEOUT_MS);
		timer.unref?.();
	});
}
async function waitForPosixProcessGroupQuiescence(processGroupId) {
	const deadline = Date.now() + SUBPROCESS_TIMEOUT_MS;
	while (true) {
		const states = await readPosixProcessGroupStates(processGroupId);
		if (states ? states.every((state) => state.startsWith("Z")) : !processGroupExists(processGroupId)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
	}
}
function readPosixProcessGroupStates(processGroupId) {
	return new Promise((resolve) => {
		let probe;
		try {
			probe = (0, node_child_process.spawn)("ps", ["-axo", "pgid=,state="], {
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				],
				windowsHide: true,
				shell: false
			});
		} catch {
			resolve(null);
			return;
		}
		let output = "";
		let truncated = false;
		let settled = false;
		const finish = (states) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(states);
		};
		probe.stdout?.on("data", (chunk) => {
			const text = chunk.toString();
			if (output.length + text.length > MAX_PS_OUTPUT_BYTES) {
				truncated = true;
				return;
			}
			output += text;
		});
		probe.stdout?.on("error", () => {});
		probe.once("error", () => finish(null));
		probe.once("close", (code) => {
			if (code !== 0 || truncated) {
				finish(null);
				return;
			}
			const states = output.split("\n").flatMap((line) => {
				const match = line.trim().match(/^(\d+)\s+(\S+)/);
				return match && Number(match[1]) === processGroupId ? [match[2]] : [];
			});
			finish(states);
		});
		const timer = setTimeout(() => {
			probe.kill();
			finish(null);
		}, SUBPROCESS_TIMEOUT_MS);
		timer.unref?.();
	});
}
function processGroupExists(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}
function killRoot(child, signal) {
	try {
		child.kill(signal);
	} catch {}
}
function hasSpawnObserver() {
	return false;
}
//#endregion
//#region vendor/orca/src/shared/growing-byte-buffer.ts
var GrowingByteBuffer = class {
	storage = Buffer.alloc(0);
	start = 0;
	length = 0;
	get byteLength() {
		return this.length;
	}
	append(bytes) {
		if (bytes.byteLength === 0) return;
		const required = this.length + bytes.byteLength;
		if (this.start + required > this.storage.byteLength) this.reclaimHeadRoom(required);
		(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).copy(this.storage, this.start + this.length);
		this.length = required;
	}
	appendRetainedSuffix(bytes, maxBytes) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Retained suffix limit must be a non-negative safe integer");
		if (maxBytes === 0) {
			this.clear();
			return;
		}
		const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (source.byteLength >= maxBytes) {
			this.storage = Buffer.from(source.subarray(source.byteLength - maxBytes));
			this.start = 0;
			this.length = maxBytes;
			return;
		}
		this.retainSuffix(maxBytes - source.byteLength);
		this.append(source);
	}
	indexOfByte(value, byteOffset = 0) {
		return this.storage.subarray(this.start, this.start + this.length).indexOf(value, byteOffset);
	}
	takePrefixString(byteLength, encoding = "utf8") {
		if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) throw new RangeError("Prefix length exceeds retained bytes");
		const value = this.storage.toString(encoding, this.start, this.start + byteLength);
		this.discardPrefix(byteLength);
		return value;
	}
	discardPrefix(byteLength) {
		if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) throw new RangeError("Prefix length exceeds retained bytes");
		this.start += byteLength;
		this.length -= byteLength;
		if (this.length === 0) this.start = 0;
	}
	retainSuffix(maxBytes) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Suffix limit must be a non-negative safe integer");
		if (this.length <= maxBytes) return;
		this.start += this.length - maxBytes;
		this.length = maxBytes;
		if (this.length === 0) this.start = 0;
	}
	toString(encoding = "utf8") {
		return this.storage.toString(encoding, this.start, this.start + this.length);
	}
	toBuffer() {
		return Buffer.from(this.storage.subarray(this.start, this.start + this.length));
	}
	takeString(encoding = "utf8") {
		const value = this.toString(encoding);
		this.clear();
		return value;
	}
	takeBuffer() {
		const value = this.storage.subarray(this.start, this.start + this.length);
		this.clear();
		return value;
	}
	clear() {
		this.storage = Buffer.alloc(0);
		this.start = 0;
		this.length = 0;
	}
	reclaimHeadRoom(required) {
		if (required * 2 <= this.storage.byteLength) this.storage.copy(this.storage, 0, this.start, this.start + this.length);
		else {
			const capacity = Math.max(required, Math.max(256, this.storage.byteLength * 2));
			const next = Buffer.allocUnsafe(capacity);
			this.storage.copy(next, 0, this.start, this.start + this.length);
			this.storage = next;
		}
		this.start = 0;
	}
};
//#endregion
//#region vendor/orca/src/shared/child-process/bounded-output-sink.ts
/**
* Collects output up to a cap, so a chatty child cannot grow the heap.
*
* Accepts strings as well as buffers: a stream someone called `setEncoding` on
* emits strings, and concatenating those as buffers throws inside a `data`
* handler, where the rejection has nowhere to go and the caller just hangs.
*/
function createOutputSink(maxBytes, outputCapture = "head") {
	const chunks = [];
	const tail = outputCapture === "tail" ? new GrowingByteBuffer() : void 0;
	let bytes = 0;
	const buffer = () => tail ? tail.toBuffer() : chunks.length === 0 ? node_buffer.Buffer.alloc(0) : chunks.length === 1 ? chunks[0] : node_buffer.Buffer.concat(chunks);
	return {
		buffer,
		write(raw) {
			const chunk = node_buffer.Buffer.isBuffer(raw) ? raw : node_buffer.Buffer.from(raw);
			const remaining = maxBytes - bytes;
			bytes += chunk.length;
			if (tail) {
				tail.appendRetainedSuffix(chunk, maxBytes);
				return;
			}
			if (remaining <= 0) return;
			chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
		},
		text: () => tail?.toString() ?? buffer().toString("utf8"),
		truncated: () => bytes > maxBytes
	};
}
//#endregion
//#region vendor/orca/src/shared/child-process/child-termination-reporter.ts
function createChildTerminationReporter(callback) {
	let reported = false;
	const report = () => {
		if (reported) return;
		reported = true;
		callback?.();
	};
	return {
		report,
		reportIf: (confirmed) => confirmed ? report() : void 0
	};
}
//#endregion
//#region vendor/orca/src/shared/child-process/run-process.ts
/**
* Grace between the timeout kill and giving up on the child's exit.
*
* Why give up at all: `close` only fires once the child is actually gone, and a
* child that ignores the kill never emits it -- so the promise would outlive
* its own deadline forever. Callers that cache an in-flight probe (the pwsh
* availability cache, the process-table reader) would then hand every later
* caller the same dead promise.
*/
const PROCESS_EXIT_GRACE_MS = 2e3;
/**
* Last resort for a barrier caller once tree termination could not be verified.
*
* Why bounded: waiting for the root's exit is what stops an unverified caller
* mutating shared state under a live child, but a tree that neither dies nor
* reports would otherwise leave the promise pending for the app's lifetime.
*/
const BARRIER_UNVERIFIED_EXIT_GRACE_MS = 1e4;
/**
* Start a child process. Use for long-lived or streaming children.
*
* The caller owns the returned streams, including their `error` events — an
* unhandled one is an uncaught exception that takes the main process down.
* `runProcess` handles that for you; here it cannot, because a blanket handler
* would also defeat callers that track and remove their own listeners.
*/
function spawnProcess(spec) {
	const resolved = resolveSpawn(spec, process.platform);
	const spawnStartedAt = hasSpawnObserver() ? performance.now() : null;
	const child = (0, node_child_process.spawn)(resolved.file, [...resolved.args], resolved.options);
	if (spawnStartedAt !== null) resolved.file, resolved.args, performance.now() - spawnStartedAt;
	return child;
}
/**
* Run a child process to completion and capture its output.
*
* Never rejects on a non-zero exit — the exit code is data. Rejects only when
* the process could not be started at all.
* Tail capture keeps final diagnostics without changing termination policy.
*/
function runProcess(spec, outputCapture = "head") {
	if (spec.signal?.aborted) {
		spec.onChildTerminated?.();
		return Promise.resolve({
			code: null,
			signal: null,
			stdout: "",
			stderr: "",
			timedOut: false
		});
	}
	const maxOutputBytes = spec.maxOutputBytes ?? 8388608;
	return new Promise((resolve, reject) => {
		const terminationReporter = createChildTerminationReporter(spec.onChildTerminated);
		let child;
		try {
			child = spawnProcess(spec);
		} catch (error) {
			terminationReporter.report();
			reject(error);
			return;
		}
		const stdout = createOutputSink(maxOutputBytes, outputCapture);
		const stderr = createOutputSink(maxOutputBytes, outputCapture);
		let timedOut = false;
		let settled = false;
		let barrierStopping = false;
		let barrierAttemptComplete = false;
		let barrierTerminationVerified = false;
		let initialBarrierTermination;
		let deferredExit = null;
		let deferredClose = null;
		let deferredError = null;
		let rootExitedBeforeBarrier = false;
		const settle = (act) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(graceTimer);
			clearTimeout(barrierDeadlineTimer);
			spec.signal?.removeEventListener("abort", onAbort);
			act();
		};
		child.stdout?.on("data", (chunk) => {
			stdout.write(chunk);
			if (spec.killOnOutputLimit && stdout.truncated()) stopAndSettle();
		});
		child.stderr?.on("data", (chunk) => {
			stderr.write(chunk);
			if (spec.killOnOutputLimit && stderr.truncated()) stopAndSettle();
			if (typeof spec.terminationBarrier === "object") spec.terminationBarrier.observeStderr?.(chunk);
		});
		for (const stream of [
			child.stdin,
			child.stdout,
			child.stderr
		]) stream?.on("error", () => {});
		let graceTimer;
		let barrierDeadlineTimer;
		const signalBarrierTree = (signal) => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.signal(child, signal) : signalProcessTree(child, signal)).catch(() => false);
		const forceBarrierTree = () => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.force(child) : forceTerminateProcessTree(child)).catch(() => false);
		const resolveFromClose = (code, signal) => settle(() => resolve({
			code,
			signal,
			stdout: spec.captureStdoutAsBytes ? "" : stdout.text(),
			...spec.captureStdoutAsBytes ? { stdoutBytes: stdout.buffer() } : {},
			stderr: stderr.text(),
			timedOut,
			outputTruncated: stdout.truncated() || stderr.truncated()
		}));
		const settleBarrierOutcome = () => {
			const rootExit = deferredClose ?? deferredExit;
			if (deferredError) {
				settle(() => reject(deferredError));
				return;
			}
			resolveFromClose(rootExit?.code ?? null, rootExit?.signal ?? null);
		};
		const resolveBarrierIfSafe = () => {
			if (barrierTerminationVerified || rootExitedBeforeBarrier && (deferredClose ?? deferredExit)) {
				settleBarrierOutcome();
				return;
			}
			if (!barrierAttemptComplete) return;
			barrierDeadlineTimer ??= setTimeout(settleBarrierOutcome, BARRIER_UNVERIFIED_EXIT_GRACE_MS);
			barrierDeadlineTimer.unref?.();
		};
		/**
		* Stop the child, then settle.
		*
		* Without a barrier, settle whether or not the child complies. With one, wait
		* for verified tree termination or a root exit first — a descendant can keep
		* `close` pending after the root exits, but failed verification must not let
		* callers mutate shared state — then settle on the deadline regardless.
		*/
		const stopAndSettle = () => {
			if (spec.terminationBarrier) {
				barrierStopping = true;
				initialBarrierTermination ??= signalBarrierTree();
				if (process.platform === "win32") initialBarrierTermination.then((terminated) => {
					if (!terminated) return;
					barrierAttemptComplete = true;
					barrierTerminationVerified = true;
					terminationReporter.report();
					resolveBarrierIfSafe();
				});
			} else terminate(child);
			graceTimer ??= setTimeout(() => {
				if (spec.terminationBarrier) {
					const initialTermination = initialBarrierTermination ?? Promise.resolve(false);
					if (process.platform === "win32") {
						if (typeof spec.terminationBarrier === "object") {
							Promise.all([initialTermination, forceBarrierTree()]).then(([initialTerminated, forceTerminated]) => {
								barrierAttemptComplete = true;
								barrierTerminationVerified = initialTerminated || forceTerminated;
								terminationReporter.reportIf(barrierTerminationVerified);
								if (!barrierTerminationVerified) terminate(child, "SIGKILL");
								resolveBarrierIfSafe();
							});
							return;
						}
						initialTermination.then((terminated) => {
							if (!terminated) terminate(child, "SIGKILL");
							barrierAttemptComplete = true;
							barrierTerminationVerified = terminated;
							terminationReporter.reportIf(barrierTerminationVerified);
							resolveBarrierIfSafe();
						});
						return;
					}
					Promise.all([initialTermination, forceBarrierTree()]).then(([_initialTerminated, forceTerminated]) => {
						barrierAttemptComplete = true;
						barrierTerminationVerified = forceTerminated;
						terminationReporter.reportIf(barrierTerminationVerified);
						if (!barrierTerminationVerified) terminate(child, "SIGKILL");
						resolveBarrierIfSafe();
					});
					return;
				}
				terminate(child, "SIGKILL");
				resolveFromClose(null, null);
			}, PROCESS_EXIT_GRACE_MS);
			graceTimer.unref?.();
		};
		const timer = spec.timeoutMs === null ? void 0 : setTimeout(() => {
			timedOut = true;
			stopAndSettle();
		}, spec.timeoutMs ?? 3e4);
		timer?.unref?.();
		const onAbort = () => stopAndSettle();
		spec.signal?.addEventListener("abort", onAbort, { once: true });
		if (spec.signal?.aborted) onAbort();
		child.once("error", (error) => {
			terminationReporter.reportIf(!child.pid);
			if (barrierStopping) {
				deferredError = error;
				resolveBarrierIfSafe();
				return;
			}
			settle(() => reject(error));
		});
		child.once("exit", (code, signal) => {
			if (!barrierStopping) rootExitedBeforeBarrier = true;
			deferredExit = {
				code,
				signal
			};
			if (barrierStopping) resolveBarrierIfSafe();
		});
		child.once("close", (code, signal) => {
			terminationReporter.report();
			if (!barrierStopping) rootExitedBeforeBarrier = true;
			if (barrierStopping) {
				deferredClose = {
					code,
					signal
				};
				resolveBarrierIfSafe();
				return;
			}
			resolveFromClose(code, signal);
		});
		child.stdin?.end(spec.input);
	});
}
/** Best-effort root termination, or whole-tree termination for barrier callers. */
function terminate(child, signal) {
	try {
		child.kill(signal);
	} catch {}
}
//#endregion
//#region vendor/orca/src/shared/orca-cli-command-name.ts
function getOrcaCliCommandNameForPlatform(platform) {
	if (platform === "linux") return "orca-ide";
	if (platform === "win32") return "orca.cmd";
	return "orca";
}
//#endregion
//#region vendor/orca/src/shared/tui-agent-config.ts
function resolveTuiAgentConfig(source) {
	return {
		...source,
		launchCmd: source.launchCmd ?? source.detectCmd,
		expectedProcess: source.expectedProcess ?? source.detectCmd
	};
}
const TUI_AGENT_CONFIG_SOURCE = {
	claude: {
		detectCmd: "claude",
		promptInjectionMode: "argv",
		pasteNeedsTypedRequest: true,
		draftPromptFlag: "--prefill",
		preflightTrust: "claude"
	},
	"claude-agent-teams": {
		detectCmd: "orca",
		detectCmdAliases: ["orca-dev", "orca-ide"],
		detectRequiredCommands: ["claude"],
		detectUnsupportedRuntimes: ["win32", "wsl"],
		launchCmd: "orca claude-teams",
		launchCmdByPlatform: {
			linux: `${getOrcaCliCommandNameForPlatform("linux")} claude-teams`,
			win32: `${getOrcaCliCommandNameForPlatform("win32")} claude-teams`
		},
		expectedProcess: "claude",
		promptInjectionMode: "stdin-after-start",
		pasteNeedsTypedRequest: true,
		preflightTrust: "claude"
	},
	codebuddy: {
		detectCmd: "codebuddy",
		detectCmdAliases: ["cbc"],
		promptInjectionMode: "argv"
	},
	openclaude: {
		detectCmd: "openclaude",
		promptInjectionMode: "argv",
		draftPromptFlag: "--prefill"
	},
	codex: {
		detectCmd: "codex",
		promptInjectionMode: "argv",
		windowsInputRecordPasteNewline: "alt-enter",
		preflightTrust: "codex",
		draftPasteReadySignal: "codex-composer-prompt",
		draftPasteReadyTimeoutMs: 2e4,
		submitRetryDelayMs: 1200
	},
	autohand: {
		detectCmd: "autohand",
		promptInjectionMode: "stdin-after-start"
	},
	ante: {
		detectCmd: "ante",
		promptInjectionMode: "stdin-after-start"
	},
	trae: {
		detectCmd: "traecli",
		promptInjectionMode: "argv",
		argvPromptSeparator: "--"
	},
	opencode: {
		detectCmd: "opencode",
		promptInjectionMode: "flag-prompt",
		draftPasteReadySignal: "render-cursor-after-bracketed-paste",
		draftPasteReadyTimeoutMs: 2e4,
		composerReadyCaptures: [
			"opencode-1-18-32-timed-boot-slow",
			"opencode-1-18-32-timed-boot-hidden-pane",
			"opencode-1-18-32-timed-first-launch"
		]
	},
	opencode2: {
		detectCmd: "opencode2",
		launchCmd: "opencode2 --standalone",
		promptInjectionMode: "flag-prompt",
		draftPasteReadySignal: "render-cursor-after-bracketed-paste",
		draftPasteReadyTimeoutMs: 2e4,
		composerReadyCaptures: ["opencode-2-0-18-timed-boot-hidden-pane"]
	},
	"mimo-code": {
		detectCmd: "mimo",
		promptInjectionMode: "flag-prompt",
		draftPasteReadySignal: "render-cursor-after-bracketed-paste"
	},
	pi: {
		detectCmd: "pi",
		promptInjectionMode: "argv",
		draftPromptEnvVar: "ORCA_PI_PREFILL",
		windowsShiftEnterEncoding: "csi-u"
	},
	omp: {
		detectCmd: "omp",
		promptInjectionMode: "argv",
		draftPromptEnvVar: "ORCA_OMP_PREFILL",
		windowsShiftEnterEncoding: "csi-u"
	},
	"prime-agent": {
		detectCmd: "prime-agent",
		promptInjectionMode: "argv",
		argvPromptSeparator: "--",
		windowsShiftEnterEncoding: "csi-u"
	},
	qoder: {
		detectCmd: "qodercli",
		promptInjectionMode: "flag-prompt-interactive",
		preflightTrust: "qoder"
	},
	"qoder-cn": {
		detectCmd: "qoderclicn",
		detectCmdAliases: ["qodercn"],
		promptInjectionMode: "flag-prompt-interactive",
		preflightTrust: "qoder-cn"
	},
	gemini: {
		detectCmd: "gemini",
		promptInjectionMode: "flag-prompt-interactive"
	},
	antigravity: {
		detectCmd: "agy",
		promptInjectionMode: "flag-prompt-interactive",
		preflightTrust: "antigravity",
		submitLineSettleMsPerLine: 45
	},
	aider: {
		detectCmd: "aider",
		promptInjectionMode: "stdin-after-start"
	},
	goose: {
		detectCmd: "goose",
		promptInjectionMode: "stdin-after-start"
	},
	amp: {
		detectCmd: "amp",
		promptInjectionMode: "stdin-after-start"
	},
	kilo: {
		detectCmd: "kilo",
		promptInjectionMode: "stdin-after-start"
	},
	kiro: {
		detectCmd: "kiro-cli",
		launchCmd: "kiro-cli chat --tui",
		promptInjectionMode: "stdin-after-start"
	},
	crush: {
		detectCmd: "crush",
		promptInjectionMode: "stdin-after-start"
	},
	aug: {
		detectCmd: "auggie",
		promptInjectionMode: "stdin-after-start"
	},
	cline: {
		detectCmd: "cline",
		promptInjectionMode: "stdin-after-start"
	},
	freebuff: {
		detectCmd: "freebuff",
		promptInjectionMode: "stdin-after-start"
	},
	codebuff: {
		detectCmd: "codebuff",
		promptInjectionMode: "stdin-after-start"
	},
	"command-code": {
		detectCmd: "command-code",
		launchCmd: "command-code --trust",
		promptInjectionMode: "argv"
	},
	continue: {
		detectCmd: "cn",
		promptInjectionMode: "stdin-after-start"
	},
	cursor: {
		detectCmd: "cursor-agent",
		promptInjectionMode: "argv",
		preflightTrust: "cursor"
	},
	droid: {
		detectCmd: "droid",
		promptInjectionMode: "argv",
		windowsShiftEnterEncoding: "csi-u",
		ctrlEnterEncoding: "csi-u"
	},
	kimi: {
		detectCmd: "kimi",
		detectCmdAliases: ["kimi-code"],
		promptInjectionMode: "stdin-after-start"
	},
	"mistral-vibe": {
		detectCmd: "vibe",
		detectCmdAliases: ["mistral-vibe"],
		promptInjectionMode: "stdin-after-start"
	},
	"qwen-code": {
		detectCmd: "qwen",
		promptInjectionMode: "stdin-after-start"
	},
	rovo: {
		detectCmd: "rovo",
		promptInjectionMode: "stdin-after-start"
	},
	hermes: {
		detectCmd: "hermes",
		launchCmd: "hermes --tui",
		promptInjectionMode: "hermes-query"
	},
	openclaw: {
		detectCmd: "openclaw",
		promptInjectionMode: "stdin-after-start"
	},
	copilot: {
		detectCmd: "copilot",
		promptInjectionMode: "flag-interactive",
		preflightTrust: "copilot"
	},
	grok: {
		detectCmd: "grok",
		promptInjectionMode: "argv",
		argvPromptSeparator: "--",
		draftPasteReadySignal: "grok-composer-prompt",
		ctrlEnterEncoding: "csi-u"
	},
	muse: {
		detectCmd: "muse",
		launchCmd: "muse --trust-workspace",
		promptInjectionMode: "stdin-after-start"
	},
	dsh: {
		detectCmd: "dsh-tui",
		detectCmdAliases: ["dst"],
		detectRequiredCommands: ["dsh"],
		launchCmd: "dsh-tui .",
		expectedProcess: "dsh",
		promptInjectionMode: "stdin-after-start",
		draftPasteReadySignal: "dsh-composer-prompt"
	},
	zcode: {
		detectCmd: "zcode",
		expectedProcess: "zcode-cli",
		promptInjectionMode: "stdin-after-start",
		draftPasteReadySignal: "zcode-composer-prompt",
		composerReadyCaptures: ["zcode-composer-ready"]
	},
	devin: {
		detectCmd: "devin",
		promptInjectionMode: "stdin-after-start"
	},
	jcode: {
		detectCmd: "jcode",
		launchCmd: "jcode",
		expectedProcess: "jcode",
		promptInjectionMode: "stdin-after-start"
	}
};
const TUI_AGENT_CONFIG = Object.fromEntries(Object.entries(TUI_AGENT_CONFIG_SOURCE).map(([agent, source]) => [agent, resolveTuiAgentConfig(source)]));
function getTuiAgentDetectCommands(config) {
	return [config.detectCmd, ...config.detectCmdAliases ?? []];
}
function getTuiAgentLaunchCommand(config, platform, opts) {
	if (opts?.isRemote && platform === "linux") return config.launchCmd;
	return config.launchCmdByPlatform?.[platform] ?? config.launchCmd;
}
//#endregion
//#region vendor/orca/src/shared/ai-vault-types.ts
const AI_VAULT_AGENT_LABELS = {
	claude: "Claude",
	codebuddy: "CodeBuddy",
	qoder: "Qoder",
	codex: "Codex",
	hermes: "Hermes",
	pi: "Pi",
	omp: "OMP",
	"prime-agent": "Prime Agent",
	cursor: "Cursor",
	gemini: "Gemini",
	antigravity: "Antigravity",
	rovo: "Rovo Dev",
	copilot: "GitHub Copilot",
	opencode: "OpenCode",
	opencode2: "OpenCode 2",
	zcode: "ZCode",
	grok: "Grok",
	openclaw: "OpenClaw",
	devin: "Devin",
	droid: "Droid",
	cline: "Cline",
	kimi: "Kimi",
	muse: "Muse",
	jcode: "Jcode"
};
function aiVaultAgentLabel(agent) {
	return AI_VAULT_AGENT_LABELS[agent];
}
//#endregion
//#region vendor/orca/src/shared/wsl-paths.ts
const SLASH_CHAR_CODE = "/".charCodeAt(0);
const BACKSLASH_CHAR_CODE = "\\".charCodeAt(0);
function isPathSeparatorCharCode(charCode) {
	return charCode === SLASH_CHAR_CODE || charCode === BACKSLASH_CHAR_CODE;
}
function parseWslUncPath(path) {
	if (!isPathSeparatorCharCode(path.charCodeAt(0)) || !isPathSeparatorCharCode(path.charCodeAt(1))) return null;
	const match = (path.includes("\\") ? path.replace(/\\/g, "/") : path).match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
	if (!match) return null;
	return {
		distro: match[2],
		linuxPath: match[3] || "/"
	};
}
//#endregion
//#region vendor/orca/src/shared/harness-injected-user-turns.ts
const LEADING_TAG_NAME = /^<([a-z][a-z0-9-]*)(?:[\s>]|$)/;
const KNOWN_HARNESS_TAG_NAMES = /* @__PURE__ */ new Set([
	"agent-message",
	"bash-input",
	"bash-stderr",
	"bash-stdout",
	"command-args",
	"command-message",
	"command-name",
	"cross-session-message",
	"fork-boilerplate",
	"local-command-caveat",
	"local-command-stderr",
	"local-command-stdout",
	"mcp-polling-update",
	"mcp-resource-update",
	"system-reminder",
	"task-notification",
	"teammate-message",
	"user-memory-input",
	"user-prompt-submit-hook"
]);
const HARNESS_INJECTED_TURN_PREFIXES = [
	"<channel source=",
	"[request interrupted",
	"a message arrived from ",
	"another claude session sent a message",
	"no response requested.",
	"caveat: the messages below were generated by the user while running local commands",
	"this session is being continued from a previous conversation"
];
const HARNESS_CLASSIFY_HEAD_LIMIT = 256;
const HARNESS_CLASSIFY_LEADING_WS_LIMIT = 64;
/** True only for observed harness shapes. Match on trimmed, lowercased text.
*  Unknown kebab tags stay user turns — only tags we have observed count. */
function isKnownHarnessInjectedUserTurnText(text) {
	const normalized = normalizedHarnessTurnHead(text);
	if (!normalized) return false;
	const tagName = LEADING_TAG_NAME.exec(normalized)?.[1];
	if (tagName && KNOWN_HARNESS_TAG_NAMES.has(tagName)) return true;
	return HARNESS_INJECTED_TURN_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function normalizedHarnessTurnHead(text) {
	let start = 0;
	const wsScanEnd = Math.min(text.length, HARNESS_CLASSIFY_LEADING_WS_LIMIT);
	while (start < wsScanEnd && isAsciiWhitespace(text.charCodeAt(start))) start += 1;
	if (start >= text.length) return "";
	const headEnd = Math.min(text.length, start + HARNESS_CLASSIFY_HEAD_LIMIT);
	return text.slice(start, headEnd).toLowerCase();
}
function isAsciiWhitespace(code) {
	return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}
//#endregion
//#region vendor/orca/src/shared/antigravity-session-origin.ts
const ANTIGRAVITY_HISTORY_ROOTS = [
	"antigravity-cli",
	"antigravity-ide",
	"antigravity"
];
function antigravitySessionOrigin(filePath) {
	const segments = filePath.split(/[\\/]+/).filter(Boolean);
	const brainIndex = segments.lastIndexOf("brain");
	if (brainIndex < 2 || segments[brainIndex - 2] !== ".gemini") return null;
	return ANTIGRAVITY_HISTORY_ROOTS.find((origin) => origin === segments[brainIndex - 1]) ?? null;
}
function isAntigravityReferenceSession(session) {
	const origin = session.filePath ? antigravitySessionOrigin(session.filePath) : null;
	return session.agent === "antigravity" && origin !== null && origin !== "antigravity-cli";
}
function antigravityTranscriptReferencePrompt(filePath) {
	return `Review the chat transcript at ${JSON.stringify(filePath)}. Confirm your understanding of the previous conversation and continue from where it left off. This starts a new CLI conversation using the original transcript as a reference.`;
}
//#endregion
//#region vendor/orca/src/shared/ai-vault-resume-path.ts
function normalizeAiVaultResumeFilePath(filePath, platform) {
	if (!filePath || platform !== "linux") return filePath;
	return parseWslUncPath(filePath)?.linuxPath ?? filePath;
}
//#endregion
//#region vendor/orca/src/shared/powershell-native-argument.ts
function quotePowerShellLiteral(value) {
	return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}
//#endregion
//#region vendor/orca/src/shared/tui-agent-startup-shell.ts
/** True for the sh-family grammar: `NAME=value cmd` prefixes, `sh -c` wrapping
*  and `;` chaining. fish parses all three, so this holds for fish too. */
function isPosixStartupShell(shell) {
	return shell === "posix";
}
function isWindowsStartupShell(shell) {
	return shell === "powershell" || shell === "cmd";
}
/**
* Quotes one argument so the SAME text is literal in every Unix shell Orca can
* be typing into — sh, bash, zsh, dash and fish.
*
* Why not plain sh quoting: fish's single quotes are not literal. Inside `'…'`
* it treats `\\` and `\'` as escapes, so the sh `'\''` idiom collapses every
* backslash (a `\d+` regex, a `\\server\share` UNC path) and a trailing
* backslash is a hard syntax error that kills the launch outright.
*
* Both shell families agree on two things: a single-quoted run is literal apart
* from those escapes, and `"\\"` is one backslash. So emitting backslashes as
* `"\\"` and apostrophes as `"'"` between single-quoted runs round-trips in all
* of them, and Orca never has to know which shell will read the line.
*
* Verified against sh, bash, zsh, dash and fish 4.7.1 over regex escapes, UNC
* and drive paths, trailing/lone backslashes, mixed quotes, `$`/backtick/`$()`
* expansions, globs, braces, operators, comments, newlines, tabs and non-BMP
* unicode — see fish-startup-arg-quoting.live-fish.test.ts.
*/
function quotePortableUnixArg(value) {
	if (!value) return "''";
	const parts = [];
	let literal = "";
	const flushLiteral = () => {
		if (literal) {
			parts.push(`'${literal}'`);
			literal = "";
		}
	};
	for (const char of value) if (char === "'") {
		flushLiteral();
		parts.push(`"'"`);
	} else if (char === "\\") {
		flushLiteral();
		parts.push(`"\\\\"`);
	} else literal += char;
	flushLiteral();
	return parts.join("");
}
function quoteStartupArg(value, shell) {
	if (shell === "powershell") return quotePowerShellLiteral(value);
	if (shell === "cmd") return `"${value.replace(/([\^&|<>()%!"])/g, "^$1")}"`;
	return quotePortableUnixArg(value);
}
/**
* Clears one or more environment variables, in a form correct in every shell a
* queued command line can land in.
*
* Why it carries its own fish/sh branch rather than a single builtin: `unset`
* does not exist in fish, and `set -e` in bash enables errexit rather than
* clearing anything, so neither spelling is safe alone.
*
* Why not a helper function defined by Orca's shell wrappers: Orca only wraps
* zsh, bash and fish. A login shell of `sh`, `dash` or `ksh` launches
* UNWRAPPED, and this text is also copied to the clipboard and pasted into
* shells Orca never spawned — in all of those a helper would be `command not
* found`, which is the exact failure this exists to avoid.
*
* Why two statements rather than `A && B || C`: in fish, `set -e` on a variable
* that is already unset returns non-zero, so an `||` fallback would run the sh
* branch too and print `Unknown command: unset`. Each branch is guarded by its
* own test, so exactly one runs and the other is only parsed.
*
* The trailing `true` pins the exit status at 0: the guard that does NOT fire
* leaves a non-zero status behind, and this is the last statement of a launch
* line, so that status is what the user's prompt would render.
*
* `command test` rather than `test`, because an interactive shell expands
* aliases and `alias test=...` would otherwise skip both branches silently.
*
* `set --erase` rather than `set -e`, because `$fish_pid` is a heuristic: any
* non-empty value takes the fish branch. `set -e NAME` in the sh family enables
* errexit and replaces the positional parameters, silently changing the
* semantics of everything after it. `set --erase NAME` is the same erase in
* fish, but in sh `--` ends option parsing, so a misfire is a usage message on
* stderr and nothing else.
*
* `$fish_pid` is set by fish 3.0+ and by nothing in the sh family, and fish
* does not export it, so a fish parent cannot make a bash child misread itself.
*
* `-g` is not optional: it scopes the erase to fish's GLOBAL scope, which is
* where an inherited environment variable lands. Without it, a name that exists
* only as a UNIVERSAL — `set -Ux CODEX_HOME …`, a perfectly normal thing for a
* fish user to have — is permanently deleted from every future session. That is
* real data loss to undo one launch's injection, and it is reachable from the
* clipboard command, which a user may run with no Orca-injected value at all.
* With `-g`, a universal shadowed by an injected global is revealed again
* instead, which is the wanted outcome.
*
* KNOWN LIMIT: under `set -u` the sh side aborts on the unset `$fish_pid` and
* the variable survives. `${fish_pid-}` would be nounset-safe but is a fish
* parse error, and so is `set +u`.
*
* The one spelling that does satisfy both is a fish-builtin probe — e.g.
* `math 1 >/dev/null 2>&1 && … || …` — because it references no variable at
* all. Rejected deliberately: it EXECUTES whatever that name resolves to on
* the user's PATH, twice. `math` is a real binary (Wolfram Mathematica ships
* `/usr/local/bin/math`); measured with one on PATH, clearing a single variable
* took 10.4s and then did not clear it, because a probe that exits 0 is an
* unconditional false positive. Trading a rare uncleared prefill for an
* arbitrary program execution on the launch path is the wrong direction.
*
* Verified to clear the variables, write nothing to stderr and exit 0 — whether
* they were set or already unset — in sh, bash, zsh, dash, ksh and fish.
*/
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function clearEnvCommand(name, shell) {
	const names = typeof name === "string" ? [name] : [...name];
	for (const each of names) if (!ENV_VAR_NAME.test(each)) throw new Error(`clearEnvCommand: ${JSON.stringify(each)} is not an environment variable name`);
	if (shell === "powershell") return names.map((each) => `Remove-Item Env:${each} -ErrorAction SilentlyContinue`).join("; ");
	if (shell === "cmd") return names.map((each) => `set "${each}="`).join(" & ");
	const joined = names.join(" ");
	return `command test -n "$fish_pid" && set --erase -g ${joined}; command test -z "$fish_pid" && unset ${joined}; true`;
}
/**
* Prefix that runs `command` with `names` removed from its environment.
*
* Why this and not `clearEnvCommand` for a copied command: `clearEnvCommand`
* mutates the *calling* shell, so it needs a shell-specific branch, and every
* spelling of that branch touches `$fish_pid` — an unbound expansion that aborts
* the whole line under `set -u`, taking the agent launch with it. This prefix
* only has to change the CHILD's environment, which `env -u` does with no shell
* syntax and no variable expansion at all. Verified identical in sh, bash, zsh,
* dash, ksh and fish, including under `set -u`.
*/
function withoutEnvCommand(names, command, shell) {
	if (names.length === 0) return command;
	if (isWindowsStartupShell(shell)) return `${clearEnvCommand(names, shell)}${commandSeparator(shell)}${command}`;
	for (const name of names) if (!ENV_VAR_NAME.test(name)) throw new Error(`withoutEnvCommand: ${JSON.stringify(name)} is not an environment variable name`);
	return `env ${names.map((name) => `-u ${name}`).join(" ")} ${command}`;
}
function commandSeparator(shell) {
	return shell === "cmd" ? " & " : "; ";
}
//#endregion
//#region vendor/orca/src/shared/ai-vault-resume-command.ts
function buildAiVaultResumeCommand(args) {
	const { agent, sessionId, cwd, platform, commandOverride, codexHome, resumeFilePath, shell } = args;
	const baseCommand = commandOverride?.trim() || defaultAiVaultResumeCommandBase(agent);
	const resumeTarget = (agent === "omp" || agent === "prime-agent") && resumeFilePath?.trim() ? resumeFilePath.trim() : sessionId;
	const sessionArg = shell === "cmd" ? quoteWindowsCmdArg(resumeTarget) : shell ? quoteStartupArg(resumeTarget, shell) : quoteShellArg(resumeTarget, platform);
	const referencePath = normalizeAiVaultResumeFilePath(resumeFilePath ?? void 0, platform);
	return buildAiVaultResumeShellCommand({
		resumeCommand: isAntigravityReferenceSession({
			agent,
			filePath: referencePath
		}) && referencePath ? `${baseCommand} --prompt-interactive ${quoteResumeArg(antigravityTranscriptReferencePrompt(referencePath), platform, shell)}` : buildAgentResumeInvocation(agent, baseCommand, sessionArg),
		cwd,
		platform,
		codexHome,
		shell,
		clearEnvNames: args.clearEnvNames
	});
}
function buildAiVaultResumeShellCommand(args) {
	const { cwd, platform, codexHome, shell, clearEnvNames } = args;
	if (shell === "powershell" || platform === "win32" && shell && shell !== "cmd") return buildResumeShellCommandForShell({
		resumeCommand: args.resumeCommand,
		cwd,
		codexHome: codexHome?.trim() || null,
		shell,
		clearEnvNames
	});
	const resolvedCodexHome = codexHome?.trim() || null;
	const clearNames = resolvedCodexHome ? clearEnvNames?.filter((name) => name !== "CODEX_HOME") : clearEnvNames;
	const dialect = shell ?? (platform === "win32" ? "cmd" : "posix");
	const clearsOnAgent = clearNames?.length && isPosixStartupShell(dialect);
	const resumeCommand = `${codexHomeEnvPrefix(resolvedCodexHome, platform, shell)}${clearsOnAgent ? withoutEnvCommand(clearNames, args.resumeCommand, dialect) : args.resumeCommand}`;
	const clearPrefix = clearNames?.length && !clearsOnAgent ? `${clearEnvCommand(clearNames, dialect)}${commandSeparator(dialect)}` : "";
	if (platform === "win32" && shell === "cmd") return `${clearPrefix}${cwd ? `cd /d ${quoteWindowsCmdArg(cwd)} && ${resumeCommand}` : resumeCommand}`;
	if (!cwd) return `${clearPrefix}${resumeCommand}`;
	if (platform === "win32") return `cmd /d /s /c ${quoteWindowsCmdArg(`${clearPrefix}cd /d ${quoteWindowsCmdArg(cwd)} && ${resumeCommand}`)}`;
	return `cd ${quoteResumeArg(cwd, platform, shell)} && ${resumeCommand}`;
}
function buildResumeShellCommandForShell(args) {
	const { cwd, codexHome, shell, clearEnvNames } = args;
	if (isPosixStartupShell(shell)) {
		const envPrefix = codexHome ? `CODEX_HOME=${quoteStartupArg(codexHome, shell)} ` : "";
		const clearNames = codexHome ? clearEnvNames?.filter((name) => name !== "CODEX_HOME") : clearEnvNames;
		const command = `${envPrefix}${clearNames?.length ? withoutEnvCommand(clearNames, args.resumeCommand, shell) : args.resumeCommand}`;
		return cwd ? `cd ${quoteStartupArg(cwd, shell)} && ${command}` : command;
	}
	const separator = commandSeparator(shell);
	const segments = [];
	if (clearEnvNames?.length) segments.push(clearEnvCommand(clearEnvNames, shell));
	if (cwd) segments.push(`Set-Location -LiteralPath ${quoteStartupArg(cwd, shell)}`);
	if (codexHome) segments.push(`$env:CODEX_HOME=${quoteStartupArg(codexHome, shell)}`);
	segments.push(args.resumeCommand);
	return segments.join(separator);
}
function defaultAiVaultResumeCommandBase(agent) {
	if (agent === "cursor") return "cursor-agent";
	if (agent === "hermes") return "hermes";
	if (agent === "rovo") return "acli";
	return TUI_AGENT_CONFIG[agent].detectCmd;
}
function buildAgentResumeInvocation(agent, baseCommand, sessionArg) {
	switch (agent) {
		case "codex": return `${baseCommand} resume ${sessionArg}`;
		case "rovo": return `${baseCommand} rovodev run --restore ${sessionArg}`;
		case "opencode2": return `${baseCommand} --standalone --session ${sessionArg}`;
		case "opencode":
		case "pi":
		case "kimi": return `${baseCommand} --session ${sessionArg}`;
		case "copilot": return `${baseCommand} --resume=${sessionArg}`;
		case "muse": return `${baseCommand} resume ${sessionArg}`;
		case "cline": return `${baseCommand} --id ${sessionArg}`;
		case "qoder":
		case "codebuddy":
		case "claude":
		case "zcode":
		case "cursor":
		case "gemini":
		case "grok":
		case "hermes":
		case "devin":
		case "openclaw":
		case "droid":
		case "jcode":
		case "omp":
		case "prime-agent": return `${baseCommand} --resume ${sessionArg}`;
		case "antigravity": return `${baseCommand} --conversation ${sessionArg}`;
	}
}
function codexHomeEnvPrefix(codexHome, platform, shell) {
	if (!codexHome) return "";
	if (platform === "win32") return `set ${quoteWindowsCmdArg(`CODEX_HOME=${codexHome}`)} && `;
	return `CODEX_HOME=${quoteResumeArg(codexHome, platform, shell)} `;
}
/** Quotes for the live shell when one is known, else for the platform's default. */
function quoteResumeArg(value, platform, shell) {
	return shell ? quoteStartupArg(value, shell) : quoteShellArg(value, platform);
}
/** Why not the sh `'\''` idiom here: this is the same resume command the shell
*  branch above builds, and fish reads that idiom differently — it would halve
*  backslashes in a path and reject a trailing one. Deferring to
*  `quoteStartupArg` keeps one spelling regardless of whether a caller happened
*  to pass a shell. */
function quoteShellArg(value, platform) {
	return platform === "win32" ? quoteWindowsCmdArg(value) : quoteStartupArg(value, "posix");
}
function quoteWindowsCmdArg(value) {
	return `"${value.replace(/"/g, "\"\"")}"`;
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-first-user-prompt-capture.ts
const firstUserPromptCaptureStorage = new node_async_hooks.AsyncLocalStorage();
function getFirstUserPromptCaptureMode() {
	return firstUserPromptCaptureStorage.getStore() ?? "none";
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-grok-user-text.ts
function stripGrokUserQueryEnvelope(text) {
	const opener = "<user_query>";
	const closer = "</user_query>";
	const lower = text.toLowerCase();
	const start = lower.indexOf(opener);
	if (start === -1) return text;
	const bodyStart = start + 12;
	const end = lower.indexOf(closer, bodyStart);
	if (end === -1) return text.slice(bodyStart).trim();
	return text.slice(bodyStart, end).trim();
}
//#endregion
//#region vendor/orca/src/shared/surrogate-safe-text-slice.ts
/** Cut to `limit` UTF-16 code units without splitting a trailing surrogate pair. */
function sliceAtCodeUnitLimit(value, limit) {
	if (value.length <= limit) return value;
	const end = limit > 0 && isHighSurrogate$1(value.charCodeAt(limit - 1)) ? limit - 1 : limit;
	return value.slice(0, end);
}
function isHighSurrogate$1(code) {
	return code >= 55296 && code <= 56319;
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-text-normalization.ts
const SESSION_TITLE_TEXT_LIMIT = 96;
const SESSION_PREVIEW_TEXT_LIMIT = 220;
const ELLIPSIS = "...";
const HIDDEN_BLOCK_CLOSE_SCAN_LIMIT = 262144;
const HIDDEN_BLOCK_OPEN_TAG_SCAN_LIMIT = 512;
const AGENTS_INSTRUCTIONS_PREFIX = "# AGENTS.md instructions";
const XML_INSTRUCTIONS_PREFIX = "<INSTRUCTIONS>";
const HIDDEN_TEXT_BLOCKS = [
	{
		name: "system-reminder",
		closeTag: "</system-reminder>"
	},
	{
		name: "codex_internal_context",
		closeTag: "</codex_internal_context>"
	},
	{
		name: "goal_context",
		closeTag: "</goal_context>"
	}
];
function normalizeTitleText(value) {
	return finalizeNormalizedText(normalizeStringText(value, SESSION_TITLE_TEXT_LIMIT));
}
function normalizePreviewText(value) {
	return finalizeNormalizedText(normalizeStringText(value, SESSION_PREVIEW_TEXT_LIMIT));
}
function normalizeStringText(value, limit) {
	const builder = createTextBuilder(limit);
	appendNormalizedString(builder, value);
	return builder;
}
function createTextBuilder(limit) {
	return {
		limit,
		text: "",
		pendingSpace: false,
		truncated: false
	};
}
function appendNormalizedString(builder, value, maxScanLength) {
	const scanEnd = maxScanLength == null ? value.length : Math.min(value.length, maxScanLength);
	let index = 0;
	while (index < scanEnd && !builder.truncated) {
		const hiddenBlockEnd = hiddenTextBlockEnd(value, index);
		if (hiddenBlockEnd !== null) {
			if (builder.text.length > 0) builder.pendingSpace = true;
			index = Math.min(hiddenBlockEnd, scanEnd);
			continue;
		}
		if (isWhitespaceCode(value.charCodeAt(index))) {
			if (builder.text.length > 0) builder.pendingSpace = true;
			index += 1;
			continue;
		}
		if (builder.pendingSpace) {
			appendVisibleText(builder, " ");
			builder.pendingSpace = false;
			if (builder.truncated) break;
		}
		const charLength = codePointLength(value, index);
		if (index + charLength > scanEnd) break;
		appendVisibleText(builder, value.slice(index, index + charLength));
		index += charLength;
	}
	if (!builder.truncated && scanEnd < value.length && builder.text.length > 0) builder.truncated = true;
}
function appendVisibleText(builder, value) {
	builder.text += value;
	builder.truncated = builder.text.length > builder.limit;
}
function hiddenTextBlockEnd(value, index) {
	if (value.charCodeAt(index) !== 60) return null;
	for (const block of HIDDEN_TEXT_BLOCKS) {
		const nameStart = index + 1;
		if (!startsWithIgnoreCase(value, block.name, nameStart)) continue;
		const afterName = nameStart + block.name.length;
		if (!isTagBoundary(value.charCodeAt(afterName))) continue;
		const openEnd = tagEndIndex(value, afterName);
		if (openEnd === null) return value.length;
		const closeStart = indexOfIgnoreCase(value, block.closeTag, openEnd + 1, openEnd + 1 + HIDDEN_BLOCK_CLOSE_SCAN_LIMIT);
		return closeStart === -1 ? value.length : closeStart + block.closeTag.length;
	}
	return null;
}
function tagEndIndex(value, fromIndex) {
	const scanEnd = Math.min(value.length, fromIndex + HIDDEN_BLOCK_OPEN_TAG_SCAN_LIMIT);
	for (let index = fromIndex; index < scanEnd; index += 1) if (value.charCodeAt(index) === 62) return index;
	return null;
}
function indexOfIgnoreCase(value, search, fromIndex, endIndex) {
	const lastStart = Math.min(value.length, endIndex, value.length - search.length + 1);
	for (let index = fromIndex; index < lastStart; index += 1) if (startsWithIgnoreCase(value, search, index)) return index;
	return -1;
}
function finalizeNormalizedText(builder) {
	if (!builder.text) return null;
	if (isSuppressedContextPrefix(builder.text)) return null;
	return builder.truncated ? truncateWithEllipsis(builder.text, builder.limit) : builder.text;
}
function isSuppressedContextPrefix(value) {
	return startsWithIgnoreCase(value, AGENTS_INSTRUCTIONS_PREFIX, 0) && isWordBoundary(value.charCodeAt(24)) || startsWithIgnoreCase(value, XML_INSTRUCTIONS_PREFIX, 0);
}
function truncateWithEllipsis(value, limit) {
	return `${sliceAtCodeUnitLimit(value, Math.max(0, limit - 3))}${ELLIPSIS}`;
}
function startsWithIgnoreCase(value, search, fromIndex) {
	if (fromIndex + search.length > value.length) return false;
	for (let index = 0; index < search.length; index += 1) if (toLowerAscii(value.charCodeAt(fromIndex + index)) !== toLowerAscii(search.charCodeAt(index))) return false;
	return true;
}
function toLowerAscii(code) {
	return code >= 65 && code <= 90 ? code + 32 : code;
}
function isTagBoundary(code) {
	return Number.isNaN(code) || code === 62 || isWhitespaceCode(code);
}
function isWordBoundary(code) {
	return Number.isNaN(code) || !isWordCode(code);
}
function isWordCode(code) {
	return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
}
function isWhitespaceCode(code) {
	return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
function codePointLength(value, index) {
	return isHighSurrogate(value.charCodeAt(index)) && isLowSurrogate(value.charCodeAt(index + 1)) ? 2 : 1;
}
function isHighSurrogate(code) {
	return code >= 55296 && code <= 56319;
}
function isLowSurrogate(code) {
	return code >= 56320 && code <= 57343;
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-first-user-prompt.ts
const FULL_FIRST_USER_PROMPT_SAFETY_LIMIT = 262144;
/** True only while an on-demand first-prompt read is re-parsing one transcript. */
function shouldCaptureFullFirstUserPrompt() {
	return getFirstUserPromptCaptureMode() === "full";
}
function normalizeFullFirstUserPromptText(value) {
	return finalizeFullFirstUserPrompt(value);
}
function finalizeFullFirstUserPrompt(value) {
	const trimmed = stripGrokUserQueryEnvelope(value.replace(/^\uFEFF/, "")).trim();
	if (!trimmed) return null;
	if (isSuppressedFullFirstUserPrompt(trimmed)) return null;
	if (isKnownHarnessInjectedUserTurnText(trimmed)) return null;
	const bounded = sliceAtCodeUnitLimit(trimmed, FULL_FIRST_USER_PROMPT_SAFETY_LIMIT);
	const lower = bounded.toLowerCase();
	if (lower.startsWith("<user_info>") && !lower.includes("<user_query>")) return null;
	return bounded;
}
function isSuppressedFullFirstUserPrompt(value) {
	const head = value.slice(0, 64).toLowerCase();
	return head.startsWith("# agents.md instructions") || head.startsWith("<instructions>");
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-record-value.ts
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-values.ts
function timestampMs(value) {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : NaN;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return NaN;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function parseJsonObject(line) {
	if (!line.trim()) return null;
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return null;
	}
}
function extractString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-transcript-consumers.ts
const NO_TRANSCRIPT_MESSAGES = {
	active: false,
	push: () => void 0
};
//#endregion
//#region vendor/orca/src/main/ai-vault/session-transcript-message-content.ts
const TRANSCRIPT_MESSAGE_TEXT_LIMIT = 262144;
/** Only conversational roles reach consumers; system/unknown turns are noise. */
function transcriptMessageRole(role) {
	return role === "user" || role === "assistant" || role === "tool" ? role : null;
}
function boundedText(value) {
	const bounded = sliceAtCodeUnitLimit(value, TRANSCRIPT_MESSAGE_TEXT_LIMIT);
	return bounded.trim() ? bounded : null;
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-accumulator.ts
const SESSION_PREVIEW_MESSAGE_LIMIT = 5;
function createAccumulator(args) {
	return {
		agent: args.agent,
		messages: args.messages ?? NO_TRANSCRIPT_MESSAGES,
		sessionId: args.sessionId,
		title: null,
		fallbackTitle: null,
		cwd: null,
		branch: null,
		model: null,
		filePath: args.file.path,
		createdAt: null,
		updatedAt: null,
		modifiedAt: args.file.modifiedAt,
		messageCount: 0,
		totalTokens: 0,
		previewMessages: [],
		previewMessagesTruncated: false,
		firstUserPrompt: null,
		lastUserPrompt: null,
		queuedMessageCount: 0,
		subagentTranscriptCount: 0,
		earliestTimestampMs: 0,
		latestTimestampMs: 0
	};
}
function finalizeSession(accumulator, platform, options = {}) {
	const sessionId = accumulator.sessionId.trim();
	if (!sessionId) return null;
	const title = accumulator.title || accumulator.fallbackTitle || generatedSessionTitle(accumulator.agent, sessionId);
	const executionHostId = options.executionHostId ?? "local";
	return {
		id: `${executionHostId}:${accumulator.agent}:${sessionId}:${accumulator.filePath}`,
		executionHostId,
		...options.executionHostPlatform ? { executionHostPlatform: options.executionHostPlatform } : {},
		agent: accumulator.agent,
		sessionId,
		title,
		cwd: accumulator.cwd,
		branch: accumulator.branch,
		model: accumulator.model,
		filePath: accumulator.filePath,
		codexHome: accumulator.agent === "codex" ? options.codexHome ?? null : null,
		createdAt: accumulator.createdAt,
		updatedAt: accumulator.updatedAt,
		modifiedAt: accumulator.modifiedAt,
		messageCount: accumulator.messageCount,
		totalTokens: accumulator.totalTokens,
		previewMessages: accumulator.previewMessages,
		...accumulator.previewMessagesTruncated ? { previewMessagesTruncated: true } : {},
		...accumulator.antigravityOpeningPrompt ? { antigravityOpeningPrompt: accumulator.antigravityOpeningPrompt } : {},
		...accumulator.firstUserPrompt ? { firstUserPrompt: accumulator.firstUserPrompt } : {},
		...accumulator.lastUserPrompt ? { lastUserPrompt: accumulator.lastUserPrompt } : {},
		queuedMessageCount: accumulator.queuedMessageCount,
		subagentTranscriptCount: accumulator.subagentTranscriptCount,
		resumeCommand: buildAiVaultResumeCommand({
			agent: accumulator.agent,
			sessionId,
			resumeFilePath: accumulator.filePath,
			cwd: accumulator.cwd,
			platform,
			codexHome: options.codexHome
		}),
		subagent: null
	};
}
/**
* The title a session gets when neither the transcript nor the agent named it.
* Exported so a later merge can tell "the fold found no title" from a real one
* without re-deriving the string (session-scanner-sidecar-enrichment.ts).
*/
function generatedSessionTitle(agent, sessionId) {
	return `${aiVaultAgentLabel(agent)} ${sessionId.slice(0, 8)}`;
}
function updateTimeline(accumulator, timestamp) {
	const parsed = timestampMs(timestamp);
	if (!Number.isFinite(parsed)) return;
	const iso = new Date(parsed).toISOString();
	if (!accumulator.createdAt || parsed < accumulator.earliestTimestampMs) {
		accumulator.createdAt = iso;
		accumulator.earliestTimestampMs = Math.trunc(parsed);
	}
	if (!accumulator.updatedAt || parsed >= Math.trunc(accumulator.latestTimestampMs)) {
		accumulator.updatedAt = iso;
		accumulator.latestTimestampMs = parsed;
	}
}
function addPreviewMessage(accumulator, args) {
	if (args.publishMessage !== false && accumulator.messages.active) publishTranscriptMessage(accumulator, args.role, args.text, args.timestamp);
	seedFullFirstUserPrompt(accumulator, args.role, () => args.text ? normalizeFullFirstUserPromptText(args.text) : null, args.seedFirstUserPrompt);
	const text = normalizePreviewText(args.text ?? "");
	if (!text) return;
	accumulator.previewMessages.push({
		role: args.role,
		text,
		timestamp: timestampIso(args.timestamp)
	});
	if (accumulator.previewMessages.length > SESSION_PREVIEW_MESSAGE_LIMIT) {
		accumulator.previewMessages.shift();
		accumulator.previewMessagesTruncated = true;
	}
}
/** One already-flattened turn; the content path publishes per block instead. */
function publishTranscriptMessage(accumulator, role, text, timestamp) {
	const messageRole = transcriptMessageRole(role);
	const messageText = text === null ? null : boundedText(text);
	if (messageRole && messageText) accumulator.messages.push({
		role: messageRole,
		text: messageText,
		timestamp: timestampIso(timestamp)
	});
}
/**
* Seed the copyable first prompt from the first real user turn. `fullText` is a
* thunk so list scans (capture mode `none`) never pay the extraction cost.
*/
function seedFullFirstUserPrompt(accumulator, role, fullText, seedFirstUserPrompt) {
	if (role === "user" && seedFirstUserPrompt !== false && !accumulator.firstUserPrompt && shouldCaptureFullFirstUserPrompt()) accumulator.firstUserPrompt = fullText();
}
function timestampIso(value) {
	const parsed = timestampMs(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function updateLatestLocation(accumulator, record) {
	if (accumulator.cwd === null) {
		const startCwd = extractString(record.cwd);
		if (startCwd) accumulator.cwd = startCwd;
	}
	const timestamp = extractString(record.timestamp);
	const parsed = timestamp ? Date.parse(timestamp) : accumulator.latestTimestampMs;
	if (!Number.isFinite(parsed) || parsed < accumulator.latestTimestampMs) return;
	const branch = extractString(record.gitBranch);
	if (branch) accumulator.branch = branch;
}
function sessionIdFromFileName(filePath) {
	const fileName = (0, node_path.basename)(filePath, (0, node_path.extname)(filePath));
	return fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? fileName;
}
//#endregion
//#region vendor/orca/src/main/ai-vault/session-scanner-codebuddy-parser.ts
function createCodebuddySessionParseState(file, messages) {
	return {
		accumulator: createAccumulator({
			agent: "codebuddy",
			file,
			sessionId: sessionIdFromFileName(file.path),
			messages
		}),
		aiTitle: null,
		firstUserTitle: null
	};
}
function cloneCodebuddySessionParseState(state) {
	return {
		accumulator: {
			...state.accumulator,
			previewMessages: [...state.accumulator.previewMessages]
		},
		aiTitle: state.aiTitle,
		firstUserTitle: state.firstUserTitle
	};
}
function codebuddyContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts = content.map((block) => {
		const record = asRecord(block);
		const type = extractString(record?.type);
		return type === "input_text" || type === "output_text" || type === "text" ? extractString(record?.text) : null;
	}).filter((text) => typeof text === "string" && text.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : null;
}
function consumeCodebuddySessionLine(state, line) {
	const { accumulator } = state;
	const record = parseJsonObject(line);
	if (!record) return;
	if (typeof record.sessionId === "string" && record.sessionId.trim()) accumulator.sessionId = record.sessionId.trim();
	updateTimeline(accumulator, record.timestamp);
	updateLatestLocation(accumulator, record);
	if (record.type === "summary") {
		const summary = normalizeTitleText(extractString(record.summary) ?? "");
		if (summary) accumulator.title = summary;
		return;
	}
	if (record.type === "ai-title") {
		const title = normalizeTitleText(extractString(record.aiTitle) ?? "");
		if (title) state.aiTitle = title;
		return;
	}
	if (record.type !== "message") return;
	const role = extractString(record.role);
	const text = codebuddyContentText(record.content);
	accumulator.messageCount++;
	if (role === "user") {
		const isMetaUserTurn = asRecord(record.providerData)?.skipRun === true || text != null && isKnownHarnessInjectedUserTurnText(text);
		addPreviewMessage(accumulator, {
			role: "user",
			text,
			timestamp: record.timestamp,
			seedFirstUserPrompt: !isMetaUserTurn
		});
		if (text && !isMetaUserTurn) state.firstUserTitle ??= text;
		return;
	}
	if (role === "assistant") {
		addPreviewMessage(accumulator, {
			role: "assistant",
			text,
			timestamp: record.timestamp
		});
		const model = extractString(asRecord(record.providerData)?.model);
		if (model) accumulator.model = model;
	}
}
function finalizeCodebuddySessionParseState(state, platform, options = {}) {
	const snapshot = cloneCodebuddySessionParseState(state);
	snapshot.accumulator.fallbackTitle = snapshot.aiTitle ?? snapshot.firstUserTitle;
	return finalizeSession(snapshot.accumulator, platform, options);
}
//#endregion
exports.TUI_AGENT_CONFIG = TUI_AGENT_CONFIG;
exports.consumeCodebuddySessionLine = consumeCodebuddySessionLine;
exports.createCodebuddySessionParseState = createCodebuddySessionParseState;
exports.finalizeCodebuddySessionParseState = finalizeCodebuddySessionParseState;
exports.getDefaultUserDataPath = getDefaultUserDataPath;
exports.getTuiAgentDetectCommands = getTuiAgentDetectCommands;
exports.getTuiAgentLaunchCommand = getTuiAgentLaunchCommand;
exports.isKnownHarnessInjectedUserTurnText = isKnownHarnessInjectedUserTurnText;
exports.readMetadata = readMetadata;
exports.runProcess = runProcess;
exports.sendRequest = sendRequest;
exports.spawnProcess = spawnProcess;
