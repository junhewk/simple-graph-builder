import { App, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { ApiProvider, EmbeddingProvider, ExtractionMode, LocalApiStyle } from '../types';
import { MODEL_OPTIONS, EMBEDDING_MODEL_OPTIONS } from '../settings';
import { getAdapter } from '../extraction/providers/index';
import { EFFORT_LABELS, EFFORT_LEVELS, EffortLevel } from '../extraction/providers/effort';
import { clearHashes } from '../graph/hashes';
import { analyzeEntireVault, isAnalyzingVault, cancelVaultAnalysis } from '../commands/analyze';
import { getEmbeddings, settingsToEmbeddingOptions } from '../extraction/llm-client';
import { ConfirmModal } from './confirm-modal';

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
		opts: {
			name: string;
			desc: string;
			provider: ApiProvider;
			get: () => string;
			set: (value: string) => Promise<void>;
		}
	): void {
		const CUSTOM = '__custom__';
		const options = MODEL_OPTIONS[opts.provider];

		const setting = new Setting(container).setName(opts.name).setDesc(opts.desc);
		const warningEl = setting.descEl.createDiv({ cls: 'sgb-model-warning' });

		const refreshWarning = () => {
			warningEl.empty();
			warningEl.removeClass('sgb-model-warning-error');

			const model = opts.get();
			if (!model) return;

			const caps = getAdapter(opts.provider, {
				apiKey: this.plugin.settings.apiKey,
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

	/** Reasoning-effort picker, shared by extraction and Smart Search. */
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
						this.display();
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

		// Tool calling warning for Ollama
		const ollamaWarning = this.providerSettingsEls.ollama.createDiv({ cls: 'setting-item-description sgb-ollama-warning' });
		ollamaWarning.createEl('strong', { text: 'Smart search compatibility:' });
		ollamaWarning.appendText(' Some models have limited tool calling support.');
		ollamaWarning.createEl('br');
		ollamaWarning.appendText('Limited support: ');
		ollamaWarning.createEl('code', { text: 'Gemma3' });
		ollamaWarning.createEl('br');
		ollamaWarning.appendText('Recommended: ');
		ollamaWarning.createEl('code', { text: 'Qwen3' });

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

		// Smart Search model section
		new Setting(containerEl).setName('Smart search model').setHeading();

		const smartSearchInfo = containerEl.createDiv({ cls: 'setting-item-description sgb-smart-search-info' });
		smartSearchInfo.appendText('By default, Smart search uses the same model as extraction. You can configure a separate model for better search results (e.g., use a faster model for extraction and a more capable model for search).');

		// Use separate Smart Search model toggle
		new Setting(containerEl)
			.setName('Use separate model for smart search')
			.setDesc('Enable to configure a different model for smart search queries.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.useSeparateSmartSearchModel)
					.onChange(async (value) => {
						this.plugin.settings.useSeparateSmartSearchModel = value;
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide model settings
					});
			});

		// Only show Smart Search model settings if enabled
		if (this.plugin.settings.useSeparateSmartSearchModel) {
			// Smart Search provider
			new Setting(containerEl)
				.setName('Smart search provider')
				.setDesc('Select the provider for smart search queries.')
				.addDropdown(dropdown => {
					dropdown
						.addOption('claude', 'Claude')
						.addOption('openai', 'OpenAI')
						.addOption('gemini', 'Gemini')
						.addOption('ollama', 'Ollama (local)')
						.setValue(this.plugin.settings.smartSearchProvider)
						.onChange(async (value) => {
							this.plugin.settings.smartSearchProvider = value as ApiProvider;
							await this.plugin.saveSettings();
							this.display(); // Refresh to update model options
						});
				});

			// Smart Search model for selected provider
			const smartSearchProvider = this.plugin.settings.smartSearchProvider;
			const smartSearchModelKeys = {
				claude: 'smartSearchClaudeModel',
				openai: 'smartSearchOpenaiModel',
				gemini: 'smartSearchGeminiModel',
				ollama: 'smartSearchOllamaModel',
			} as const;
			const smartSearchLabels: Record<ApiProvider, string> = {
				claude: 'Claude',
				openai: 'OpenAI',
				gemini: 'Gemini',
				ollama: 'Ollama',
			};
			const smartSearchKey = smartSearchModelKeys[smartSearchProvider];

			if (smartSearchProvider !== 'ollama' && smartSearchProvider !== this.plugin.settings.apiProvider) {
				// That provider's own settings block is hidden, so surface its key here.
				const ssKey = new Setting(containerEl)
					.setName(`${smartSearchLabels[smartSearchProvider]} API key`)
					.setDesc('Smart search uses a different provider, so it needs that provider’s key.')
					.addText(text => {
						text
							.setPlaceholder('Enter API key')
							.setValue(this.plugin.settings.apiKeys?.[smartSearchProvider] ?? '')
							.onChange(async (value) => {
								this.plugin.settings.apiKeys = {
									...this.plugin.settings.apiKeys,
									[smartSearchProvider]: value,
								};
								await this.plugin.saveSettings();
								this.display();
							});
						text.inputEl.type = 'password';
					});

				if (!this.plugin.settings.apiKeys?.[smartSearchProvider]) {
					ssKey.descEl
						.createDiv({ cls: 'sgb-model-warning sgb-model-warning-error' })
						.appendText(`No ${smartSearchLabels[smartSearchProvider]} key set. Smart search will fail until one is entered.`);
				}
			}

			this.addModelSetting(containerEl, {
				name: `${smartSearchLabels[smartSearchProvider]} model for smart search`,
				desc: 'Model used to answer smart search queries.',
				provider: smartSearchProvider,
				get: () => this.plugin.settings[smartSearchKey],
				set: async (value) => {
					this.plugin.settings[smartSearchKey] = value;
					await this.plugin.saveSettings();
				},
			});

			this.addEffortSetting(containerEl, {
				name: 'Smart search reasoning effort',
				desc: 'How much the model reasons while exploring the graph. Higher levels answer harder questions but cost more.',
				get: () => this.plugin.settings.smartSearchEffort,
				set: async (value) => {
					this.plugin.settings.smartSearchEffort = value;
					await this.plugin.saveSettings();
				},
			});

			if (smartSearchProvider === 'ollama') {
				const warning = containerEl.createDiv({
					cls: 'setting-item-description sgb-ollama-warning',
				});
				warning.createEl('strong', { text: 'Tool calling required:' });
				warning.appendText(' smart search works by querying the graph, so the model must support tool calls.');
				warning.createEl('br');
				warning.appendText('Limited support: ');
				warning.createEl('code', { text: 'deepseek-r1:*' });
				warning.appendText(', ');
				warning.createEl('code', { text: 'gemma3:*' });
				warning.createEl('br');
				warning.appendText('Recommended: ');
				warning.createEl('code', { text: 'qwen3:*' });
				warning.appendText(', ');
				warning.createEl('code', { text: 'gpt-oss:*' });
			}
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
						this.display(); // Refresh to show/hide related settings
					});
			});

		// Only show embedding settings if enabled
		if (this.plugin.settings.enableEmbeddings) {
			// Embedding provider
			new Setting(containerEl)
				.setName('Embedding provider')
				.setDesc('Select the provider for embeddings. Claude does not offer embeddings.')
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
							this.display(); // Refresh to update model options
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
								this.display();
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
								this.display();
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
							this.display();
						});
				});
		}

		// Vault analysis section
		new Setting(containerEl).setName('Vault analysis').setHeading();

		const vaultWarning = containerEl.createDiv({ cls: 'setting-item-description vault-analysis-warning' });
		vaultWarning.createEl('strong', { text: 'Warning:' });
		vaultWarning.appendText(' Analyzing the entire vault will:');
		const warningList = vaultWarning.createEl('ul');
		warningList.createEl('li', { text: 'Make one API call per note (can be expensive for large vaults)' });
		warningList.createEl('li', { text: 'Take a long time (approx. 10-15 seconds per note)' });
		warningList.createEl('li', { text: 'May hit rate limits depending on your API plan' });
		vaultWarning.createEl('em', { text: 'Already analyzed notes will be skipped unless changed.' });

		const vaultButtonContainer = containerEl.createDiv({ cls: 'vault-analysis-buttons' });

		new Setting(vaultButtonContainer)
			.setName('Analyze entire vault')
			.setDesc(`${this.plugin.app.vault.getMarkdownFiles().length} markdown files in vault`)
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
						const fileCount = this.plugin.app.vault.getMarkdownFiles().length;
						const message = `Analyze ${fileCount} notes in your vault?\n\n` +
							`Estimated time: ${Math.ceil(fileCount * 10 / 60)} - ${Math.ceil(fileCount * 15 / 60)} minutes\n` +
							`Estimated API calls: up to ${fileCount}\n\n` +
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
		const providers: ApiProvider[] = ['claude', 'openai', 'gemini', 'ollama'];

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
			this.display(); // Refresh to update counts

		} catch (error) {
			progressNotice.hide();
			console.error('Failed to compute embeddings:', error);
			new Notice(`Failed to compute embeddings: ${(error as Error).message}`);
		}
	}
}
