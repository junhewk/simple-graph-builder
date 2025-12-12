import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { ApiProvider } from '../types';
import { MODEL_OPTIONS } from '../settings';
import { clearHashes } from '../graph/hashes';
import { analyzeEntireVault, isAnalyzingVault, cancelVaultAnalysis } from '../commands/analyze';

export class SettingsTab extends PluginSettingTab {
	plugin: SimpleGraphBuilderPlugin;
	private claudeSettingsEl: HTMLElement | null = null;
	private openaiSettingsEl: HTMLElement | null = null;
	private geminiSettingsEl: HTMLElement | null = null;
	private ollamaSettingsEl: HTMLElement | null = null;

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
		this.claudeSettingsEl = containerEl.createDiv();
		new Setting(this.claudeSettingsEl)
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
		new Setting(this.claudeSettingsEl)
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
		this.openaiSettingsEl = containerEl.createDiv();
		new Setting(this.openaiSettingsEl)
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
		new Setting(this.openaiSettingsEl)
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
		this.geminiSettingsEl = containerEl.createDiv();
		new Setting(this.geminiSettingsEl)
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
		new Setting(this.geminiSettingsEl)
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
		this.ollamaSettingsEl = containerEl.createDiv();
		new Setting(this.ollamaSettingsEl)
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
		new Setting(this.ollamaSettingsEl)
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

		// Update visibility based on current provider
		this.updateProviderSettings();

		// Keywords section
		containerEl.createEl('h3', { text: 'Keywords (Ontology Terms)' });
		containerEl.createEl('p', {
			text: 'Define keywords for your research domain. The LLM will identify which keywords are relevant to each note.',
			cls: 'setting-item-description',
		});

		// Display existing keywords
		const keywordsList = containerEl.createDiv({ cls: 'keywords-list' });
		this.renderKeywords(keywordsList);

		// Add new keyword
		new Setting(containerEl)
			.setName('Add keyword')
			.addText(text => {
				text.setPlaceholder('e.g., machine learning, clinical research');
				text.inputEl.addEventListener('keypress', async (e) => {
					if (e.key === 'Enter') {
						const value = text.getValue().trim();
						if (value && !this.plugin.settings.keywords.includes(value)) {
							this.plugin.settings.keywords.push(value);
							await this.plugin.saveSettings();
							text.setValue('');
							this.renderKeywords(keywordsList);
						}
					}
				});
			})
			.addButton(button => {
				button.setButtonText('Add').onClick(async () => {
					const input = containerEl.querySelector('.keywords-list + .setting-item input') as HTMLInputElement;
					const value = input?.value.trim();
					if (value && !this.plugin.settings.keywords.includes(value)) {
						this.plugin.settings.keywords.push(value);
						await this.plugin.saveSettings();
						input.value = '';
						this.renderKeywords(keywordsList);
					}
				});
			});

		// Analysis Settings section
		containerEl.createEl('h3', { text: 'Analysis Settings' });

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

		// Vault analysis section
		containerEl.createEl('h3', { text: 'Vault Analysis' });

		const vaultWarning = containerEl.createEl('div', { cls: 'setting-item-description vault-analysis-warning' });
		vaultWarning.innerHTML = `
			<strong>Warning:</strong> Analyzing the entire vault will:
			<ul>
				<li>Make one API call per note (can be expensive for large vaults)</li>
				<li>Take a long time (approx. 1-2 seconds per note)</li>
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
							`Estimated time: ${Math.ceil(fileCount * 1.5 / 60)} - ${Math.ceil(fileCount * 2 / 60)} minutes\n` +
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
							'- All extracted entities and keywords\n' +
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
			statsText.setText(
				`Graph contains: ${stats.notes} notes, ${stats.entities} entities, ${stats.keywords} keywords, ${stats.edges} connections`
			);
		}
	}

	private renderKeywords(container: HTMLElement) {
		container.empty();
		if (this.plugin.settings.keywords.length === 0) {
			container.createEl('p', { text: 'No keywords defined yet.', cls: 'keywords-empty' });
			return;
		}

		const list = container.createEl('ul', { cls: 'keywords-ul' });
		for (const keyword of this.plugin.settings.keywords) {
			const item = list.createEl('li', { cls: 'keyword-item' });
			item.createEl('span', { text: keyword });
			const removeBtn = item.createEl('button', { text: '×', cls: 'keyword-remove' });
			removeBtn.addEventListener('click', async () => {
				this.plugin.settings.keywords = this.plugin.settings.keywords.filter(k => k !== keyword);
				await this.plugin.saveSettings();
				this.renderKeywords(container);
			});
		}
	}

	private updateProviderSettings() {
		const provider = this.plugin.settings.apiProvider;

		if (this.claudeSettingsEl) {
			this.claudeSettingsEl.style.display = provider === 'claude' ? 'block' : 'none';
		}
		if (this.openaiSettingsEl) {
			this.openaiSettingsEl.style.display = provider === 'openai' ? 'block' : 'none';
		}
		if (this.geminiSettingsEl) {
			this.geminiSettingsEl.style.display = provider === 'gemini' ? 'block' : 'none';
		}
		if (this.ollamaSettingsEl) {
			this.ollamaSettingsEl.style.display = provider === 'ollama' ? 'block' : 'none';
		}
	}
}
