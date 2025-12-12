import { ApiProvider, ExtractionResult, Settings } from '../types';
import { requestUrl } from 'obsidian';

export interface ExtractionError {
	type: 'api_error' | 'parse_error' | 'config_error' | 'rate_limit';
	message: string;
	details?: string;
}

export interface ExtractionOptions {
	provider: ApiProvider;
	apiKey: string;
	model: string;
	ollamaHost?: string;
}

export async function extractEntities(
	options: ExtractionOptions,
	prompt: string
): Promise<ExtractionResult> {
	const { provider, apiKey, model, ollamaHost } = options;

	// Ollama doesn't need an API key
	if (provider !== 'ollama' && !apiKey) {
		throw createError('config_error', 'API key not configured. Please set your API key in settings.');
	}

	if (!model) {
		throw createError('config_error', 'Model not configured. Please set a model name in settings.');
	}

	let response: string;

	try {
		switch (provider) {
			case 'claude':
				response = await callClaude(apiKey, model, prompt);
				break;
			case 'openai':
				response = await callOpenAI(apiKey, model, prompt);
				break;
			case 'gemini':
				response = await callGemini(apiKey, model, prompt);
				break;
			case 'ollama':
				response = await callOllama(ollamaHost || 'http://localhost:11434', model, prompt);
				break;
			default:
				throw createError('config_error', `Unknown provider: ${provider}`);
		}
	} catch (e) {
		if (e instanceof Error && 'type' in e) {
			throw e; // Already an ExtractionError
		}
		throw handleApiError(e, provider);
	}

	return parseResponse(response);
}

/**
 * Helper to create ExtractionOptions from Settings
 */
export function settingsToExtractionOptions(settings: Settings): ExtractionOptions {
	// Get the model for the current provider
	const modelMap: Record<ApiProvider, string> = {
		claude: settings.claudeModel,
		openai: settings.openaiModel,
		gemini: settings.geminiModel,
		ollama: settings.ollamaModel,
	};

	return {
		provider: settings.apiProvider,
		apiKey: settings.apiKey,
		model: modelMap[settings.apiProvider],
		ollamaHost: settings.ollamaHost,
	};
}

function createError(type: ExtractionError['type'], message: string, details?: string): Error {
	const error = new Error(message) as Error & ExtractionError;
	error.type = type;
	error.details = details;
	return error;
}

function handleApiError(e: unknown, provider: ApiProvider): Error {
	const err = e as { status?: number; message?: string };

	if (err.status === 401) {
		return createError('api_error', `Invalid ${provider} API key. Please check your settings.`);
	}
	if (err.status === 429) {
		return createError('rate_limit', `Rate limit exceeded for ${provider}. Please wait and try again.`);
	}
	if (err.status === 400) {
		return createError('api_error', `Bad request to ${provider} API.`, err.message);
	}
	if (err.status && err.status >= 500) {
		return createError('api_error', `${provider} API server error. Please try again later.`);
	}

	return createError('api_error', `Failed to call ${provider} API: ${err.message || 'Unknown error'}`);
}

async function callClaude(apiKey: string, model: string, prompt: string): Promise<string> {
	const res = await requestUrl({
		url: 'https://api.anthropic.com/v1/messages',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: model,
			max_tokens: 2048,
			messages: [{ role: 'user', content: prompt }],
		}),
	});

	const data = res.json;
	if (!data.content?.[0]?.text) {
		throw createError('api_error', 'Empty response from Claude API');
	}
	return data.content[0].text;
}

async function callOpenAI(apiKey: string, model: string, prompt: string): Promise<string> {
	const res = await requestUrl({
		url: 'https://api.openai.com/v1/chat/completions',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: model,
			messages: [{ role: 'user', content: prompt }],
			temperature: 0.3,
		}),
	});

	const data = res.json;
	if (!data.choices?.[0]?.message?.content) {
		throw createError('api_error', 'Empty response from OpenAI API');
	}
	return data.choices[0].message.content;
}

async function callGemini(apiKey: string, model: string, prompt: string): Promise<string> {
	const res = await requestUrl({
		url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: 0.3,
			},
		}),
	});

	const data = res.json;
	if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
		throw createError('api_error', 'Empty response from Gemini API');
	}
	return data.candidates[0].content.parts[0].text;
}

async function callOllama(host: string, model: string, prompt: string): Promise<string> {
	// Normalize host URL
	const baseUrl = host.replace(/\/+$/, '');

	const res = await requestUrl({
		url: `${baseUrl}/api/generate`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: model,
			prompt: prompt,
			stream: false,
			options: {
				temperature: 0.3,
			},
		}),
	});

	const data = res.json;
	if (!data.response) {
		throw createError('api_error', 'Empty response from Ollama API');
	}
	return data.response;
}

function parseResponse(response: string): ExtractionResult {
	// Extract JSON from response (handle markdown code blocks)
	let jsonStr = response.trim();

	// Handle various markdown code block formats
	const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		jsonStr = codeBlockMatch[1].trim();
	}

	// Try to find JSON object if response has extra text
	if (!jsonStr.startsWith('{')) {
		const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			jsonStr = jsonMatch[0];
		}
	}

	try {
		const parsed = JSON.parse(jsonStr);

		// Validate and normalize response
		const entities = Array.isArray(parsed.entities)
			? parsed.entities.filter((e: unknown) => typeof e === 'string' && e.trim())
			: [];

		const keywordMatches = Array.isArray(parsed.keywordMatches)
			? parsed.keywordMatches.filter((k: unknown) => typeof k === 'string' && k.trim())
			: [];

		const relationships = Array.isArray(parsed.relationships)
			? parsed.relationships.filter((r: unknown) =>
				r && typeof r === 'object' &&
				'source' in r && 'target' in r &&
				typeof (r as {source: unknown}).source === 'string' &&
				typeof (r as {target: unknown}).target === 'string'
			).map((r: {source: string; target: string; type?: string}) => ({
				source: r.source,
				target: r.target,
				type: 'relates_to' as const,
			}))
			: [];

		return { entities, keywordMatches, relationships };
	} catch (e) {
		console.error('Failed to parse LLM response:', response);
		throw createError('parse_error', 'Failed to parse extraction result from LLM', response.slice(0, 200));
	}
}
