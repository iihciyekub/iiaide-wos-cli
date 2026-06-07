const fs = require("fs");
const path = require("path");

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON file: ${filePath}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function writeFileAtomic(filePath, content, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: options.mode });
    if (options.backup && fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
    fs.renameSync(temporaryPath, filePath);
    if (options.mode) fs.chmodSync(filePath, options.mode);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function writeJson(filePath, value, options = {}) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n", options);
}

module.exports = {
  readJson,
  writeFileAtomic,
  writeJson,
};
