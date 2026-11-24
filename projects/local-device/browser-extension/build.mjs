import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const output = process.argv[2];
if (!output) throw new Error('Usage: node build.mjs <output-directory>');

const source = await readFile(new URL('./background.ts', import.meta.url), 'utf8');
const { outputText, diagnostics = [] } = ts.transpileModule(source, {
  fileName: 'background.ts',
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Preserve }
});
if (diagnostics.length) {
  throw new Error(
    diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n')
  );
}

const destination = resolve(output);
await mkdir(destination, { recursive: true });
await writeFile(resolve(destination, 'background.js'), outputText);
await copyFile(new URL('./manifest.json', import.meta.url), resolve(destination, 'manifest.json'));
