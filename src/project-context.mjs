import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function loadProjectContext(cwd = process.cwd()) {
  const root = await realpath(cwd);
  const entries = (await readdir(root)).filter(name => !['.git', 'node_modules', '.state', '.work'].includes(name)).sort();
  const notes = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const text = await readFile(path.join(root, name), 'utf8');
      notes.push(name + ':\n' + text);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const instructions = notes.join('\n\n');
  if (instructions.length > 16000) throw new Error('Project instructions exceed 16,000 characters. Supply a smaller working directory or shorten them; nothing was truncated.');
  return [
    'CURRENT PROJECT ROOT: ' + root,
    'Root entries: ' + JSON.stringify(entries.slice(0, 80)) + (entries.length > 80 ? ' (first 80 entries only)' : ''),
    'Use paths relative to this root or absolute paths inside it. Do not invent project paths. Read output may prefix lines with numbers; those display annotations are not file contents and must not appear in Edit.old_string.',
    instructions ? 'PROJECT INSTRUCTIONS (already read from this root):\n' + instructions : 'No root AGENTS.md or CLAUDE.md was found. Check for applicable nested instructions before editing.',
    'Read any additional relevant nested instructions when working in subdirectories.',
    'Use short unique exact matches for Edit. If an edit fails, inspect the error and try a smaller exact match. If Write is available, you may use it for a small file you have read in full. Preserve unrelated contents. Run the project test command after the final edit. If it fails, inspect the result and continue fixing recoverable errors within scope.'
  ].join('\n\n');
}
