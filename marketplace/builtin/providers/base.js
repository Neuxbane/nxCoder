export class BaseProvider {
  constructor(config) {
    this.config = config || {};
  }

  static get id() {
    throw new Error("Provider must implement static getter 'id'");
  }

  static get name() {
    throw new Error("Provider must implement static getter 'name'");
  }

  static get configSchema() {
    return {
      title: this.name,
      fields: []
    };
  }

  /**
   * Execute chat completion stream.
   * @param {Object} params
   * @param {Array} params.messages
   * @param {string} params.systemInstruction
   * @param {Array} params.tools
   * @param {AbortSignal} params.signal
   * @param {Object} callbacks
   */
  async executeStream(params, callbacks) {
    throw new Error("Provider must implement 'executeStream'");
  }
}
