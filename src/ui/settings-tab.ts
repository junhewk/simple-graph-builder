import { App, Notice, PluginSettingTab, Setting, TextComponent, debounce } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { ApiProvider, EmbeddingProvider, ExtractionMode, LocalApiStyle } from '../types';
import { MODEL_OPTIONS, EMBEDDING_MODEL_OPTIONS } from '../settings';
import { getAdapter } from '../extraction/providers/index';
import { EFFORT_LABELS, EFFORT_LEVELS, EffortLevel } from '../extraction/providers/effort';
import { clearHashes } from '../graph/hashes';
import { analyzeEntireVault, isAnalyzingVault, cancelVaultAnalysis } from '../commands/analyze';
import { getEmbeddings, settingsToEmbeddingOptions } from '../extraction/llm-client';
import { writeLinksForVault, removeWrittenLinks, isWritebackRunning, cancelWriteback } from '../sync/batch';
import { normalizeFolder } from '../sync/filenames';
import { ConfirmModal } from './confirm-modal';
import { parseExcludedPatterns, supportsNativeExclusions } from '../analysis/exclusions';
import type { McpStatus } from '../mcp/controller';

interface DeclarativeControl {
	type: 'toggle' | 'dropdown' | 'text' | 'slider';
	key: string;
	defaultValue?: unknown;
	options?: Record<string, string>;
	placeholder?: string;
	min?: number;
	max?: number;
	step?: number;
	displayFormat?: (value: number) => string;
}

interface DeclarativeSettingDefinition {
	name: string;
	desc?: string;
	aliases?: string[];
	visible?: () => boolean;
	control?: DeclarativeControl;
	render?: (setting: Setting) => void;
}

interface DeclarativeSettingGroup {
	type: 'group';
	heading: string;
	items: DeclarativeSettingDefinition[];
	visible?: () => boolean;
}

type DeclarativeSettingItem = DeclarativeSettingDefinition | DeclarativeSettingGroup;

interface ModelSettingOptions {
	name: string;
	desc: string;
	provider: ApiProvider;
	get: () => string;
	set: (value: string) => Promise<void>;
}

export class SettingsTab extends PluginSettingTab {
	plugin: SimpleGraphBuilderPlugin;
	private providerSettingsEls: Partial<Record<ApiProvider, HTMLElement>> = {};

	constructor(app: App, plugin: SimpleGraphBuilderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * A model picker: a dropdown of known models plus a "Custom…" escape hatch.
	 *
	 * Replaces eight near-identical dropdown+textbox pairs. Only the Ollama pair
	 * used to guard against a stored model that is missing from the list; the
	 * others called `setValue` with an off-list value, which Obsidian silently
	 * ignores, leaving the dropdown showing the first option while the setting
	 * held something else entirely.
	 */
	private addModelSetting(
		container: HTMLElement,
		opts: ModelSettingOptions
	): void {
		const setting = new Setting(container).setName(opts.name).setDesc(opts.desc);
		this.configureModelSetting(setting, opts);
	}

	private configureModelSetting(setting: Setting, opts: ModelSettingOptions): void {
		const CUSTOM = '__custom__';
		const options = MODEL_OPTIONS[opts.provider];
		const warningEl = setting.descEl.createDiv({ cls: 'sgb-model-warning' });

		const refreshWarning = () => {
			warningEl.empty();
			warningEl.removeClass('sgb-model-warning-error');

			const model = opts.get();
			if (!model) return;

			const caps = getAdapter(opts.provider, {
				apiKey: this.plugin.settings.apiKeys?.[opts.provider] || this.plugin.settings.apiKey,
				ollamaHost: this.plugin.settings.ollamaHost,
				localApiStyle: this.plugin.settings.localApiStyle,
			}).capabilities(model);
			if (!caps.structuredOutput) {
				warningEl.addClass('sgb-model-warning-error');
				warningEl.appendText(
					`${model} cannot return structured output, which note analysis requires. Choose another model.`
				);
			} else if (!caps.effort) {
				warningEl.appendText(`${model} does not support the reasoning effort setting; it will be ignored.`);
			}
		};

		let textInput: TextComponent | undefined;

		setting
			.addDropdown(dropdown => {
				for (const model of options) {
					dropdown.addOption(model, model);
				}
				dropdown.addOption(CUSTOM, 'Custom…');

				const current = opts.get();
				dropdown.setValue(options.includes(current) ? current : CUSTOM);

				dropdown.onChange(async (value) => {
					if (value === CUSTOM) {
						// Wait for the text field rather than storing the sentinel.
						if (textInput) {
							textInput.inputEl.disabled = false;
							textInput.inputEl.focus();
						}
						return;
					}
					textInput?.setValue('');
					if (textInput) textInput.inputEl.disabled = true;
					await opts.set(value);
					refreshWarning();
				});
			})
			.addText(text => {
				textInput = text;
				const current = opts.get();
				const isCustom = !options.includes(current);

				text
					.setPlaceholder('Custom model ID')
					.setValue(isCustom ? current : '')
					.onChange(async (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							await opts.set(trimmed);
							refreshWarning();
						}
					});

				text.inputEl.disabled = !isCustom;
				text.inputEl.addClass('sgb-setting-input-wide');
			});

		refreshWarning();
	}

	private configureApiKeySetting(setting: Setting, provider: ApiProvider): void {
		setting.addText(text => {
			text
				.setPlaceholder('Enter API key')
				.setValue(this.plugin.settings.apiKeys?.[provider] ?? '')
				.onChange(async (value) => {
					this.plugin.settings.apiKeys = { ...this.plugin.settings.apiKeys, [provider]: value };
					await this.plugin.saveSettings();
				});
			text.inputEl.type = 'password';
		});
	}

	private configureEmbeddingModelSetting(setting: Setting): void {
		const embeddingModels = EMBEDDING_MODEL_OPTIONS[this.plugin.settings.embeddingProvider] || [];
		const custom = '__custom__';
		const knownIds = embeddingModels.map(model => model.id);
		let customInput: TextComponent | undefined;

		setting
			.addDropdown(dropdown => {
				for (const model of embeddingModels) dropdown.addOption(model.id, model.name);
				dropdown.addOption(custom, 'Custom…');
				const current = this.plugin.settings.embeddingModel;
				dropdown.setValue(knownIds.includes(current) ? current : custom);
				dropdown.onChange(async (value) => {
					if (value === custom) {
						if (customInput) {
							customInput.inputEl.disabled = false;
							customInput.inputEl.focus();
						}
						return;
					}
					customInput?.setValue('');
					if (customInput) customInput.inputEl.disabled = true;
					this.plugin.settings.embeddingModel = value;
					await this.plugin.saveSettings();
				});
			})
			.addText(text => {
				customInput = text;
				const current = this.plugin.settings.embeddingModel;
				const isCustom = !knownIds.includes(current);
				text
					.setPlaceholder('Custom model ID')
					.setValue(isCustom ? current : '')
					.onChange(async (value) => {
						const trimmed = value.trim();
						if (!trimmed) return;
						this.plugin.settings.embeddingModel = trimmed;
						await this.plugin.saveSettings();
					});
				text.inputEl.disabled = !isCustom;
				text.inputEl.addClass('sgb-setting-input-wide');
			});
	}

	private refreshSettings(): void {
		const update = (this as unknown as { update?: () => void }).update;
		if (typeof update === 'function') update.call(this);
		else this.display();
	}

	/** Obsidian 1.13+ reads controls from the plugin's nested settings object. */
	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	/** Persist declarative controls without overwriting graph data in data.json. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'respectObsidianExcludedFiles' && value && !supportsNativeExclusions(this.app)) return;
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === 'ollamaHost') value = String(value || 'http://localhost:11434');
		if (key === 'embeddingHost') value = String(value).trim();
		settings[key] = value;

		if (key === 'embeddingProvider') {
			const models = EMBEDDING_MODEL_OPTIONS[value as keyof typeof EMBEDDING_MODEL_OPTIONS];
			if (models?.length) this.plugin.settings.embeddingModel = models[0].id;
		} else if (key === 'resolutionThresholdHigh') {
			const high = Number(value);
			if (this.plugin.settings.resolutionThresholdLow >= high) {
				this.plugin.settings.resolutionThresholdLow = high - 0.05;
			}
		} else if (key === 'resolutionThresholdLow') {
			const low = Number(value);
			if (this.plugin.settings.resolutionThresholdHigh <= low) {
				this.plugin.settings.resolutionThresholdHigh = low + 0.05;
			}
		}

		await this.plugin.saveSettings();
		if ([
			'apiProvider', 'localApiStyle', 'enableEmbeddings', 'embeddingProvider',
			'embeddingLocalApiStyle', 'resolutionThresholdHigh', 'resolutionThresholdLow',
		].includes(key)) {
			this.refreshSettings();
		}
	}

	/** Shared by the searchable settings renderer and the legacy settings page. */
	private getExclusionSettings(): DeclarativeSettingDefinition[] {
		return [
			{
				name: 'Excluded files and folders',
				desc: 'One vault-relative path or glob per line: skills/**, templates/*.md, **/SKILL.md. Applies to all analysis, including the current note. Existing graph data is kept.',
				aliases: ['Exclusions', 'Ignore patterns'],
				render: setting => setting.addTextArea(text => {
					text.setPlaceholder('skills/**\ntemplates/*.md\n**/SKILL.md')
						.setValue(this.plugin.settings.excludedPatterns.join('\n'))
						.onChange(value => this.setControlValue('excludedPatterns', parseExcludedPatterns(value)));
					text.inputEl.rows = 4;
					text.inputEl.addClass('sgb-setting-input-wide');
				}),
			},
			{
				name: 'Respect Obsidian excluded files',
				desc: 'Also honor Files and links → Excluded files, using Obsidian’s own matching rules. Off by default.' +
					(supportsNativeExclusions(this.app) ? '' : ' Unavailable in this Obsidian version; turn this off to resume analysis.'),
				render: setting => setting.addToggle(toggle => {
					toggle.setValue(this.plugin.settings.respectObsidianExcludedFiles)
						.setDisabled(!supportsNativeExclusions(this.app) && !this.plugin.settings.respectObsidianExcludedFiles)
						.onChange(async value => {
							await this.setControlValue('respectObsidianExcludedFiles', value);
							toggle.setValue(this.plugin.settings.respectObsidianExcludedFiles)
								.setDisabled(!supportsNativeExclusions(this.app) && !this.plugin.settings.respectObsidianExcludedFiles);
						});
				}),
			},
		];
	}

	// A port typed digit by digit must not restart the server per keystroke.
	private readonly debouncedMcpRestart = debounce(() => {
		void this.plugin.mcp.restart().then(() => this.refreshSettings());
	}, 1000, true);

	/**
	 * Agent access (MCP). Shared by both settings renderers. Render-only items,
	 * so the legacy page can draw them with the same code.
	 */
	private getAgentAccessSettings(): DeclarativeSettingDefinition[] {
		const mcp = this.plugin.mcp;
		const enabled = () => this.plugin.settings.mcpEnabled && mcp.supported;
		const copy = (text: string, what: string) => {
			void navigator.clipboard.writeText(text).then(
				() => new Notice(`${what} copied.`),
				() => new Notice(`Could not copy ${what.toLowerCase()}.`)
			);
		};
		const masked = (text: string) => text.split(mcp.token()).join('<token>');

		return [
			{
				name: 'Enable agent access',
				desc: mcp.supported
					? 'Let AI agents such as Claude Code, Claude Desktop and Codex search this vault and its knowledge graph, read-only. ' +
						'A server on this computer (127.0.0.1) answers only requests carrying your token, and never serves excluded notes. ' +
						'Entity descriptions may reflect any note an entity was extracted from.'
					: 'Agent access runs a local server, so it is available on desktop only.',
				aliases: ['MCP', 'Claude Code', 'Codex', 'Claude Desktop'],
				render: (setting: Setting) => {
					setting.addToggle(toggle => {
						toggle.setValue(enabled()).setDisabled(!mcp.supported).onChange(async value => {
							this.plugin.settings.mcpEnabled = value;
							await this.plugin.saveSettings();
							if (value) await mcp.start();
							else await mcp.stop();
							this.refreshSettings();
						});
					});
				},
			},
			{
				name: 'Status',
				desc: 'Whether the server is running.',
				visible: enabled,
				// Rendered, not a static desc: the searchable settings page builds
				// these definitions once, before the server has started.
				render: (setting: Setting) => {
					setting.setDesc(describeMcpStatus(mcp.status));
				},
			},
			{
				name: 'Port',
				desc: 'Local port for the server. Change it if another vault or app already uses it; then copy the connection settings again.',
				visible: enabled,
				render: (setting: Setting) => {
					setting.addText(text => {
						text.setPlaceholder('27180').setValue(String(this.plugin.settings.mcpPort)).onChange(async value => {
							const port = Number(value);
							if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
							this.plugin.settings.mcpPort = port;
							await this.plugin.saveSettings();
							this.debouncedMcpRestart();
						});
					});
				},
			},
			{
				name: 'Access token',
				desc: mcp.tokenIsLocal
					? 'Stored on this device only, not in the vault, so it is not synced. Regenerating it disconnects every configured agent.'
					: 'Stored in this plugin\'s data.json. Regenerating it disconnects every configured agent.',
				visible: enabled,
				render: (setting: Setting) => {
					setting.addButton(button => button.setButtonText('Copy').onClick(() => copy(mcp.token(), 'Token')));
					setting.addButton(button => button.setButtonText('Regenerate').onClick(() => {
						new ConfirmModal(this.app, 'Regenerate the access token? Agents configured with the old one stop working until you paste the new settings.', async () => {
							await mcp.regenerateToken();
							this.refreshSettings();
						}).open();
					}));
				},
			},
			{
				name: 'Claude Code',
				desc: 'Run the copied command once in a terminal.',
				visible: enabled,
				render: (setting: Setting) => {
					setting.setDesc(`Run this once in a terminal: ${masked(mcp.snippets().claudeCode)}`);
					setting.addButton(button => button.setButtonText('Copy command').setCta().onClick(() => copy(mcp.snippets().claudeCode, 'Command')));
				},
			},
			{
				name: 'Codex',
				desc: 'Add this block to ~/.codex/config.toml.',
				visible: enabled,
				render: (setting: Setting) => {
					setting.addButton(button => button.setButtonText('Copy config').onClick(() => copy(mcp.snippets().codex, 'Codex config')));
				},
			},
			{
				name: 'Claude Desktop',
				desc: 'Merge the copied config into claude_desktop_config.json (Claude Desktop → Settings → Developer → Edit config), then restart Claude Desktop. It runs a small bridge script from this plugin\'s folder and needs Node.js.',
				visible: enabled,
				render: (setting: Setting) => {
					const config = mcp.snippets().claudeDesktop;
					if (!config) {
						setting.setDesc('Unavailable: the vault is not on a local file system.');
						return;
					}
					setting.addButton(button => button.setButtonText('Copy config').onClick(() => copy(config, 'Claude Desktop config')));
				},
			},
			{
				name: 'Node.js executable',
				desc: 'Used by the Claude Desktop config. If Claude Desktop cannot find node, enter its full path (run "which node" in a terminal).',
				visible: enabled,
				render: (setting: Setting) => {
					setting.addText(text => {
						text.setPlaceholder('Path to node').setValue(this.plugin.settings.mcpNodePath).onChange(async value => {
							this.plugin.settings.mcpNodePath = value.trim() || 'node';
							await this.plugin.saveSettings();
						});
					});
				},
			},
		];
	}

	/** Reasoning-effort picker. */
	private addEffortSetting(
		container: HTMLElement,
		opts: { name: string; desc: string; get: () => EffortLevel; set: (value: EffortLevel) => Promise<void> }
	): void {
		new Setting(container)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addDropdown(dropdown => {
				for (const level of EFFORT_LEVELS) {
					dropdown.addOption(level, EFFORT_LABELS[level]);
				}
				dropdown.setValue(opts.get()).onChange(async (value) => {
					await opts.set(value as EffortLevel);
				});
			});
	}

	/**
	 * Searchable settings for Obsidian 1.13+. The imperative display() below is
	 * retained for older supported Obsidian versions.
	 */
	getSettingDefinitions(): DeclarativeSettingItem[] {
		const providerLabels: Record<ApiProvider, string> = {
			claude: 'Claude',
			openai: 'OpenAI',
			gemini: 'Gemini',
			deepseek: 'DeepSeek',
			ollama: 'Ollama',
		};
		const extractionModelKeys = {
			claude: 'claudeModel',
			openai: 'openaiModel',
			gemini: 'geminiModel',
			deepseek: 'deepseekModel',
			ollama: 'ollamaModel',
		} as const;
		const providerOptions = {
			claude: 'Claude',
			openai: 'OpenAI',
			gemini: 'Gemini',
			deepseek: 'DeepSeek (cloud)',
			ollama: 'Ollama (local)',
		};
		const effortOptions = Object.fromEntries(
			EFFORT_LEVELS.map(level => [level, EFFORT_LABELS[level]])
		);

		const extractionModels = (Object.keys(providerLabels) as ApiProvider[]).map(provider => {
			const key = extractionModelKeys[provider];
			return {
				name: `${providerLabels[provider]} model`,
				desc: `${providerLabels[provider]} model to use for entity extraction.`,
				aliases: ['Model', 'Extraction model'],
				visible: () => this.plugin.settings.apiProvider === provider,
				render: (setting: Setting) => this.configureModelSetting(setting, {
					name: `${providerLabels[provider]} model`,
					desc: 'Model to use for entity extraction.',
					provider,
					get: () => this.plugin.settings[key],
					set: async model => {
						this.plugin.settings[key] = model;
						await this.plugin.saveSettings();
					},
				}),
			};
		});

		return [
			{
				type: 'group',
				heading: 'Provider',
				items: [
					{
						name: 'API provider',
						desc: 'Select the provider for entity extraction.',
						control: { type: 'dropdown', key: 'apiProvider', options: providerOptions },
					},
					...(['claude', 'openai', 'gemini', 'deepseek'] as ApiProvider[]).map(provider => ({
						name: `${providerLabels[provider]} API key`,
						desc: `API key used for ${providerLabels[provider]} requests.`,
						aliases: ['API key'],
						visible: () => this.plugin.settings.apiProvider === provider,
						render: (setting: Setting) => this.configureApiKeySetting(setting, provider),
					})),
					{
						name: 'Server API',
						desc: 'Which API the local server speaks.',
						visible: () => this.plugin.settings.apiProvider === 'ollama',
						control: {
							type: 'dropdown', key: 'localApiStyle',
							options: {
								ollama: 'Ollama (/api/chat)',
								openai: 'OpenAI-compatible (/v1/chat/completions)',
							},
						},
					},
					{
						name: 'Host',
						desc: 'Base address of the local model server.',
						visible: () => this.plugin.settings.apiProvider === 'ollama',
						control: { type: 'text', key: 'ollamaHost', placeholder: 'http://localhost:11434' },
					},
					...extractionModels,
				],
			},
			{
				type: 'group',
				heading: 'Analysis',
				items: [
					{
						name: 'Extraction mode',
						desc: 'Controls how thorough entity extraction is.',
						control: {
							type: 'dropdown', key: 'extractionMode',
							options: {
								standard: 'Standard (max 15 entities per chunk)',
								thorough: 'Thorough (no limits per chunk)',
							},
						},
					},
					{
						name: 'Reasoning effort',
						desc: 'How much the model reasons before extracting.',
						control: { type: 'dropdown', key: 'extractionEffort', options: effortOptions },
					},
					{
						name: 'Auto-analyze on save',
						desc: 'Automatically analyze notes when you save them.',
						control: { type: 'toggle', key: 'autoAnalyzeOnSave' },
					},
					...this.getExclusionSettings(),
				],
			},
			{
				type: 'group',
				heading: 'Agent access',
				items: this.getAgentAccessSettings(),
			},
			{
				type: 'group',
				heading: 'View',
				items: [
					{
						name: 'Open graph in main window',
						desc: 'Open the graph in a main tab instead of the right sidebar.',
						control: { type: 'toggle', key: 'openGraphInMain' },
					},
					{
						name: 'Show note nodes',
						desc: 'Include notes in the graph alongside the entities they mention.',
						control: { type: 'toggle', key: 'graphShowNotes' },
					},
					{
						name: 'Minimum connections',
						desc: 'Hide nodes with fewer than this many visible connections.',
						control: {
							type: 'slider', key: 'graphMinDegree', min: 0, max: 10, step: 1,
							displayFormat: value => String(value),
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Vault write-back',
				items: [
					{
						name: 'Create entity notes',
						desc: 'Write one note per entity, with its aliases, type and relationships, so the graph ' +
							'also appears in Obsidian’s own graph view, backlinks and properties. The plugin edits ' +
							'only those notes and the link property below; your prose is never touched.',
						aliases: ['Write-back', 'Entity notes', 'Obsidian links'],
						control: { type: 'toggle', key: 'enableEntityNotes' },
					},
					{
						name: 'Entity folder',
						desc: 'Where entity notes live. Notes in this folder are never analyzed.',
						visible: () => this.plugin.settings.enableEntityNotes,
						render: setting => setting.addText(text => text
							.setPlaceholder('Entities')
							.setValue(this.plugin.settings.entityFolder)
							.onChange(async value => {
								// normalizeFolder, not trim: "/" survives a trim but names
								// the vault root, which would scatter entity notes among the
								// user's own notes and leave them analyzable.
								this.plugin.settings.entityFolder = normalizeFolder(value) || 'Entities';
								await this.plugin.saveSettings();
							})),
					},
					{
						name: 'List relationships in entity notes',
						desc: 'Link each entity to the ones it connects to, so entity-to-entity edges appear in the built-in graph.',
						visible: () => this.plugin.settings.enableEntityNotes,
						control: { type: 'toggle', key: 'writeRelationshipsSection' },
					},
					{
						name: 'Link notes to their entities',
						desc: 'Add a frontmatter property to each analyzed note listing the entities found in it.',
						visible: () => this.plugin.settings.enableEntityNotes,
						control: { type: 'toggle', key: 'enableRelatedWriteback' },
					},
					{
						name: 'Property name',
						desc: 'The frontmatter property the plugin owns. It is replaced on every analysis.',
						visible: () => this.plugin.settings.enableEntityNotes && this.plugin.settings.enableRelatedWriteback,
						render: setting => setting.addText(text => text
							.setPlaceholder('related')
							.setValue(this.plugin.settings.relatedPropertyName)
							.onChange(async value => {
								this.plugin.settings.relatedPropertyName = value.trim().replace(/:/g, '') || 'related';
								await this.plugin.saveSettings();
							})),
					},
					{
						name: 'Write links for the whole vault',
						desc: 'Apply the current graph to every analyzed note at once. Makes no API calls.',
						aliases: ['Write links', 'Vault write-back'],
						visible: () => this.plugin.settings.enableEntityNotes,
						render: setting => setting.addButton(button => {
							const updateButton = () => {
								if (isWritebackRunning()) button.setButtonText('Cancel').setWarning();
								else button.setButtonText('Write links').removeCta().setClass('mod-cta');
							};
							updateButton();
							button.onClick(() => {
								if (isWritebackRunning()) {
									cancelWriteback();
									new Notice('Cancelling...');
									return;
								}
								const entities = this.plugin.graphCache.getAllNodes()
									.filter(node => node.entityType !== 'NOTE').length;
								const message = `Write links for ${entities} entities into your vault?\n\n` +
									`This creates or updates notes in "${this.plugin.settings.entityFolder}"` +
									(this.plugin.settings.enableRelatedWriteback
										? `, and adds a "${this.plugin.settings.relatedPropertyName}" property to each analyzed note.`
										: '.');
								void new ConfirmModal(this.app, message, async () => {
									this.refreshSettings();
									await writeLinksForVault(this.plugin);
									this.refreshSettings();
								}).open();
							});
						}),
					},
					{
						name: 'Remove written links',
						desc: 'Take the plugin’s entity links back out of every note. Links you wrote yourself are kept, and entity notes are left in place.',
						visible: () => this.plugin.settings.enableEntityNotes,
						render: setting => setting.addButton(button => button
							.setButtonText('Remove links')
							.setWarning()
							.onClick(() => {
								const message = `Remove the plugin’s entity links from the ` +
									`"${this.plugin.settings.relatedPropertyName}" property of every note?\n\n` +
									'Links you wrote yourself are kept, and your prose is not touched.';
								void new ConfirmModal(this.app, message, async () => {
									await removeWrittenLinks(this.plugin);
								}).open();
							})),
					},
				],
			},
			{
				type: 'group',
				heading: 'Entity resolution (advanced)',
				items: [
					{
						name: 'Enable embedding-based resolution',
						desc: 'Use embeddings to find and merge similar entities.',
						control: { type: 'toggle', key: 'enableEmbeddings' },
					},
					{
						name: 'Embedding provider',
						desc: 'Select the provider for embeddings.',
						visible: () => this.plugin.settings.enableEmbeddings,
						control: {
							type: 'dropdown', key: 'embeddingProvider',
							options: { openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama (local)' },
						},
					},
					{
						name: 'Embedding API key',
						desc: 'Leave blank to use the selected provider’s main API key.',
						visible: () => this.plugin.settings.enableEmbeddings &&
							this.plugin.settings.embeddingProvider !== 'ollama',
						render: (setting: Setting) => {
							setting.addText(text => {
								text.setPlaceholder('Leave blank to use main key')
									.setValue(this.plugin.settings.embeddingApiKey)
									.onChange(async value => {
										this.plugin.settings.embeddingApiKey = value;
										await this.plugin.saveSettings();
									});
								text.inputEl.type = 'password';
							});
						},
					},
					{
						name: 'Embedding server API',
						desc: 'Which API the embedding server speaks.',
						visible: () => this.plugin.settings.enableEmbeddings &&
							this.plugin.settings.embeddingProvider === 'ollama',
						control: {
							type: 'dropdown', key: 'embeddingLocalApiStyle',
							options: {
								ollama: 'Ollama (/api/embed)',
								openai: 'OpenAI-compatible (/v1/embeddings)',
							},
						},
					},
					{
						name: 'Embedding server host',
						desc: 'Leave blank to reuse the chat provider’s host.',
						visible: () => this.plugin.settings.enableEmbeddings &&
							this.plugin.settings.embeddingProvider === 'ollama',
						control: { type: 'text', key: 'embeddingHost', placeholder: 'http://localhost:11434' },
					},
					{
						name: 'Embedding model',
						desc: 'Changing model requires recomputing stored embeddings.',
						visible: () => this.plugin.settings.enableEmbeddings,
						render: setting => this.configureEmbeddingModelSetting(setting),
					},
					{
						name: 'Auto-merge threshold',
						desc: 'Similarity above this threshold automatically merges entities.',
						visible: () => this.plugin.settings.enableEmbeddings,
						control: {
							type: 'slider', key: 'resolutionThresholdHigh', min: 0.85, max: 0.99, step: 0.01,
							displayFormat: value => value.toFixed(2),
						},
					},
					{
						name: 'Verification threshold',
						desc: 'Similarity above this but below auto-merge uses model verification.',
						visible: () => this.plugin.settings.enableEmbeddings,
						control: {
							type: 'slider', key: 'resolutionThresholdLow', min: 0.70, max: 0.90, step: 0.01,
							displayFormat: value => value.toFixed(2),
						},
					},
					{
						name: 'Enable verification',
						desc: 'Use the model to verify ambiguous entity matches.',
						visible: () => this.plugin.settings.enableEmbeddings,
						control: { type: 'toggle', key: 'enableLLMVerification' },
					},
					{
						name: 'Compute embeddings for existing nodes',
						desc: 'Generate missing embeddings, or recompute all when none are missing.',
						visible: () => this.plugin.settings.enableEmbeddings,
						render: setting => {
							const embeddings = this.plugin.graphCache.getEmbeddingsCount();
							const nodes = this.plugin.graphCache.getStats().nodes;
							const missing = nodes - embeddings;
							setting.setDesc(`${embeddings}/${nodes} nodes have embeddings.${missing > 0 ? ` ${missing} missing.` : ''}`)
								.addButton(button => button
									.setButtonText(missing > 0 ? 'Compute missing' : 'Recompute all')
									.onClick(() => this.computeEmbeddings(missing > 0)));
						},
					},
					{
						name: 'Clear resolution cache',
						desc: 'Clear cached entity-resolution decisions.',
						visible: () => this.plugin.settings.enableEmbeddings,
						render: setting => setting
							.setDesc(`${this.plugin.graphCache.getResolutionCacheSize()} cached resolutions.`)
							.addButton(button => button.setButtonText('Clear cache').setWarning().onClick(async () => {
								this.plugin.graphCache.clearResolutionCache();
								await this.plugin.graphCache.flush();
								new Notice('Resolution cache cleared');
								this.refreshSettings();
							})),
					},
				],
			},
			{
				type: 'group',
				heading: 'Vault analysis',
				items: [
					{
						name: 'Analyze entire vault',
						desc: 'After confirmation, analyze eligible markdown notes. Excluded and unchanged notes are skipped.',
						aliases: ['Batch analysis', 'Vault enumeration'],
						render: setting => setting.addButton(button => {
							const updateButton = () => {
								if (isAnalyzingVault()) button.setButtonText('Cancel').setWarning();
								else button.setButtonText('Start analysis').removeCta().setClass('mod-cta');
							};
							updateButton();
							button.onClick(() => {
								if (isAnalyzingVault()) {
									cancelVaultAnalysis();
									new Notice('Cancelling vault analysis...');
									return;
								}
								const message = 'Analyze eligible markdown notes in your vault?\n\n' +
									'The plugin will enumerate markdown file paths after confirmation, skip excluded notes, and send changed eligible notes to your configured provider in chunks.\n\n' +
									'You can cancel at any time.';
								void new ConfirmModal(this.app, message, async () => {
									this.refreshSettings();
									await analyzeEntireVault(this.plugin);
									this.refreshSettings();
								}).open();
							});
						}),
					},
				],
			},
			{
				type: 'group',
				heading: 'Data management',
				items: [
					{
						name: 'Graph statistics',
						desc: 'Current node and connection totals.',
						render: setting => this.renderGraphStats(setting.descEl),
					},
					{
						name: 'Clear graph data',
						desc: 'Remove all nodes, edges, and analysis history. This cannot be undone.',
						render: setting => setting.addButton(button => button
							.setButtonText('Clear all data')
							.setWarning()
							.onClick(() => {
								const message = 'Clear all graph data and analysis history? This cannot be undone.';
								void new ConfirmModal(this.app, message, async () => {
									this.plugin.graphCache.clear();
									await this.plugin.graphCache.flush();
									await clearHashes(this.plugin);
									new Notice('Graph data cleared');
									this.refreshSettings();
								}).open();
							})),
					},
				],
			},
			{
				type: 'group',
				heading: 'Support',
				items: [{
					name: 'Buy me a coffee',
					desc: 'Support development of Simple Graph Builder.',
					render: setting => setting.addButton(button => button
						.setButtonText('Buy me a coffee')
						.setCta()
						.onClick(() => window.open('https://buymeacoffee.com/junhewkkim', '_blank'))),
				}],
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Provider').setHeading();

		// API Provider
		new Setting(containerEl)
			.setName('API provider')
			.setDesc('Select the provider for entity extraction')
			.addDropdown(dropdown => {
				dropdown
					.addOption('claude', 'Claude')
					.addOption('openai', 'OpenAI')
					.addOption('gemini', 'Gemini')
					.addOption('deepseek', 'DeepSeek (cloud)')
					.addOption('ollama', 'Ollama (local)')
					.setValue(this.plugin.settings.apiProvider)
					.onChange(async (value) => {
						this.plugin.settings.apiProvider = value as ApiProvider;
						await this.plugin.saveSettings();
						this.updateProviderSettings();
					});
			});

		// Claude settings
		this.providerSettingsEls.claude = containerEl.createDiv();
		new Setting(this.providerSettingsEls.claude)
			.setName('API key')
			.setDesc('Claude key')
			.addText(text => {
				text
					.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.apiKeys?.claude ?? '')
					.onChange(async (value) => {
						this.plugin.settings.apiKeys = { ...this.plugin.settings.apiKeys, claude: value };
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
		this.addModelSetting(this.providerSettingsEls.claude, {
			name: 'Model',
			desc: 'Claude model to use',
			provider: 'claude',
			get: () => this.plugin.settings.claudeModel,
			set: async (value) => {
				this.plugin.settings.claudeModel = value;
				await this.plugin.saveSettings();
			},
		});

		// OpenAI settings
		this.providerSettingsEls.openai = containerEl.createDiv();
		new Setting(this.providerSettingsEls.openai)
			.setName('API key')
			.setDesc('Your OpenAI API key')
			.addText(text => {
				text
					.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.apiKeys?.openai ?? '')
					.onChange(async (value) => {
						this.plugin.settings.apiKeys = { ...this.plugin.settings.apiKeys, openai: value };
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
		this.addModelSetting(this.providerSettingsEls.openai, {
			name: 'Model',
			desc: 'OpenAI model to use',
			provider: 'openai',
			get: () => this.plugin.settings.openaiModel,
			set: async (value) => {
				this.plugin.settings.openaiModel = value;
				await this.plugin.saveSettings();
			},
		});

		// Gemini settings
		this.providerSettingsEls.gemini = containerEl.createDiv();
		new Setting(this.providerSettingsEls.gemini)
			.setName('API key')
			.setDesc('Gemini key')
			.addText(text => {
				text
					.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.apiKeys?.gemini ?? '')
					.onChange(async (value) => {
						this.plugin.settings.apiKeys = { ...this.plugin.settings.apiKeys, gemini: value };
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
		this.addModelSetting(this.providerSettingsEls.gemini, {
			name: 'Model',
			desc: 'Gemini model to use',
			provider: 'gemini',
			get: () => this.plugin.settings.geminiModel,
			set: async (value) => {
				this.plugin.settings.geminiModel = value;
				await this.plugin.saveSettings();
			},
		});

		// DeepSeek settings
		this.providerSettingsEls.deepseek = containerEl.createDiv();
		new Setting(this.providerSettingsEls.deepseek)
			.setName('API key')
			.setDesc('Your DeepSeek API key')
			.addText(text => {
				text
					.setPlaceholder('Enter API key')
					.setValue(this.plugin.settings.apiKeys?.deepseek ?? '')
					.onChange(async (value) => {
						this.plugin.settings.apiKeys = { ...this.plugin.settings.apiKeys, deepseek: value };
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
		this.addModelSetting(this.providerSettingsEls.deepseek, {
			name: 'Model',
			desc: 'DeepSeek model to use',
			provider: 'deepseek',
			get: () => this.plugin.settings.deepseekModel,
			set: async (value) => {
				this.plugin.settings.deepseekModel = value;
				await this.plugin.saveSettings();
			},
		});

		// Ollama settings
		this.providerSettingsEls.ollama = containerEl.createDiv();
		new Setting(this.providerSettingsEls.ollama)
			.setName('Server API')
			.setDesc(
				'Which API the local server speaks. Use OpenAI-compatible for llama.cpp (llama-server), LM Studio, vLLM and similar.'
			)
			.addDropdown(dropdown => {
				dropdown
					.addOption('ollama', 'Ollama (/api/chat)')
					.addOption('openai', 'OpenAI-compatible (/v1/chat/completions)')
					.setValue(this.plugin.settings.localApiStyle ?? 'ollama')
					.onChange(async (value) => {
						this.plugin.settings.localApiStyle = value as LocalApiStyle;
						await this.plugin.saveSettings();
						this.refreshSettings();
					});
			});

		new Setting(this.providerSettingsEls.ollama)
			.setName('Host')
			.setDesc(
				this.plugin.settings.localApiStyle === 'openai'
					? 'Base address of the server, without the /v1 suffix (e.g. http://127.0.0.1:8091)'
					: 'Ollama server address'
			)
			.addText(text => {
				text
					.setPlaceholder('Server address')
					.setValue(this.plugin.settings.ollamaHost)
					.onChange(async (value) => {
						this.plugin.settings.ollamaHost = value || 'http://localhost:11434';
						await this.plugin.saveSettings();
					});
			});
		this.addModelSetting(this.providerSettingsEls.ollama, {
			name: 'Model',
			desc: 'Ollama model to use',
			provider: 'ollama',
			get: () => this.plugin.settings.ollamaModel,
			set: async (value) => {
				this.plugin.settings.ollamaModel = value;
				await this.plugin.saveSettings();
			},
		});

		// Update visibility based on current provider
		this.updateProviderSettings();

		// Analysis section
		new Setting(containerEl).setName('Analysis').setHeading();

		// Extraction mode
		new Setting(containerEl)
			.setName('Extraction mode')
			.setDesc('Controls how thorough the entity extraction is. Content is split into chunks (~500 tokens each) for parallel processing.')
			.addDropdown(dropdown => {
				dropdown
					.addOption('standard', 'Standard (max 15 entities per chunk)')
					.addOption('thorough', 'Thorough (no limits per chunk)')
					.setValue(this.plugin.settings.extractionMode || 'standard')
					.onChange(async (value) => {
						this.plugin.settings.extractionMode = value as ExtractionMode;
						await this.plugin.saveSettings();
					});
			});

		this.addEffortSetting(containerEl, {
			name: 'Reasoning effort',
			desc: 'How much the model reasons before extracting. Notes are processed in many parallel chunks, so higher levels raise cost and latency noticeably.',
			get: () => this.plugin.settings.extractionEffort,
			set: async (value) => {
				this.plugin.settings.extractionEffort = value;
				await this.plugin.saveSettings();
			},
		});

		// Auto-analysis toggle
		new Setting(containerEl)
			.setName('Auto-analyze on save')
			.setDesc('Automatically analyze notes when you save them. Requires API key to be configured.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.autoAnalyzeOnSave)
					.onChange(async (value) => {
						this.plugin.settings.autoAnalyzeOnSave = value;
						await this.plugin.saveSettings();
					});
			});

		for (const definition of this.getExclusionSettings()) {
			const setting = new Setting(containerEl).setName(definition.name).setDesc(definition.desc ?? '');
			definition.render?.(setting);
		}

		// Agent access section
		new Setting(containerEl).setName('Agent access').setHeading();
		for (const definition of this.getAgentAccessSettings()) {
			if (definition.visible && !definition.visible()) continue;
			const setting = new Setting(containerEl).setName(definition.name).setDesc(definition.desc ?? '');
			definition.render?.(setting);
		}

		// View section
		new Setting(containerEl).setName('View').setHeading();

		new Setting(containerEl)
			.setName('Open graph in main window')
			.setDesc('If enabled, the graph view will open in a main tab instead of the right sidebar.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.openGraphInMain)
					.onChange(async (value) => {
						this.plugin.settings.openGraphInMain = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Show note nodes')
			.setDesc('Include your notes in the graph, linked to the entities they mention. Turn off for an entity-only view.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.graphShowNotes)
					.onChange(async (value) => {
						this.plugin.settings.graphShowNotes = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Minimum connections')
			.setDesc(`Hide nodes with fewer than this many connections (current: ${this.plugin.settings.graphMinDegree})`)
			.addSlider(slider => {
				slider
					.setLimits(0, 10, 1)
					.setValue(this.plugin.settings.graphMinDegree)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.graphMinDegree = value;
						await this.plugin.saveSettings();
					});
			});

		this.renderWritebackSection(containerEl);

		// Entity Resolution section
		new Setting(containerEl).setName('Entity resolution (advanced)').setHeading();

		const resolutionInfo = containerEl.createDiv({ cls: 'setting-item-description sgb-resolution-info' });
		resolutionInfo.appendText('Entity resolution uses embeddings to detect semantically similar entities (e.g., "AI" and "Artificial Intelligence") and merge them automatically. This is optional and incurs additional API costs.');

		// Enable embeddings toggle
		new Setting(containerEl)
			.setName('Enable embedding-based resolution')
			.setDesc('Use embeddings to find and merge similar entities. Requires an embedding API key.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableEmbeddings)
					.onChange(async (value) => {
						this.plugin.settings.enableEmbeddings = value;
						await this.plugin.saveSettings();
						this.refreshSettings(); // Refresh to show/hide related settings
					});
			});

		// Only show embedding settings if enabled
		if (this.plugin.settings.enableEmbeddings) {
			// Embedding provider
			new Setting(containerEl)
				.setName('Embedding provider')
				.setDesc('Select the provider for embeddings. Claude and DeepSeek do not offer embeddings.')
				.addDropdown(dropdown => {
					dropdown
						.addOption('openai', 'OpenAI')
						.addOption('gemini', 'Gemini')
						.addOption('ollama', 'Ollama (local)')
						.setValue(this.plugin.settings.embeddingProvider)
						.onChange(async (value) => {
							this.plugin.settings.embeddingProvider = value as EmbeddingProvider;
							// Set default model for the provider
							const models = EMBEDDING_MODEL_OPTIONS[value as keyof typeof EMBEDDING_MODEL_OPTIONS];
							if (models && models.length > 0) {
								this.plugin.settings.embeddingModel = models[0].id;
							}
							await this.plugin.saveSettings();
							this.refreshSettings(); // Refresh to update model options
						});
				});

			// Embedding API key (separate from main key)
			const embeddingProvider = this.plugin.settings.embeddingProvider;
			if (embeddingProvider !== 'ollama') {
				const keySetting = new Setting(containerEl)
					.setName('Embedding API key')
					.setDesc('API key for embeddings. Leave blank to use the main API key.')
					.addText(text => {
						text
							.setPlaceholder('Leave blank to use main key')
							.setValue(this.plugin.settings.embeddingApiKey)
							.onChange(async (value) => {
								this.plugin.settings.embeddingApiKey = value;
								await this.plugin.saveSettings();
								this.refreshSettings();
							});
						text.inputEl.type = 'password';
					});

				// The fallback to the main key is empty when the chat provider is
				// a local server, which needs no key. Say so here rather than
				// letting it surface as a failure on the first resolution pass.
				const providerKey = this.plugin.settings.apiKeys?.[embeddingProvider];
				if (!this.plugin.settings.embeddingApiKey && !providerKey && !this.plugin.settings.apiKey) {
					keySetting.descEl
						.createDiv({ cls: 'sgb-model-warning sgb-model-warning-error' })
						.appendText(
							`No key set for ${embeddingProvider}, and no other key to fall back on. Entity resolution will fail until a key is entered here.`
						);
				}
			}

			// A local chat model does not imply a local embedding model, so the
			// embedding server is configured independently of the chat provider.
			if (embeddingProvider === 'ollama') {
				new Setting(containerEl)
					.setName('Embedding server API')
					.setDesc('Which API the embedding server speaks. Set independently of the chat provider.')
					.addDropdown(dropdown => {
						dropdown
							.addOption('ollama', 'Ollama (/api/embed)')
							.addOption('openai', 'OpenAI-compatible (/v1/embeddings)')
							.setValue(this.plugin.settings.embeddingLocalApiStyle ?? 'ollama')
							.onChange(async (value) => {
								this.plugin.settings.embeddingLocalApiStyle = value as LocalApiStyle;
								await this.plugin.saveSettings();
								this.refreshSettings();
							});
					});

				new Setting(containerEl)
					.setName('Embedding server host')
					.setDesc('Leave blank to reuse the chat provider’s host. Set this when embeddings run on a different server.')
					.addText(text => {
						text
							.setPlaceholder(this.plugin.settings.ollamaHost || 'http://localhost:11434')
							.setValue(this.plugin.settings.embeddingHost)
							.onChange(async (value) => {
								this.plugin.settings.embeddingHost = value.trim();
								await this.plugin.saveSettings();
							});
						text.inputEl.addClass('sgb-setting-input-wide');
					});
			}

			// Embedding model
			const embeddingModels = EMBEDDING_MODEL_OPTIONS[embeddingProvider] || [];
			const EMBEDDING_CUSTOM = '__custom__';
			const knownEmbeddingIds = embeddingModels.map(m => m.id);
			let embeddingCustomInput: TextComponent | undefined;

			new Setting(containerEl)
				.setName('Embedding model')
				.setDesc(
					'Select the embedding model to use. Vector width is taken from the model’s actual output, so custom models work; changing model requires recomputing embeddings.'
				)
				.addDropdown(dropdown => {
					for (const model of embeddingModels) {
						dropdown.addOption(model.id, model.name);
					}
					dropdown.addOption(EMBEDDING_CUSTOM, 'Custom…');

					const current = this.plugin.settings.embeddingModel;
					dropdown.setValue(knownEmbeddingIds.includes(current) ? current : EMBEDDING_CUSTOM);

					dropdown.onChange(async (value) => {
						if (value === EMBEDDING_CUSTOM) {
							if (embeddingCustomInput) {
								embeddingCustomInput.inputEl.disabled = false;
								embeddingCustomInput.inputEl.focus();
							}
							return;
						}
						embeddingCustomInput?.setValue('');
						if (embeddingCustomInput) embeddingCustomInput.inputEl.disabled = true;
						this.plugin.settings.embeddingModel = value;
						await this.plugin.saveSettings();
					});
				})
				.addText(text => {
					embeddingCustomInput = text;
					const current = this.plugin.settings.embeddingModel;
					const isCustom = !knownEmbeddingIds.includes(current);

					text
						.setPlaceholder('Custom model ID')
						.setValue(isCustom ? current : '')
						.onChange(async (value) => {
							const trimmed = value.trim();
							if (trimmed) {
								this.plugin.settings.embeddingModel = trimmed;
								await this.plugin.saveSettings();
							}
						});

					text.inputEl.disabled = !isCustom;
					text.inputEl.addClass('sgb-setting-input-wide');
				});

			// High confidence threshold
			new Setting(containerEl)
				.setName('Auto-merge threshold')
				.setDesc(`Similarity above this threshold will auto-merge (current: ${this.plugin.settings.resolutionThresholdHigh.toFixed(2)})`)
				.addSlider(slider => {
					slider
						.setLimits(0.85, 0.99, 0.01)
						.setValue(this.plugin.settings.resolutionThresholdHigh)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.resolutionThresholdHigh = value;
							// Ensure low threshold is lower than high
							if (this.plugin.settings.resolutionThresholdLow >= value) {
								this.plugin.settings.resolutionThresholdLow = value - 0.05;
							}
							await this.plugin.saveSettings();
						});
				});

			// Low confidence threshold
			new Setting(containerEl)
				.setName('Verification threshold')
				.setDesc(`Similarity above this but below auto-merge will use LLM verification (current: ${this.plugin.settings.resolutionThresholdLow.toFixed(2)})`)
				.addSlider(slider => {
					slider
						.setLimits(0.70, 0.90, 0.01)
						.setValue(this.plugin.settings.resolutionThresholdLow)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.resolutionThresholdLow = value;
							// Ensure high threshold is higher than low
							if (this.plugin.settings.resolutionThresholdHigh <= value) {
								this.plugin.settings.resolutionThresholdHigh = value + 0.05;
							}
							await this.plugin.saveSettings();
						});
				});

			// LLM verification toggle
			new Setting(containerEl)
				.setName('Enable verification')
				.setDesc('Use the model to verify ambiguous matches. Adds extra API calls but improves accuracy.')
				.addToggle(toggle => {
					toggle
						.setValue(this.plugin.settings.enableLLMVerification)
						.onChange(async (value) => {
							this.plugin.settings.enableLLMVerification = value;
							await this.plugin.saveSettings();
						});
				});

			// Compute embeddings button
			const embeddingsCount = this.plugin.graphCache.getEmbeddingsCount();
			const nodesCount = this.plugin.graphCache.getStats().nodes;
			const missingEmbeddings = nodesCount - embeddingsCount;

			new Setting(containerEl)
				.setName('Compute embeddings for existing nodes')
				.setDesc(`${embeddingsCount}/${nodesCount} nodes have embeddings.${missingEmbeddings > 0 ? ` ${missingEmbeddings} missing.` : ''}`)
				.addButton(button => {
					button
						.setButtonText(missingEmbeddings > 0 ? 'Compute Missing' : 'Recompute All')
						.onClick(async () => {
							await this.computeEmbeddings(missingEmbeddings > 0);
						});
				});

			// Clear resolution cache button
			const cacheSize = this.plugin.graphCache.getResolutionCacheSize();
			new Setting(containerEl)
				.setName('Clear resolution cache')
				.setDesc(`${cacheSize} cached resolutions. Clearing will re-resolve entities on next analysis.`)
				.addButton(button => {
					button
						.setButtonText('Clear cache')
						.setWarning()
						.onClick(async () => {
							this.plugin.graphCache.clearResolutionCache();
							await this.plugin.graphCache.flush();
							new Notice('Resolution cache cleared');
							this.refreshSettings();
						});
				});
		}

		// Vault analysis section
		new Setting(containerEl).setName('Vault analysis').setHeading();

		const vaultWarning = containerEl.createDiv({ cls: 'setting-item-description vault-analysis-warning' });
		vaultWarning.createEl('strong', { text: 'Warning:' });
		vaultWarning.appendText(' Analyzing the entire vault will:');
		const warningList = vaultWarning.createEl('ul');
		warningList.createEl('li', { text: 'Send changed eligible notes to your provider in chunks (can be expensive for large vaults)' });
		warningList.createEl('li', { text: 'Take a long time (approx. 10-15 seconds per note)' });
		warningList.createEl('li', { text: 'May hit rate limits depending on your API plan' });
		vaultWarning.createEl('em', { text: 'Already analyzed notes will be skipped unless changed.' });

		const vaultButtonContainer = containerEl.createDiv({ cls: 'vault-analysis-buttons' });

		new Setting(vaultButtonContainer)
			.setName('Analyze entire vault')
			.setDesc('Enumerates markdown file paths only after you confirm the analysis.')
			.addButton(button => {
				const updateButtonState = () => {
					if (isAnalyzingVault()) {
						button.setButtonText('Cancel').setWarning();
					} else {
						button.setButtonText('Start analysis').removeCta().setClass('mod-cta');
					}
				};

				updateButtonState();

				button.onClick(() => {
					if (isAnalyzingVault()) {
						cancelVaultAnalysis();
						new Notice('Cancelling vault analysis...');
						// Button will update after analysis stops
						window.setTimeout(updateButtonState, 1000);
					} else {
						const message = 'Analyze eligible markdown notes in your vault?\n\n' +
							'The plugin will enumerate markdown file paths after confirmation, skip excluded notes, and send changed eligible notes to your configured provider in chunks.\n\n' +
							`You can cancel at any time.`;

						void new ConfirmModal(this.app, message, async () => {
							updateButtonState();
							await analyzeEntireVault(this.plugin);
							updateButtonState();
							this.renderGraphStats(statsEl);
						}).open();
					}
				});
			});

		// Data Management section
		new Setting(containerEl).setName('Data management').setHeading();

		// Graph stats
		const statsEl = containerEl.createDiv({ cls: 'graph-stats' });
		this.renderGraphStats(statsEl);

		// Clear graph button
		new Setting(containerEl)
			.setName('Clear graph data')
			.setDesc('Remove all nodes, edges, and analysis history. This cannot be undone.')
			.addButton(button => {
				button
					.setButtonText('Clear all data')
					.setWarning()
					.onClick(() => {
						const message = 'Are you sure you want to clear all graph data?\n\n' +
							'This will remove:\n' +
							'- All extracted nodes and relationships\n' +
							'- All note connections\n' +
							'- Analysis history (notes will be re-analyzed)\n\n' +
							'This action cannot be undone.';
						void new ConfirmModal(this.app, message, async () => {
							this.plugin.graphCache.clear();
							await this.plugin.graphCache.flush();
							await clearHashes(this.plugin);
							new Notice('Graph data cleared');
							this.renderGraphStats(statsEl);
						}).open();
					});
			});

		// Support section
		new Setting(containerEl).setName('Support').setHeading();

		new Setting(containerEl)
			.setName('Buy me a coffee')
			.setDesc('If you find this plugin useful, consider supporting its development!')
			.addButton(button => {
				button
					.setButtonText('Buy me a coffee')
					.setCta()
					.onClick(() => {
						window.open('https://buymeacoffee.com/junhewkkim', '_blank');
					});
			});
	}

	/**
	 * Vault write-back: the settings that let the plugin edit notes.
	 *
	 * Gated behind one master toggle and spelled out in detail, because this is
	 * the only part of the plugin that writes into a user's own files. The
	 * ownership contract is stated here so nobody has to discover it by finding
	 * their text replaced.
	 */
	private renderWritebackSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Vault write-back').setHeading();

		const intro = containerEl.createDiv({ cls: 'setting-item-description' });
		intro.appendText(
			'Mirror the knowledge graph into your vault as real Obsidian links, so it also shows up in the ' +
			'built-in graph view, in backlinks, and in the properties panel. Entity notes carry the aliases ' +
			'found by entity resolution, which is what lets Obsidian treat "ML" and "머신러닝" as one thing.'
		);

		new Setting(containerEl)
			.setName('Create entity notes')
			.setDesc('Write one note per entity, with its aliases, type and relationships.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableEntityNotes)
					.onChange(async (value) => {
						this.plugin.settings.enableEntityNotes = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (!this.plugin.settings.enableEntityNotes) return;

		const ownership = containerEl.createDiv({ cls: 'setting-item-description' });
		ownership.createEl('strong', { text: 'What the plugin will edit:' });
		const ownershipList = ownership.createEl('ul');
		ownershipList.createEl('li', { text: 'In entity notes: the aliases, entity-type and sgb-id properties, and the text between the sgb managed markers. Anything you write outside those is kept.' });
		ownershipList.createEl('li', { text: 'In your own notes: nothing but the link property below. Your prose is never touched.' });

		new Setting(containerEl)
			.setName('Entity folder')
			.setDesc('Where entity notes live. Notes in this folder are never analyzed.')
			.addText(text => {
				text
					.setPlaceholder('Entities')
					.setValue(this.plugin.settings.entityFolder)
					.onChange(async (value) => {
						// Must go through normalizeFolder: "/" trims to a non-empty
						// string but names the vault root, which would scatter entity
						// notes among the user's own and leave them analyzable.
						this.plugin.settings.entityFolder = normalizeFolder(value) || 'Entities';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('List relationships in entity notes')
			.setDesc('Add a Relationships section linking each entity to the ones it connects to, so entity-to-entity edges appear in the built-in graph.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.writeRelationshipsSection)
					.onChange(async (value) => {
						this.plugin.settings.writeRelationshipsSection = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Link notes to their entities')
			.setDesc('Add a property to each analyzed note listing the entities found in it.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.enableRelatedWriteback)
					.onChange(async (value) => {
						this.plugin.settings.enableRelatedWriteback = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.enableRelatedWriteback) {
			new Setting(containerEl)
				.setName('Property name')
				.setDesc('The frontmatter property the plugin owns. It is replaced on every analysis.')
				.addText(text => {
					text
						.setPlaceholder('related')
						.setValue(this.plugin.settings.relatedPropertyName)
						.onChange(async (value) => {
							const clean = value.trim().replace(/:/g, '');
							this.plugin.settings.relatedPropertyName = clean || 'related';
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName('Write links for the whole vault')
			.setDesc('Apply the current graph to every analyzed note at once. No API calls.')
			.addButton(button => {
				const update = () => {
					if (isWritebackRunning()) button.setButtonText('Cancel').setWarning();
					else button.setButtonText('Write links').removeCta().setClass('mod-cta');
				};
				update();

				button.onClick(() => {
					if (isWritebackRunning()) {
						cancelWriteback();
						new Notice('Cancelling...');
						window.setTimeout(update, 1000);
						return;
					}

					const entities = this.plugin.graphCache.getAllNodes().filter(n => n.entityType !== 'NOTE').length;
					const message = `Write links for ${entities} entities into your vault?\n\n` +
						`This creates or updates notes in "${this.plugin.settings.entityFolder}"` +
						(this.plugin.settings.enableRelatedWriteback
							? `, and adds a "${this.plugin.settings.relatedPropertyName}" property to each analyzed note.`
							: '.');

					void new ConfirmModal(this.app, message, async () => {
						update();
						await writeLinksForVault(this.plugin);
						update();
					}).open();
				});
			});

		new Setting(containerEl)
			.setName('Remove written links')
			.setDesc('Take the link property back out of every note. Entity notes are left in place for you to delete.')
			.addButton(button => {
				button
					.setButtonText('Remove links')
					.setWarning()
					.onClick(() => {
						const message = `Remove the "${this.plugin.settings.relatedPropertyName}" property from every note in the vault?\n\n` +
							'Your prose is not touched, and the entity notes stay where they are.';
						void new ConfirmModal(this.app, message, async () => {
							await removeWrittenLinks(this.plugin);
						}).open();
					});
			});
	}

	private renderGraphStats(container: HTMLElement): void {
		container.empty();
		const stats = this.plugin.graphCache.getStats();

		const statsText = container.createEl('p', { cls: 'setting-item-description' });
		if (stats.nodes === 0) {
			statsText.setText('No graph data yet. Analyze some notes to build your knowledge graph.');
		} else {
			// Build label breakdown
			const labelCounts = Object.entries(stats.labels)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([label, count]) => `${count} ${label}`)
				.join(', ');

			statsText.setText(
				`Graph contains: ${stats.nodes} nodes, ${stats.edges} connections` +
				(labelCounts ? ` (${labelCounts})` : '')
			);
		}
	}

	private updateProviderSettings() {
		const currentProvider = this.plugin.settings.apiProvider;
		const providers: ApiProvider[] = ['claude', 'openai', 'gemini', 'deepseek', 'ollama'];

		for (const provider of providers) {
			const el = this.providerSettingsEls[provider];
			if (el) {
				el.toggle(provider === currentProvider);
			}
		}
	}

	/**
	 * Compute embeddings for existing nodes.
	 * @param onlyMissing If true, only compute for nodes without embeddings.
	 */
	private async computeEmbeddings(onlyMissing: boolean): Promise<void> {
		const nodes = this.plugin.graphCache.getAllNodes();
		const embeddingOptions = settingsToEmbeddingOptions(this.plugin.settings);

		// Filter nodes if only computing missing
		const nodesToProcess = onlyMissing
			? nodes.filter(n => !this.plugin.graphCache.hasEmbedding(n.id))
			: nodes;

		if (nodesToProcess.length === 0) {
			new Notice('All nodes already have embeddings');
			return;
		}

		const progressNotice = new Notice(`Computing embeddings: 0/${nodesToProcess.length}...`, 0);

		try {
			// Process in batches to avoid API limits
			const batchSize = 50;
			let processed = 0;

			for (let i = 0; i < nodesToProcess.length; i += batchSize) {
				const batch = nodesToProcess.slice(i, i + batchSize);
				const names = batch.map(n => n.properties.name);

				progressNotice.setMessage(`Computing embeddings: ${processed}/${nodesToProcess.length}...`);

				const embeddings = await getEmbeddings(embeddingOptions, names);

				for (let j = 0; j < batch.length; j++) {
					this.plugin.graphCache.setEmbedding(batch[j].id, embeddings[j]);
				}

				processed += batch.length;

				// Small delay between batches
				if (i + batchSize < nodesToProcess.length) {
					await new Promise(resolve => window.setTimeout(resolve, 100));
				}
			}

			// Save embeddings
			await this.plugin.graphCache.saveEmbeddings();

			progressNotice.hide();
			new Notice(`Computed embeddings for ${processed} nodes`);
			this.refreshSettings(); // Refresh to update counts

		} catch (error) {
			progressNotice.hide();
			console.error('Failed to compute embeddings:', error);
			new Notice(`Failed to compute embeddings: ${(error as Error).message}`);
		}
	}
}

function describeMcpStatus(status: McpStatus): string {
	switch (status.state) {
		case 'running':
			return `Running at http://127.0.0.1:${status.port}/mcp`;
		case 'starting':
			return 'Starting…';
		case 'error':
			return status.message;
		case 'unsupported':
			return 'Not available on this device.';
		default:
			return 'Stopped.';
	}
}
