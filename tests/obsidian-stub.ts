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
/** Write-back suites need real classes: the code branches on `instanceof`. */
export class TAbstractFile {
  path = '';
  name = '';
}
export class TFile extends TAbstractFile {
  basename = '';
  extension = 'md';
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}
/** Enough of the view/modal surface for suites that import UI modules. */
export class ItemView { constructor(_leaf?: unknown) { /* stub */ } }
export class Modal { constructor(_app?: unknown) { /* stub */ } }
export class Setting { constructor(_el?: unknown) { /* stub */ } }
export class WorkspaceLeaf {}
/** Graph suites pull in cache.ts, which surfaces load-time repairs via Notice. */
export const notices: string[] = [];
export class Notice {
  constructor(message: string) { notices.push(message); }
}
