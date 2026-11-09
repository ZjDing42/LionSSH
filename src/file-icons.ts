const extensionGroups: Record<string, string> = {
  python: 'py pyw pyi pyc pyo',
  jupyter: 'ipynb',
  javascript: 'js mjs cjs jsx',
  typescript: 'ts mts cts tsx',
  vue: 'vue',
  c: 'c h',
  cpp: 'cpp cc cxx hpp hh hxx cu cuh',
  rust: 'rs',
  go: 'go',
  java: 'java class jar',
  console: 'sh bash zsh fish ksh csh tcsh bat cmd ps1',
  json: 'json jsonc json5 jsonl ndjson',
  yaml: 'yaml yml',
  toml: 'toml',
  settings: 'ini cfg conf config properties env',
  markdown: 'md markdown mdx',
  document: 'txt text rst rtf',
  log: 'log err out',
  html: 'html htm xhtml',
  css: 'css scss sass less',
  xml: 'xml xsl xsd plist',
  image: 'png jpg jpeg gif bmp webp avif svg ico tif tiff heic heif',
  pdf: 'pdf',
  zip: 'zip tar gz bz2 xz zst tgz tbz tbz2 txz 7z rar',
  table: 'csv tsv xls xlsx ods',
  database: 'sql db sqlite sqlite3',
  audio: 'mp3 wav flac ogg aac m4a opus',
  video: 'mp4 mkv mov avi webm m4v mpg mpeg',
};
const extensions = new Map(Object.entries(extensionGroups).flatMap(([icon, values]) => values.split(' ').map(value => [value, icon] as const)));
const names = new Map([
  ['.bashrc', 'console'], ['.bash_profile', 'console'], ['.profile', 'console'], ['.zshrc', 'console'],
  ['.gitignore', 'git'], ['.gitattributes', 'git'], ['.gitmodules', 'git'],
  ['.env', 'settings'], ['.editorconfig', 'settings'], ['.npmrc', 'settings'],
  ['dockerfile', 'docker'], ['containerfile', 'docker'], ['.dockerignore', 'docker'],
  ['docker-compose.yml', 'docker'], ['docker-compose.yaml', 'docker'],
  ['readme', 'document'], ['license', 'document'], ['copying', 'document'], ['makefile', 'console'],
]);
const folders = new Map([
  ['src', 'folder-src'], ['source', 'folder-src'], ['sources', 'folder-src'],
  ['images', 'folder-images'], ['img', 'folder-images'], ['assets', 'folder-images'],
  ['docs', 'folder-docs'], ['doc', 'folder-docs'], ['documents', 'folder-docs'],
  ['config', 'folder-config'], ['configs', 'folder-config'], ['.config', 'folder-config'],
]);

export function fileIcon(name: string, directory = false, expanded = false): string {
  const lower = name.toLowerCase();
  if (directory) return `${folders.get(lower) || 'folder'}${expanded ? '-open' : ''}`;
  if (names.has(lower)) return names.get(lower)!;
  if (lower.startsWith('.env.')) return 'settings';
  if (/^(?:dockerfile|containerfile)\./.test(lower)) return 'docker';
  if (/\.(?:log|err|out)\.\d+$/.test(lower)) return 'log';
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? extensions.get(lower.slice(dot + 1)) || 'file' : 'file';
}
