(function attachMultiPageFlowsIndex(root, factory) {
  root.MultiPageFlowsIndex = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createFlowsIndexModule() {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;

  const FLOW_ENTRY_DEFINITIONS = Object.freeze({
    openai: {
      id: 'openai',
      path: 'flows/openai/',
    },
    kiro: {
      id: 'kiro',
      path: 'flows/kiro/',
    },
  });

  function normalizeFlowId(value = '') {
    return String(value || '').trim().toLowerCase();
  }

  function getRegisteredFlowIds() {
    return Object.keys(FLOW_ENTRY_DEFINITIONS);
  }

  function getFlowEntry(flowId) {
    const normalized = normalizeFlowId(flowId);
    const baseEntry = FLOW_ENTRY_DEFINITIONS[normalized];
    if (!baseEntry) {
      return null;
    }
    return {
      ...baseEntry,
      definition: normalized === 'openai'
        ? (rootScope.MultiPageOpenAiFlowDefinition || null)
        : (rootScope.MultiPageKiroFlowDefinition || null),
      workflow: normalized === 'openai'
        ? (rootScope.MultiPageOpenAiWorkflow || null)
        : (rootScope.MultiPageKiroWorkflow || null),
    };
  }

  function getFlowDefinition(flowId) {
    return getFlowEntry(flowId)?.definition || null;
  }

  function getFlowDefinitions() {
    const next = {};
    getRegisteredFlowIds().forEach((flowId) => {
      const definition = getFlowDefinition(flowId);
      if (definition) {
        next[flowId] = definition;
      }
    });
    return next;
  }

  function getFlowWorkflow(flowId) {
    return getFlowEntry(flowId)?.workflow || null;
  }

  return {
    getFlowEntry,
    getFlowDefinition,
    getFlowDefinitions,
    getFlowWorkflow,
    getRegisteredFlowIds,
  };
});
