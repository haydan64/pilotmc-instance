const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function resolveModuleEntry(fullPath) {
  const stats = fs.statSync(fullPath);
  if (stats.isFile() && path.extname(fullPath) === '.js') return fullPath;
  if (!stats.isDirectory()) return null;

  const indexPath = path.join(fullPath, 'index.js');
  return fs.existsSync(indexPath) ? indexPath : null;
}

async function loadModules(context = {}, modulesPath = path.join(__dirname, 'modules')) {
  if (!fs.existsSync(modulesPath)) return [];

  const loadedModules = [];
  for (const entry of fs.readdirSync(modulesPath)) {
      const fullPath = path.join(modulesPath, entry);
      const entryPath = resolveModuleEntry(fullPath);
      if (!entryPath) continue;

      const imported = await import(pathToFileURL(entryPath).href);
      const initializer = imported.default || imported;
      const loaded = typeof initializer === 'function' ? await initializer(context) : initializer;
      loadedModules.push({
        name: loaded?.name || entry,
        path: fullPath,
        entryPath,
        ...(loaded || {})
      });
  }
  return loadedModules;
}

module.exports = {
  loadModules
};
