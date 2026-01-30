import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { ApiProvider, EmbeddingProvider, ExtractionMode } from '../types';
import { MODEL_OPTIONS, EMBEDDING_MODEL_OPTIONS } from '../settings';
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
					.addOption('claude', 'Claude (Anthropic)')
					.addOption('openai', 'OpenAI')
					.addOption('gemini', 'Gemini (Google)')
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
			.setDesc('Your Anthropic API key')
			.addText(text => {
				text
					.setPlaceholder('sk-ant-...')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
		new Setting(this.providerSettingsEls.claude)
			.setName('Model')
			.setDesc('Claude model to use')
			.addDropdown(dropdown => {
				for (const model of MODEL_OPTIONS.claude) {
					dropdown.addOption(model, model);
				}
				dropdown
					.setValue(this.plugin.settings.claudeModel)
					.onChange(async (value) => {
						this.plugin.settings.claudeModel = value;
						await this.plugin.saveSettings();
					});
			})
			.addText(text => {
				text
					.setPlaceholder('Or enter custom model')
					.setValue(MODEL_OPTIONS.claude.includes(this.plugin.settings.claudeModel) ? '' : this.plugin.settings.claudeModel)
					.onChange(async (value) => {
						if (value.trim()) {
							this.plugin.settings.claudeModel = value.trim();
							await this.plugin.saveSettings();
						}
					});
				text.inputEl.addClass('sgb-setting-input-wide');
			});

		// OpenAI settings
		this.providerSettingsEls.openai = containerEl.createDiv();
		new Setting(this.providerSettingsEls.openai)
			.setName('API key')
			.setDesc('Your OpenAI API key')
			.addText(text => {
				text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
		new Setting(this.providerSettingsEls.openai)
			.setName('Model')
			.setDesc('OpenAI model to use')
			.addDropdown(dropdown => {
				for (const model of MODEL_OPTIONS.openai) {
					dropdown.addOption(model, model);
				}
				dropdown
					.setValue(this.plugin.settings.openaiModel)
					.onChange(async (value) => {
						this.plugin.settings.openaiModel = value;
						await this.plugin.saveSettings();
					});
			})
			.addText(text => {
				text
					.setPlaceholder('Or enter custom model')
					.setValue(MODEL_OPTIONS.openai.includes(this.plugin.settings.openaiModel) ? '' : this.plugin.settings.openaiModel)
					.onChange(async (value) => {
						if (value.trim()) {
							this.plugin.settings.openaiModel = value.trim();
							await this.plugin.saveSettings();
						}
					});
				text.inputEl.addClass('sgb-setting-input-wide');
			});

		// Gemini settings
		this.providerSettingsEls.gemini = containerEl.createDiv();
		new Setting(this.providerSettingsEls.gemini)
			.setName('API key')
			.setDesc('Your Google AI API key')
			.addText(text => {
				text
					.setPlaceholder('Enter your API key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});
		new Setting(this.providerSettingsEls.gemini)
			.setName('Model')
			.setDesc('Gemini model to use')
			.addDropdown(dropdown => {
				for (const model of MODEL_OPTIONS.gemini) {
					dropdown.addOption(model, model);
				}
				dropdown
					.setValue(this.plugin.settings.geminiModel)
					.onChange(async (value) => {
						this.plugin.settings.geminiModel = value;
						await this.plugin.saveSettings();
					});
			})
			.addText(text => {
				text
					.setPlaceholder('Or enter custom model')
					.setValue(MODEL_OPTIONS.gemini.includes(this.plugin.settings.geminiModel) ? '' : this.plugin.settings.geminiModel)
					.onChange(async (value) => {
						if (value.trim()) {
							this.plugin.settings.geminiModel = value.trim();
							await this.plugin.saveSettings();
						}
					});
				text.inputEl.addClass('sgb-setting-input-wide');
			});

		// Ollama settings
		this.providerSettingsEls.ollama = containerEl.createDiv();
		new Setting(this.providerSettingsEls.ollama)
			.setName('Host')
			.setDesc('Ollama server address')
			.addText(text => {
				text
					.setPlaceholder('http://localhost:11434')
					.setValue(this.plugin.settings.ollamaHost)
					.onChange(async (value) => {
						this.plugin.settings.ollamaHost = value || 'http://localhost:11434';
						await this.plugin.saveSettings();
					});
			});
		new Setting(this.providerSettingsEls.ollama)
			.setName('Model')
			.setDesc('Ollama model to use')
			.addDropdown(dropdown => {
				for (const model of MODEL_OPTIONS.ollama) {
					dropdown.addOption(model, model);
				}
				dropdown
					.setValue(MODEL_OPTIONS.ollama.includes(this.plugin.settings.ollamaModel) ? this.plugin.settings.ollamaModel : MODEL_OPTIONS.ollama[0])
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
					});
			})
			.addText(text => {
				text
					.setPlaceholder('Or enter custom model')
					.setValue(MODEL_OPTIONS.ollama.includes(this.plugin.settings.ollamaModel) ? '' : this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						if (value.trim()) {
							this.plugin.settings.ollamaModel = value.trim();
							await this.plugin.saveSettings();
						}
					});
				text.inputEl.addClass('sgb-setting-input-wide');
			});

		// Tool calling warning for Ollama
		const ollamaWarning = this.providerSettingsEls.ollama.createEl('div', { cls: 'setting-item-description sgb-ollama-warning' });
		ollamaWarning.createEl('strong', { text: 'Smart search compatibility:' });
		ollamaWarning.appendText(' Some models have limited tool calling support.');
		ollamaWarning.createEl('br');
		ollamaWarning.createEl('code', { text: 'deepseek-r1:*' });
		ollamaWarning.appendText(' and ');
		ollamaWarning.createEl('code', { text: 'gemma3:*' });
		ollamaWarning.appendText(' may not work with Smart Search.');
		ollamaWarning.createEl('br');
		ollamaWarning.appendText('Recommended: ');
		ollamaWarning.createEl('code', { text: 'qwen3:*' });
		ollamaWarning.appendText(', ');
		ollamaWarning.createEl('code', { text: 'gpt-oss:*' });
		ollamaWarning.appendText(' for best results.');

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

		const smartSearchInfo = containerEl.createEl('div', { cls: 'setting-item-description sgb-smart-search-info' });
		smartSearchInfo.appendText('By default, Smart search uses the same model as extraction. You can configure a separate model for better search results (e.g., use a faster model for extraction and a more capable model for search).');

		// Use separate Smart Search model toggle
		new Setting(containerEl)
			.setName('Use separate model for smart search')
			.setDesc('Enable to configure a different model for Smart search queries.')
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
				.setDesc('Select the provider for Smart search queries.')
				.addDropdown(dropdown => {
					dropdown
						.addOption('claude', 'Claude (Anthropic)')
						.addOption('openai', 'OpenAI')
						.addOption('gemini', 'Gemini (Google)')
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

			if (smartSearchProvider === 'claude') {
				new Setting(containerEl)
					.setName('Smart search Claude model')
					.addDropdown(dropdown => {
						for (const model of MODEL_OPTIONS.claude) {
							dropdown.addOption(model, model);
						}
						dropdown
							.setValue(this.plugin.settings.smartSearchClaudeModel)
							.onChange(async (value) => {
								this.plugin.settings.smartSearchClaudeModel = value;
								await this.plugin.saveSettings();
							});
					})
					.addText(text => {
						text
							.setPlaceholder('Or enter custom model')
							.setValue(MODEL_OPTIONS.claude.includes(this.plugin.settings.smartSearchClaudeModel) ? '' : this.plugin.settings.smartSearchClaudeModel)
							.onChange(async (value) => {
								if (value.trim()) {
									this.plugin.settings.smartSearchClaudeModel = value.trim();
									await this.plugin.saveSettings();
								}
							});
						text.inputEl.addClass('sgb-setting-input-wide');
					});
			} else if (smartSearchProvider === 'openai') {
				new Setting(containerEl)
					.setName('Smart search OpenAI model')
					.addDropdown(dropdown => {
						for (const model of MODEL_OPTIONS.openai) {
							dropdown.addOption(model, model);
						}
						dropdown
							.setValue(this.plugin.settings.smartSearchOpenaiModel)
							.onChange(async (value) => {
								this.plugin.settings.smartSearchOpenaiModel = value;
								await this.plugin.saveSettings();
							});
					})
					.addText(text => {
						text
							.setPlaceholder('Or enter custom model')
							.setValue(MODEL_OPTIONS.openai.includes(this.plugin.settings.smartSearchOpenaiModel) ? '' : this.plugin.settings.smartSearchOpenaiModel)
							.onChange(async (value) => {
								if (value.trim()) {
									this.plugin.settings.smartSearchOpenaiModel = value.trim();
									await this.plugin.saveSettings();
								}
							});
						text.inputEl.addClass('sgb-setting-input-wide');
					});
			} else if (smartSearchProvider === 'gemini') {
				new Setting(containerEl)
					.setName('Smart search Gemini model')
					.addDropdown(dropdown => {
						for (const model of MODEL_OPTIONS.gemini) {
							dropdown.addOption(model, model);
						}
						dropdown
							.setValue(this.plugin.settings.smartSearchGeminiModel)
							.onChange(async (value) => {
								this.plugin.settings.smartSearchGeminiModel = value;
								await this.plugin.saveSettings();
							});
					})
					.addText(text => {
						text
							.setPlaceholder('Or enter custom model')
							.setValue(MODEL_OPTIONS.gemini.includes(this.plugin.settings.smartSearchGeminiModel) ? '' : this.plugin.settings.smartSearchGeminiModel)
							.onChange(async (value) => {
								if (value.trim()) {
									this.plugin.settings.smartSearchGeminiModel = value.trim();
									await this.plugin.saveSettings();
								}
							});
						text.inputEl.addClass('sgb-setting-input-wide');
					});
			} else if (smartSearchProvider === 'ollama') {
				new Setting(containerEl)
					.setName('Smart search Ollama model')
					.addDropdown(dropdown => {
						for (const model of MODEL_OPTIONS.ollama) {
							dropdown.addOption(model, model);
						}
						dropdown
							.setValue(MODEL_OPTIONS.ollama.includes(this.plugin.settings.smartSearchOllamaModel) ? this.plugin.settings.smartSearchOllamaModel : MODEL_OPTIONS.ollama[0])
							.onChange(async (value) => {
								this.plugin.settings.smartSearchOllamaModel = value;
								await this.plugin.saveSettings();
							});
					})
					.addText(text => {
						text
							.setPlaceholder('Or enter custom model')
							.setValue(MODEL_OPTIONS.ollama.includes(this.plugin.settings.smartSearchOllamaModel) ? '' : this.plugin.settings.smartSearchOllamaModel)
							.onChange(async (value) => {
								if (value.trim()) {
									this.plugin.settings.smartSearchOllamaModel = value.trim();
									await this.plugin.saveSettings();
								}
							});
						text.inputEl.addClass('sgb-setting-input-wide');
					});

				// Tool calling warning for Ollama Smart Search
				const smartSearchOllamaWarning = containerEl.createEl('div', { cls: 'setting-item-description sgb-ollama-warning' });
				smartSearchOllamaWarning.createEl('strong', { text: 'Note:' });
				smartSearchOllamaWarning.appendText(' Smart search requires tool calling support. ');
				smartSearchOllamaWarning.createEl('code', { text: 'deepseek-r1:*' });
				smartSearchOllamaWarning.appendText(' and ');
				smartSearchOllamaWarning.createEl('code', { text: 'gemma3:*' });
				smartSearchOllamaWarning.appendText(' may not work. Recommended: ');
				smartSearchOllamaWarning.createEl('code', { text: 'qwen3:*' });
				smartSearchOllamaWarning.appendText('.');
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

		const resolutionInfo = containerEl.createEl('div', { cls: 'setting-item-description sgb-resolution-info' });
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
						.addOption('gemini', 'Gemini (Google)')
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
				new Setting(containerEl)
					.setName('Embedding API key')
					.setDesc('API key for embeddings. Leave blank to use the main API key.')
					.addText(text => {
						text
							.setPlaceholder('Leave blank to use main key')
							.setValue(this.plugin.settings.embeddingApiKey)
							.onChange(async (value) => {
								this.plugin.settings.embeddingApiKey = value;
								await this.plugin.saveSettings();
							});
						text.inputEl.type = 'password';
					});
			}

			// Embedding model
			const embeddingModels = EMBEDDING_MODEL_OPTIONS[embeddingProvider as keyof typeof EMBEDDING_MODEL_OPTIONS] || [];
			new Setting(containerEl)
				.setName('Embedding model')
				.setDesc('Select the embedding model to use.')
				.addDropdown(dropdown => {
					for (const model of embeddingModels) {
						dropdown.addOption(model.id, model.name);
					}
					dropdown
						.setValue(this.plugin.settings.embeddingModel)
						.onChange(async (value) => {
							this.plugin.settings.embeddingModel = value;
							await this.plugin.saveSettings();
						});
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

		const vaultWarning = containerEl.createEl('div', { cls: 'setting-item-description vault-analysis-warning' });
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
						setTimeout(updateButtonState, 1000);
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
				el.style.display = provider === currentProvider ? 'block' : 'none';
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
					await new Promise(resolve => setTimeout(resolve, 100));
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
