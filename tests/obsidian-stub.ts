export const captured: { url?: string; headers?: any; body?: any } = {};
export const allBodies: any[] = [];
let queue: any[] = [];
export function setScripted(s: any) { queue = [s]; }
export function setQueue(list: any[]) { queue = list.slice(); }
export function resetBodies() { allBodies.length = 0; }
export async function requestUrl(opts: any) {
  captured.url = opts.url;
  captured.headers = opts.headers;
  captured.body = JSON.parse(opts.body);
  allBodies.push(captured.body);
  const s = queue.length > 1 ? queue.shift() : queue[0];
  const text = JSON.stringify(s.body);
  return { status: s.status, headers: s.headers || {}, text, arrayBuffer: new ArrayBuffer(0), get json() { return JSON.parse(text); } };
}
export class Vault {}
