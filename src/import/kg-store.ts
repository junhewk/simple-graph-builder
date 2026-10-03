/**
 * A copy of each imported project's graph, kept in the plugin folder.
 *
 * The med-lit folder the import came from may be on another machine, behind a
 * sync, or gone. Keeping the normalized graph lets the plugin rebuild the
 * project's part of the knowledge graph on its own -- after "Clear graph", on
 * another device of the same vault -- without reading the source again.
 * Written beside embeddings.bin rather than into data.json, which is rewritten
 * on every save and has no reason to carry it.
 */
import type SimpleGraphBuilderPlugin from '../main';
import type { MedLitKg } from './types';

function dir(plugin: SimpleGraphBuilderPlugin): string {
	return `${plugin.manifest.dir || ''}/med-lit`;
}

function fileFor(plugin: SimpleGraphBuilderPlugin, projectId: string): string {
	return `${dir(plugin)}/${projectId.replace(/[^\w-]/g, '_')}.kg.json`;
}

export async function saveKg(plugin: SimpleGraphBuilderPlugin, projectId: string, kg: MedLitKg): Promise<void> {
	const adapter = plugin.app.vault.adapter;
	if (!(await adapter.exists(dir(plugin)))) await adapter.mkdir(dir(plugin));
	await adapter.write(fileFor(plugin, projectId), JSON.stringify(kg));
}

export async function loadKg(plugin: SimpleGraphBuilderPlugin, projectId: string): Promise<MedLitKg | null> {
	const adapter = plugin.app.vault.adapter;
	const path = fileFor(plugin, projectId);
	if (!(await adapter.exists(path))) return null;
	try {
		return JSON.parse(await adapter.read(path)) as MedLitKg;
	} catch {
		return null;
	}
}

export async function deleteKg(plugin: SimpleGraphBuilderPlugin, projectId: string): Promise<void> {
	const adapter = plugin.app.vault.adapter;
	const path = fileFor(plugin, projectId);
	if (await adapter.exists(path)) await adapter.remove(path);
}
