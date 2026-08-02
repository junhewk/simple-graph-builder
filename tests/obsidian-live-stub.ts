/**
 * Obsidian stub for LIVE eval runs (`npm run eval`).
 *
 * Same surface as obsidian-stub.ts, but requestUrl performs a real HTTP
 * request with Node's fetch instead of replaying a scripted response. It
 * mirrors Obsidian's requestUrl contract as src/extraction/providers/http.ts
 * relies on it: `throw: false` means HTTP error statuses resolve normally,
 * while transport failures (DNS, ECONNREFUSED) still reject.
 */
export async function requestUrl(opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}) {
	const res = await fetch(opts.url, {
		method: opts.method ?? 'GET',
		headers: opts.headers,
		body: opts.body,
	});
	const text = await res.text();
	if (opts.throw !== false && !res.ok) {
		throw new Error(`Request failed, status ${res.status}`);
	}
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	return {
		status: res.status,
		headers,
		text,
		arrayBuffer: new ArrayBuffer(0),
		get json() { return JSON.parse(text); },
	};
}
export class Vault {}
