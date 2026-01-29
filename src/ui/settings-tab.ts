import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { ApiProvider, EmbeddingProvider, ExtractionMode } from '../types';
import { MODEL_OPTIONS, EMBEDDING_MODEL_OPTIONS } from '../settings';
import { clearHashes } from '../graph/hashes';
import { analyzeEntireVault, isAnalyzingVault, cancelVaultAnalysis } from '../commands/analyze';
import { getEmbeddings, settingsToEmbeddingOptions } from '../extraction/llm-client';

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

		containerEl.createEl('h2', { text: 'Simple Graph Builder Settings' });

		// API Provider
		new Setting(containerEl)
			.setName('API Provider')
			.setDesc('Select the LLM provider for entity extraction')
			.addDropdown(dropdown => {
				dropdown
					.addOption('claude', 'Claude (Anthropic)')
					.addOption('openai', 'OpenAI')
					.addOption('gemini', 'Gemini (Google)')
					.addOption('ollama', 'Ollama (Local)')
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
			.setName('API Key')
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
				text.inputEl.style.width = '180px';
			});

		// OpenAI settings
		this.providerSettingsEls.openai = containerEl.createDiv();
		new Setting(this.providerSettingsEls.openai)
			.setName('API Key')
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
				text.inputEl.style.width = '180px';
			});

		// Gemini settings
		this.providerSettingsEls.gemini = containerEl.createDiv();
		new Setting(this.providerSettingsEls.gemini)
			.setName('API Key')
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
				text.inputEl.style.width = '180px';
			});

		// Ollama settings
		this.providerSettingsEls.ollama = containerEl.createDiv();
		new Setting(this.providerSettingsEls.ollama)
			.setName('Host')
			.setDesc('URL of your Ollama server')
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
				text.inputEl.style.width = '180px';
			});

		// Tool calling warning for Ollama
		const ollamaWarning = this.providerSettingsEls.ollama.createEl('div', { cls: 'setting-item-description' });
		ollamaWarning.style.marginTop = '8px';
		ollamaWarning.style.padding = '8px';
		ollamaWarning.style.backgroundColor = 'var(--background-modifier-message)';
		ollamaWarning.style.borderRadius = '4px';
		ollamaWarning.innerHTML = `
			<strong>Smart Search compatibility:</strong> Some models have limited tool calling support.
			<br><code>deepseek-r1:*</code> and <code>gemma3:*</code> may not work with Smart Search.
			<br>Recommended: <code>qwen3:*</code>, <code>gpt-oss:*</code> for best results.
		`;

		// Update visibility based on current provider
		this.updateProviderSettings();

		// Analysis Settings section
		containerEl.createEl('h3', { text: 'Analysis Settings' });

		// Extraction mode
		new Setting(containerEl)
			.setName('Extraction mode')
			.setDesc('Controls how thorough the entity extraction is. Higher modes extract more entities but cost more API tokens.')
			.addDropdown(dropdown => {
				dropdown
					.addOption('simple', 'Simple (max 15 entities, 20 relations)')
					.addOption('advanced', 'Advanced (max 30 entities, 50 relations)')
					.addOption('maximum', 'Maximum (no limits)')
					.setValue(this.plugin.settings.extractionMode || 'simple')
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

		// View Settings section
		containerEl.createEl('h3', { text: 'View Settings' });

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

		// Entity Resolution section
		containerEl.createEl('h3', { text: 'Entity Resolution (Advanced)' });

		const resolutionInfo = containerEl.createEl('div', { cls: 'setting-item-description' });
		resolutionInfo.style.marginBottom = '12px';
		resolutionInfo.innerHTML = `
			Entity resolution uses embeddings to detect semantically similar entities (e.g., "AI" and "Artificial Intelligence")
			and merge them automatically. This is optional and incurs additional API costs.
		`;

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
				.setDesc('Select the provider for embeddings. Note: Claude does not offer embeddings.')
				.addDropdown(dropdown => {
					dropdown
						.addOption('openai', 'OpenAI')
						.addOption('gemini', 'Gemini (Google)')
						.addOption('ollama', 'Ollama (Local)')
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
				.setName('Enable LLM verification')
				.setDesc('Use LLM to verify ambiguous matches. Adds extra API calls but improves accuracy.')
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
						.setButtonText('Clear Cache')
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
		containerEl.createEl('h3', { text: 'Vault Analysis' });

		const vaultWarning = containerEl.createEl('div', { cls: 'setting-item-description vault-analysis-warning' });
		vaultWarning.innerHTML = `
			<strong>Warning:</strong> Analyzing the entire vault will:
			<ul>
				<li>Make one API call per note (can be expensive for large vaults)</li>
				<li>Take a long time (approx. 10-15 seconds per note)</li>
				<li>May hit rate limits depending on your API plan</li>
			</ul>
			<em>Already analyzed notes will be skipped unless changed.</em>
		`;

		const vaultButtonContainer = containerEl.createDiv({ cls: 'vault-analysis-buttons' });

		new Setting(vaultButtonContainer)
			.setName('Analyze entire vault')
			.setDesc(`${this.plugin.app.vault.getMarkdownFiles().length} markdown files in vault`)
			.addButton(button => {
				const updateButtonState = () => {
					if (isAnalyzingVault()) {
						button.setButtonText('Cancel').setWarning();
					} else {
						button.setButtonText('Start Analysis').removeCta().setClass('mod-cta');
					}
				};

				updateButtonState();

				button.onClick(async () => {
					if (isAnalyzingVault()) {
						cancelVaultAnalysis();
						new Notice('Cancelling vault analysis...');
						// Button will update after analysis stops
						setTimeout(updateButtonState, 1000);
					} else {
						const fileCount = this.plugin.app.vault.getMarkdownFiles().length;
						const confirmed = confirm(
							`Analyze ${fileCount} notes in your vault?\n\n` +
							`Estimated time: ${Math.ceil(fileCount * 10 / 60)} - ${Math.ceil(fileCount * 15 / 60)} minutes\n` +
							`Estimated API calls: up to ${fileCount}\n\n` +
							`You can cancel at any time.`
						);

						if (confirmed) {
							updateButtonState();
							await analyzeEntireVault(this.plugin);
							updateButtonState();
							this.renderGraphStats(statsEl);
						}
					}
				});
			});

		// Data Management section
		containerEl.createEl('h3', { text: 'Data Management' });

		// Graph stats
		const statsEl = containerEl.createDiv({ cls: 'graph-stats' });
		this.renderGraphStats(statsEl);

		// Clear graph button
		new Setting(containerEl)
			.setName('Clear graph data')
			.setDesc('Remove all nodes, edges, and analysis history. This cannot be undone.')
			.addButton(button => {
				button
					.setButtonText('Clear All Data')
					.setWarning()
					.onClick(async () => {
						const confirmed = confirm(
							'Are you sure you want to clear all graph data?\n\n' +
							'This will remove:\n' +
							'- All extracted nodes and relationships\n' +
							'- All note connections\n' +
							'- Analysis history (notes will be re-analyzed)\n\n' +
							'This action cannot be undone.'
						);
						if (confirmed) {
							this.plugin.graphCache.clear();
							await this.plugin.graphCache.flush();
							await clearHashes(this.plugin);
							new Notice('Graph data cleared');
							this.renderGraphStats(statsEl);
						}
					});
			});

		// Support section
		containerEl.createEl('h3', { text: 'Support' });

		new Setting(containerEl)
			.setName('Buy me a coffee')
			.setDesc('If you find this plugin useful, consider supporting its development!')
			.addButton(button => {
				button
					.setButtonText('Buy Me a Coffee')
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
