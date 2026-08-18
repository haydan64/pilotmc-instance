const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(process.cwd(), process.argv[2] || '.');
const ignoredDirectories = new Set(['.git', 'node_modules']);

function findJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findJavaScriptFiles(fullPath));
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

const files = findJavaScriptFiles(root);
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, output: result.stderr || result.stdout });
}

for (const failure of failures) {
  console.error(`Syntax check failed: ${path.relative(root, failure.file)}`);
  console.error(failure.output.trim());
}

if (failures.length) process.exitCode = 1;
else console.log(`Checked ${files.length} JavaScript files, including installed modules.`);
