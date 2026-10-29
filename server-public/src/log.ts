// Plain timestamped logging to stdout; `pp up` redirects it to var/logs/pangpangd.log.

function stamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
	);
}

function write(level: string, scope: string, message: string, detail?: unknown): void {
	let line = `${stamp()} ${level} [${scope}] ${message}`;
	if (detail !== undefined) {
		const text = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
		line += `: ${text}`;
	}
	console.log(line);
}

export const log = {
	info: (scope: string, message: string, detail?: unknown) => write("INFO", scope, message, detail),
	warn: (scope: string, message: string, detail?: unknown) => write("WARN", scope, message, detail),
	error: (scope: string, message: string, detail?: unknown) => write("ERROR", scope, message, detail),
};

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
