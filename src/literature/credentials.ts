import type { LiteratureCredentials, LiteratureSource } from './types';

interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, value: string): void;
}

/** Capability guard keeps the existing minimum Obsidian version supported. */
export class LiteratureCredentialStore {
	private session: Partial<Record<LiteratureSource, string>> = {};
	private readonly secrets?: SecretStore;

	constructor(app: unknown) {
		const candidate = (app as { secretStorage?: SecretStore }).secretStorage;
		if (candidate && typeof candidate.getSecret === 'function' && typeof candidate.setSecret === 'function') this.secrets = candidate;
	}

	get persistent(): boolean { return !!this.secrets; }
	get(source: LiteratureSource): string {
		return this.secrets?.getSecret(`simple-graph-builder-literature-${source}`) ?? this.session[source] ?? '';
	}
	set(source: LiteratureSource, value: string): void {
		if (this.secrets) this.secrets.setSecret(`simple-graph-builder-literature-${source}`, value.trim());
		else this.session[source] = value.trim();
	}
	read(contactEmail: string): LiteratureCredentials {
		return { pubmed: this.get('pubmed'), openalex: this.get('openalex'), contactEmail: contactEmail.trim() };
	}
	clearSession(): void { this.session = {}; }
}
