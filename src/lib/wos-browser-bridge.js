function normalizeApiPath(apiPath) {
  const parts = String(apiPath || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Missing browser WOS API path");
  return parts;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

async function callWosBrowserApi(page, apiPath, args = []) {
  const pathParts = normalizeApiPath(apiPath);
  const callArgs = Array.isArray(args) ? args : [args];
  const result = await page.evaluate(
    async ({ pathParts: browserPathParts, callArgs: browserCallArgs }) => {
      const root = window.wos;
      if (!root) {
        throw new Error("wos.js browser API missing: window.wos");
      }
      let target = root;
      for (const part of browserPathParts.slice(0, -1)) {
        target = target?.[part];
        if (!target) {
          throw new Error(`wos.js browser API missing: window.wos.${browserPathParts.join(".")}`);
        }
      }
      const methodName = browserPathParts[browserPathParts.length - 1];
      const method = target?.[methodName];
      if (typeof method !== "function") {
        throw new Error(`wos.js browser API missing: window.wos.${browserPathParts.join(".")}`);
      }
      return method.apply(target, browserCallArgs);
    },
    { pathParts, callArgs }
  );
  return jsonSafe(result);
}

module.exports = {
  callWosBrowserApi,
  jsonSafe,
  normalizeApiPath,
};
