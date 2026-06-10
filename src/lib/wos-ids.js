function compactWosId(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function normalizeWosId(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const fullRecordMatch = text.match(/\/full-record\/([^/?#\s]+)/i);
  if (fullRecordMatch) {
    try {
      return normalizeWosId(decodeURIComponent(fullRecordMatch[1]));
    } catch (_) {
      return normalizeWosId(fullRecordMatch[1]);
    }
  }

  const pattern = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  let match = null;
  while ((match = pattern.exec(` ${text}`))) {
    const prefix = String(match[1] || "").toUpperCase();
    if (prefix === "HTTP" || prefix === "HTTPS") continue;
    const suffix = compactWosId(match[2]);
    if (suffix) return `${prefix}:${suffix}`;
  }
  return "";
}

function wosIdsEquivalent(left, right) {
  const leftCompact = compactWosId(left);
  const rightCompact = compactWosId(right);
  return Boolean(leftCompact && rightCompact && leftCompact === rightCompact);
}

function reconcileWosId(expected, actual) {
  const normalizedExpected = normalizeWosId(expected);
  const normalizedActual = normalizeWosId(actual);
  if (normalizedActual && (!normalizedExpected || wosIdsEquivalent(normalizedActual, normalizedExpected))) {
    return normalizedActual;
  }
  if (normalizedExpected && (!actual || wosIdsEquivalent(normalizedExpected, actual))) {
    return normalizedExpected;
  }
  return normalizedActual || normalizedExpected || "";
}

module.exports = {
  compactWosId,
  normalizeWosId,
  reconcileWosId,
  wosIdsEquivalent,
};
