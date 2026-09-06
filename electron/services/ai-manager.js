const fetchFn = (...args) => {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(...args);
  }
  return import('node-fetch').then(({ default: fetch }) => fetch(...args));
};
const fetch = fetchFn;

class AIProvider {
  constructor(config, logManager) {
    this.config = config;
    this.logManager = logManager;
    this.name = config.name || 'unknown';
    this.type = config.type || 'custom';
  }

  async listModels() {
    throw new Error('Not implemented');
  }

  async chat(messages, options = {}) {
    throw new Error('Not implemented');
  }

  async streamChat(messages, options = {}) {
    throw new Error('Not implemented');
  }

  async testConnection() {
    throw new Error('Not implemented');
  }

  getConfig() {
    return { ...this.config };
  }
}

class OllamaProvider extends AIProvider {
  constructor(config, logManager) {
    super({ ...config, type: 'ollama' }, logManager);
    this.endpoint = config.endpoint || 'http://localhost:11434';
  }

  async listModels() {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, { timeout: 5000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data.models?.map(m => ({
        name: m.name,
        size: m.size,
        digest: m.digest,
        modified: m.modified_at
      })) || [];
    } catch (error) {
      this.logManager.error('Ollama list models failed', 'ai', error.message);
      throw error;
    }
  }

  async chat(messages, options = {}) {
    const model = options.model || this.config.model;
    if (!model) throw new Error('No model selected');

    try {
      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: options.temperature ?? 0.7,
            top_p: options.top_p ?? 0.9,
            num_predict: options.maxTokens ?? 2048
          }
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data.message?.content || '';
    } catch (error) {
      this.logManager.error('Ollama chat failed', 'ai', error.message);
      throw error;
    }
  }

  async streamChat(messages, options = {}) {
    const model = options.model || this.config.model;
    if (!model) throw new Error('No model selected');

    try {
      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          options: {
            temperature: options.temperature ?? 0.7,
            top_p: options.top_p ?? 0.9,
            num_predict: options.maxTokens ?? 2048
          }
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.trim()) {
                try {
                  const data = JSON.parse(line);
                  if (data.message?.content) {
                    yield data.message.content;
                  }
                  if (data.done) return;
                } catch {
                }
              }
            }
          }
        }
      };
    } catch (error) {
      this.logManager.error('Ollama stream chat failed', 'ai', error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, { timeout: 3000 });
      return { success: response.ok, message: response.ok ? 'Connected' : 'Failed' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  async pullModel(modelName) {
    try {
      const response = await fetch(`${this.endpoint}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: false })
      });
      return response.ok;
    } catch (error) {
      this.logManager.error('Ollama pull model failed', 'ai', error.message);
      throw error;
    }
  }

  async deleteModel(modelName) {
    try {
      const response = await fetch(`${this.endpoint}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });
      return response.ok;
    } catch (error) {
      this.logManager.error('Ollama delete model failed', 'ai', error.message);
      throw error;
    }
  }
}

class OpenAICompatibleProvider extends AIProvider {
  constructor(config, logManager) {
    super({ ...config, type: 'openai-compatible' }, logManager);
    this.endpoint = config.endpoint || 'https://api.openai.com/v1';
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
  }

  async listModels() {
    try {
      const response = await fetch(`${this.endpoint}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 5000
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data.data?.map(m => ({
        name: m.id,
        ownedBy: m.owned_by
      })) || [];
    } catch (error) {
      this.logManager.error('OpenAI-compatible list models failed', 'ai', error.message);
      throw error;
    }
  }

  async chat(messages, options = {}) {
    const model = options.model || this.model;
    if (!model) throw new Error('No model selected');

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          top_p: options.top_p ?? 0.9,
          max_tokens: options.maxTokens ?? 2048,
          stream: false
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`${response.status}: ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
      this.logManager.error('OpenAI-compatible chat failed', 'ai', error.message);
      throw error;
    }
  }

  async streamChat(messages, options = {}) {
    const model = options.model || this.model;
    if (!model) throw new Error('No model selected');

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          top_p: options.top_p ?? 0.9,
          max_tokens: options.maxTokens ?? 2048,
          stream: true
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') return;
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) yield content;
                } catch {
                }
              }
            }
          }
        }
      };
    } catch (error) {
      this.logManager.error('OpenAI-compatible stream chat failed', 'ai', error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      const response = await fetch(`${this.endpoint}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 5000
      });
      return { success: response.ok, message: response.ok ? 'Connected' : `HTTP ${response.status}` };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}

class AIManager {
  constructor(settingsManager, logManager) {
    this.settingsManager = settingsManager;
    this.logManager = logManager;
    this.providers = new Map();
    this.activeProvider = null;
    this.conversations = new Map();
  }

  async initialize() {
    const aiSettings = this.settingsManager.get('ai') || {};
    const providers = aiSettings.providers || {};

    for (const [id, config] of Object.entries(providers)) {
      await this.addProvider(id, config);
    }

    const activeId = aiSettings.activeProvider || 'ollama';
    if (this.providers.has(activeId)) {
      this.activeProvider = this.providers.get(activeId);
    } else if (this.providers.size > 0) {
      this.activeProvider = this.providers.values().next().value;
    }

    if (!this.providers.has('ollama')) {
      await this.addProvider('ollama', {
        name: 'Ollama',
        type: 'ollama',
        endpoint: aiSettings.ollama?.endpoint || 'http://localhost:11434',
        model: aiSettings.ollama?.model || ''
      });
    }

    this.logManager.info('AI Manager initialized', 'ai', { activeProvider: this.activeProvider?.name, providerCount: this.providers.size });
  }

  async addProvider(id, config) {
    let provider;
    switch (config.type) {
      case 'ollama':
        provider = new OllamaProvider(config, this.logManager);
        break;
      case 'openai-compatible':
        provider = new OpenAICompatibleProvider(config, this.logManager);
        break;
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }

    this.providers.set(id, provider);

    const aiSettings = this.settingsManager.get('ai') || {};
    aiSettings.providers = aiSettings.providers || {};
    aiSettings.providers[id] = config;
    this.settingsManager.set('ai', aiSettings);

    this.logManager.info('AI provider added', 'ai', { id, name: config.name });
    return provider;
  }

  async removeProvider(id) {
    if (id === 'ollama') {
      throw new Error('Cannot remove default Ollama provider');
    }
    this.providers.delete(id);
    const aiSettings = this.settingsManager.get('ai') || {};
    delete aiSettings.providers[id];
    if (aiSettings.activeProvider === id) {
      aiSettings.activeProvider = 'ollama';
      this.activeProvider = this.providers.get('ollama');
    }
    this.settingsManager.set('ai', aiSettings);
    this.logManager.info('AI provider removed', 'ai', { id });
  }

  async updateProvider(id, config) {
    await this.removeProvider(id);
    return this.addProvider(id, config);
  }

  async setActiveProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error('Provider not found');
    this.activeProvider = provider;

    const aiSettings = this.settingsManager.get('ai') || {};
    aiSettings.activeProvider = id;
    this.settingsManager.set('ai', aiSettings);

    this.logManager.info('Active AI provider changed', 'ai', { id });
  }

  getActiveProvider() {
    return this.activeProvider;
  }

  getProviders() {
    return Array.from(this.providers.entries()).map(([id, provider]) => ({
      id,
      ...provider.getConfig(),
      active: provider === this.activeProvider
    }));
  }

  async listModels() {
    if (!this.activeProvider) throw new Error('No active provider');
    return this.activeProvider.listModels();
  }

  async chat(messages, options = {}) {
    if (!this.activeProvider) throw new Error('No active provider');
    return this.activeProvider.chat(messages, options);
  }

  async streamChat(messages, options = {}) {
    if (!this.activeProvider) throw new Error('No active provider');
    return this.activeProvider.streamChat(messages, options);
  }

  async testProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error('Provider not found');
    return provider.testConnection();
  }

  async checkOllama() {
    const ollama = this.providers.get('ollama');
    if (!ollama) return { connected: false };
    return ollama.testConnection();
  }

  getConversation(id = 'default') {
    return this.conversations.get(id) || [];
  }

  setConversation(id, messages) {
    this.conversations.set(id, messages);
  }

  clearConversation(id = 'default') {
    this.conversations.delete(id);
  }

  async shutdown() {
    this.providers.clear();
    this.conversations.clear();
  }
}

module.exports = { AIManager, AIProvider, OllamaProvider, OpenAICompatibleProvider };