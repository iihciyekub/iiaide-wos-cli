function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeBatchResult(result, options = {}) {
  if (!result || result.status !== "completed") {
    throw new Error(`wos.js export failed: ${result?.message || result?.status || "empty result"}`);
  }
  const batches = Array.isArray(result.batches) ? result.batches : [];
  return {
    status: result.status,
    uuid: result.uuid || options.uuid || "",
    totalRecords: normalizePositiveInteger(result.totalRecords, batches.length),
    totalBatches: normalizePositiveInteger(result.totalBatches, batches.length),
    completedBatches: normalizePositiveInteger(result.completedBatches, batches.length),
    batches: batches.map((batch) => ({
      uuid: batch.uuid || result.uuid || options.uuid || "",
      markFrom: normalizePositiveInteger(batch.markFrom, 1),
      markTo: normalizePositiveInteger(batch.markTo, normalizePositiveInteger(batch.markFrom, 1)),
      text: String(batch.text || ""),
    })),
  };
}

async function callWosJsExport(page, methodName, options = {}) {
  const callbackName = `__wosAideExportProgress_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (typeof options.onProgress === "function") {
    await page.exposeFunction(callbackName, (event) => options.onProgress(event || {}));
  }

  const result = await page.evaluate(
    async ({ methodName, callbackName, exportOptions }) => {
      const api = window.wos?.export;
      if (!api || typeof api[methodName] !== "function") {
        throw new Error(`wos.js export API missing: window.wos.export.${methodName}`);
      }
      const onProgress = typeof window[callbackName] === "function"
        ? (event) => window[callbackName](event)
        : null;
      return api[methodName]({
        ...exportOptions,
        onProgress,
      });
    },
    {
      methodName,
      callbackName,
      exportOptions: {
        uuid: options.uuid,
        markFrom: options.markFrom,
        markTo: options.markTo,
        batchSize: options.batchSize,
        sortBy: options.sortBy,
        filters: options.filters,
      },
    }
  );

  return normalizeBatchResult(result, options);
}

function exportTxtBatchesViaWosJs(page, options = {}) {
  return callWosJsExport(page, "fetchTxtBatches", options);
}

function exportBibBatchesViaWosJs(page, options = {}) {
  return callWosJsExport(page, "fetchBibBatches", options);
}

module.exports = {
  exportBibBatchesViaWosJs,
  exportTxtBatchesViaWosJs,
  normalizeBatchResult,
};
