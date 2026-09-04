/**
 * Client-side model filtering and sorting.
 * The full catalog is a few dozen entries, so filtering in the webview is
 * instant and keeps the extension host out of every keystroke.
 */
const Filters = (function () {
  const EMPTY = {
    search: '',
    vision: false,
    tools: false,
    thinking: false,
    liveOnly: false,
    brand: '',
    sortBy: 'default',
  };

  let current = { ...EMPTY };

  function apply(models) {
    let result = [...models];

    if (current.search) {
      const terms = current.search.toLowerCase().trim().split(/\s+/);
      result = result.filter((m) => {
        const haystack = `${m.name} ${m.id} ${m.brandLabel} ${m.productFamily} ${m.tier} ${m.summary}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    if (current.vision) {
      result = result.filter((m) => m.capabilities.vision);
    }
    if (current.tools) {
      result = result.filter((m) => m.capabilities.toolCalling);
    }
    if (current.thinking) {
      result = result.filter((m) => m.capabilities.reasoning);
    }
    if (current.liveOnly) {
      result = result.filter((m) => m.live);
    }
    if (current.brand) {
      result = result.filter((m) => m.productFamily === current.brand);
    }

    // `default` keeps the extension host's ordering: live models first, then
    // brand, then tier — which is the order a person actually shops in.
    switch (current.sortBy) {
      case 'price-asc':
        result.sort((a, b) => inputRate(a) - inputRate(b));
        break;
      case 'price-desc':
        result.sort((a, b) => inputRate(b) - inputRate(a));
        break;
      case 'context-desc':
        result.sort((a, b) => b.contextLength - a.contextLength);
        break;
      case 'name-asc':
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    return result;
  }

  /** Unpriced generation models sort last, not first, on a price sort. */
  function inputRate(model) {
    return model.pricing ? model.pricing.input : Number.MAX_SAFE_INTEGER;
  }

  function set(key, value) {
    current[key] = value;
    return { ...current };
  }

  function toggle(key) {
    current[key] = !current[key];
    return { ...current };
  }

  function get() {
    return { ...current };
  }

  function reset() {
    current = { ...EMPTY };
    return { ...current };
  }

  return { apply, set, toggle, get, reset };
})();
