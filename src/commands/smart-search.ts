/**
 * Smart Search command - LLM-powered natural language search over the knowledge graph.
 * Uses tool calls to let the LLM explore the graph interactively.
 */

import { requestUrl } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { buildSmartSearchSystemPrompt, getSmartSearchTools } from '../extraction/prompts';
import { executeToolCall, ToolCall } from '../graph/tools';
import { settingsToExtractionOptions } from '../extraction/llm-client';

// ============================================
// Types
// ============================================

interface SmartSearchResult {
	answer: string;
	relevantNodes: Array<{ name: string; label: string; relevance: string }>;
	sourceNotes: Array<{ path: string; title: string; relevance: string }>;
}

interface Message {
	role: 'user' | 'assistant' | 'system';
	content: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

// ============================================
// Smart Search Implementation
// ============================================

/**
 * Execute a smart search query using LLM with tool calls.
 */
export async function executeSmartSearch(
	plugin: SimpleGraphBuilderPlugin,
	query: string,
	onProgress?: (status: string) => void
): Promise<SmartSearchResult> {
	const options = settingsToExtractionOptions(plugin.settings);

	// Check API configuration
	if (options.provider !== 'ollama' && !options.apiKey) {
		throw new Error('API key not configured. Please set your API key in settings.');
	}

	const systemPrompt = buildSmartSearchSystemPrompt();
	const tools = getSmartSearchTools();

	// Build initial messages
	const messages: Message[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: query },
	];

	onProgress?.('Analyzing question...');

	// Tool use loop (max 10 iterations to prevent infinite loops)
	const maxIterations = 10;
	let iteration = 0;

	while (iteration < maxIterations) {
		iteration++;

		// Call LLM
		const response = await callLLMWithTools(options, messages, tools);

		// Check if LLM wants to use tools
		if (response.tool_calls && response.tool_calls.length > 0) {
			// Add assistant message with tool calls
			messages.push({
				role: 'assistant',
				content: response.content || '',
				tool_calls: response.tool_calls,
			});

			// Execute each tool call
			for (const toolCall of response.tool_calls) {
				onProgress?.(`Querying graph: ${toolCall.function.name}...`);

				try {
					const args = JSON.parse(toolCall.function.arguments);
					const result = executeToolCall(plugin.graphCache, {
						name: toolCall.function.name as ToolCall['name'],
						arguments: args,
					});

					// Add tool result message
					messages.push({
						role: 'user', // Tool results are sent as user messages with tool_call_id
						content: JSON.stringify(result.result),
						tool_call_id: toolCall.id,
					});
				} catch (e) {
					// Add error result
					messages.push({
						role: 'user',
						content: JSON.stringify({ error: `Failed to execute ${toolCall.function.name}: ${e}` }),
						tool_call_id: toolCall.id,
					});
				}
			}
		} else {
			// No tool calls - LLM is done, parse final answer
			onProgress?.('Generating answer...');

			try {
				return parseSmartSearchResponse(response.content || '');
			} catch (e) {
				// If parsing fails, return the raw response
				return {
					answer: response.content || 'No answer generated.',
					relevantNodes: [],
					sourceNotes: [],
				};
			}
		}
	}

	// Max iterations reached
	return {
		answer: 'Search took too long. Please try a more specific query.',
		relevantNodes: [],
		sourceNotes: [],
	};
}

// ============================================
// LLM API Calls with Tools
// ============================================

interface LLMResponse {
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
}

async function callLLMWithTools(
	options: ReturnType<typeof settingsToExtractionOptions>,
	messages: Message[],
	tools: ReturnType<typeof getSmartSearchTools>
): Promise<LLMResponse> {
	const { provider, apiKey, model, ollamaHost } = options;

	switch (provider) {
		case 'claude':
			return callClaudeWithTools(apiKey, model, messages, tools);
		case 'openai':
			return callOpenAIWithTools(apiKey, model, messages, tools);
		case 'gemini':
			return callGeminiWithTools(apiKey, model, messages, tools);
		case 'ollama':
			// Ollama tool use support varies by model
			return callOllamaWithTools(ollamaHost || 'http://localhost:11434', model, messages, tools);
		default:
			throw new Error(`Unknown provider: ${provider}`);
	}
}

async function callClaudeWithTools(
	apiKey: string,
	model: string,
	messages: Message[],
	tools: ReturnType<typeof getSmartSearchTools>
): Promise<LLMResponse> {
	// Convert messages to Claude format
	const systemMessage = messages.find(m => m.role === 'system');
	const nonSystemMessages = messages.filter(m => m.role !== 'system');

	// Convert tool definitions to Claude format
	const claudeTools = tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));

	// Convert messages, handling tool results
	const claudeMessages = nonSystemMessages.map(m => {
		if (m.tool_call_id) {
			return {
				role: 'user' as const,
				content: [{
					type: 'tool_result' as const,
					tool_use_id: m.tool_call_id,
					content: m.content,
				}],
			};
		}
		if (m.tool_calls) {
			return {
				role: 'assistant' as const,
				content: m.tool_calls.map(tc => ({
					type: 'tool_use' as const,
					id: tc.id,
					name: tc.function.name,
					input: JSON.parse(tc.function.arguments),
				})),
			};
		}
		return {
			role: m.role as 'user' | 'assistant',
			content: m.content,
		};
	});

	const res = await requestUrl({
		url: 'https://api.anthropic.com/v1/messages',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model,
			max_tokens: 4096,
			system: systemMessage?.content || '',
			messages: claudeMessages,
			tools: claudeTools,
		}),
	});

	const data = res.json;

	// Parse Claude response
	const content = data.content || [];
	const textContent = content.find((c: { type: string }) => c.type === 'text')?.text || null;
	const toolUseContent = content.filter((c: { type: string }) => c.type === 'tool_use');

	if (toolUseContent.length > 0) {
		return {
			content: textContent,
			tool_calls: toolUseContent.map((tc: { id: string; name: string; input: unknown }) => ({
				id: tc.id,
				type: 'function' as const,
				function: {
					name: tc.name,
					arguments: JSON.stringify(tc.input),
				},
			})),
		};
	}

	return { content: textContent };
}

async function callOpenAIWithTools(
	apiKey: string,
	model: string,
	messages: Message[],
	tools: ReturnType<typeof getSmartSearchTools>
): Promise<LLMResponse> {
	// Convert tool definitions to OpenAI format
	const openaiTools = tools.map(tool => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));

	// Convert messages to OpenAI format
	const openaiMessages = messages.map(m => {
		if (m.tool_call_id) {
			return {
				role: 'tool' as const,
				content: m.content,
				tool_call_id: m.tool_call_id,
			};
		}
		if (m.tool_calls) {
			return {
				role: 'assistant' as const,
				content: m.content || null,
				tool_calls: m.tool_calls,
			};
		}
		return {
			role: m.role,
			content: m.content,
		};
	});

	const res = await requestUrl({
		url: 'https://api.openai.com/v1/chat/completions',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: openaiMessages,
			tools: openaiTools,
			temperature: 0.3,
		}),
	});

	const data = res.json;
	const choice = data.choices?.[0]?.message;

	if (!choice) {
		throw new Error('Empty response from OpenAI API');
	}

	return {
		content: choice.content,
		tool_calls: choice.tool_calls,
	};
}

async function callGeminiWithTools(
	apiKey: string,
	model: string,
	messages: Message[],
	tools: ReturnType<typeof getSmartSearchTools>
): Promise<LLMResponse> {
	// Convert messages to Gemini format
	const systemMessage = messages.find(m => m.role === 'system');
	const nonSystemMessages = messages.filter(m => m.role !== 'system');

	// Build Gemini contents array - need to properly sequence messages
	const contents: Array<{
		role: 'user' | 'model';
		parts: Array<{ text?: string; functionCall?: { name: string; args: unknown }; functionResponse?: { name: string; response: unknown } }>;
	}> = [];

	for (let i = 0; i < nonSystemMessages.length; i++) {
		const msg = nonSystemMessages[i];

		if (msg.role === 'user' && !msg.tool_call_id) {
			// Regular user message
			contents.push({
				role: 'user',
				parts: [{ text: msg.content }],
			});
		} else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
			// Assistant message with tool calls - add as model with functionCall
			contents.push({
				role: 'model',
				parts: msg.tool_calls.map(tc => ({
					functionCall: {
						name: tc.function.name,
						args: JSON.parse(tc.function.arguments),
					},
				})),
			});
		} else if (msg.tool_call_id) {
			// Tool result - find the matching tool call name
			const prevMsg = nonSystemMessages.find(m => m.tool_calls?.some(tc => tc.id === msg.tool_call_id));
			const toolCall = prevMsg?.tool_calls?.find(tc => tc.id === msg.tool_call_id);
			if (toolCall) {
				// Parse the content safely
				let responseContent: unknown;
				try {
					responseContent = JSON.parse(msg.content);
				} catch {
					responseContent = { result: msg.content };
				}

				// Gemini requires functionResponse with name and response.content structure
				contents.push({
					role: 'user',
					parts: [{
						functionResponse: {
							name: toolCall.function.name,
							response: {
								name: toolCall.function.name,
								content: responseContent,
							},
						},
					}],
				});
			}
		} else if (msg.role === 'assistant' && msg.content) {
			// Regular assistant message
			contents.push({
				role: 'model',
				parts: [{ text: msg.content }],
			});
		}
	}

	// Convert tool definitions to Gemini format
	const geminiTools = [{
		functionDeclarations: tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	}];

	// Build request body
	const requestBody: Record<string, unknown> = {
		contents,
		tools: geminiTools,
		generationConfig: {
			temperature: 0.3,
			maxOutputTokens: 4096,
		},
	};

	// Only add systemInstruction if present (some models may not support it)
	if (systemMessage) {
		requestBody.systemInstruction = { parts: [{ text: systemMessage.content }] };
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let data: any;
	try {
		const res = await requestUrl({
			url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(requestBody),
		});
		data = res.json;
	} catch (e) {
		// Log request body for debugging
		console.error('Gemini request failed. Request body:', JSON.stringify(requestBody, null, 2));
		throw e;
	}

	// Check for API errors
	if (data.error) {
		console.error('Gemini API error:', data.error);
		throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
	}

	const candidate = data.candidates?.[0];

	if (!candidate?.content?.parts) {
		// Check for blocked content or other issues
		if (candidate?.finishReason === 'SAFETY') {
			throw new Error('Response blocked by safety filters');
		}
		throw new Error('Empty response from Gemini API');
	}

	// Parse Gemini response - check for function calls
	const parts = candidate.content.parts;
	const textPart = parts.find((p: { text?: string }) => p.text);
	const functionCallParts = parts.filter((p: { functionCall?: unknown }) => p.functionCall);

	if (functionCallParts.length > 0) {
		return {
			content: textPart?.text || null,
			tool_calls: functionCallParts.map((p: { functionCall: { name: string; args: unknown } }, index: number) => ({
				id: `gemini_tool_${Date.now()}_${index}`,
				type: 'function' as const,
				function: {
					name: p.functionCall.name,
					arguments: JSON.stringify(p.functionCall.args || {}),
				},
			})),
		};
	}

	return { content: textPart?.text || '' };
}

async function callOllamaWithTools(
	host: string,
	model: string,
	messages: Message[],
	tools: ReturnType<typeof getSmartSearchTools>
): Promise<LLMResponse> {
	const baseUrl = host.replace(/\/+$/, '');

	// Try using Ollama's chat API with tools
	const ollamaMessages = messages.map(m => ({
		role: m.role,
		content: m.content,
	}));

	// Ollama tool format
	const ollamaTools = tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));

	try {
		const res = await requestUrl({
			url: `${baseUrl}/api/chat`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model,
				messages: ollamaMessages,
				tools: ollamaTools,
				stream: false,
				options: {
					temperature: 0.3,
				},
			}),
		});

		const data = res.json;

		if (data.message?.tool_calls) {
			return {
				content: data.message.content || null,
				tool_calls: data.message.tool_calls.map((tc: { function: { name: string; arguments: unknown } }, index: number) => ({
					id: `tool_${index}`,
					type: 'function' as const,
					function: {
						name: tc.function.name,
						arguments: typeof tc.function.arguments === 'string'
							? tc.function.arguments
							: JSON.stringify(tc.function.arguments),
					},
				})),
			};
		}

		return { content: data.message?.content || '' };
	} catch (e) {
		// Fall back to simple generate if chat doesn't work
		const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');

		const res = await requestUrl({
			url: `${baseUrl}/api/generate`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model,
				prompt,
				stream: false,
				options: {
					temperature: 0.3,
				},
			}),
		});

		return { content: res.json.response || '' };
	}
}

// ============================================
// Response Parsing
// ============================================

function parseSmartSearchResponse(response: string): SmartSearchResult {
	// Try to extract JSON from response
	let jsonStr = response.trim();

	// Handle markdown code blocks
	const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		jsonStr = codeBlockMatch[1].trim();
	}

	// Try to find JSON object
	if (!jsonStr.startsWith('{')) {
		const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			jsonStr = jsonMatch[0];
		}
	}

	try {
		const parsed = JSON.parse(jsonStr);

		return {
			answer: parsed.answer || response,
			relevantNodes: Array.isArray(parsed.relevantNodes) ? parsed.relevantNodes : [],
			sourceNotes: Array.isArray(parsed.sourceNotes) ? parsed.sourceNotes : [],
		};
	} catch (e) {
		// If JSON parsing fails, return the raw text as the answer
		return {
			answer: response,
			relevantNodes: [],
			sourceNotes: [],
		};
	}
}

// ============================================
// Command Entry Point
// ============================================

/**
 * Open the smart search modal (will be implemented in smart-search-modal.ts).
 * This is a simple wrapper for now.
 */
export async function openSmartSearch(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	// Import dynamically to avoid circular dependencies
	const { SmartSearchModal } = await import('../ui/smart-search-modal');
	new SmartSearchModal(plugin.app, plugin).open();
}
