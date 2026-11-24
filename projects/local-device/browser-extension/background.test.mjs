import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const { outputText } = ts.transpileModule(
  readFileSync(new URL('./background.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Preserve } }
);

test('shared actions reject cross-origin navigation and stale references before sending CDP commands', async () => {
  const calls = [];
  const event = { addListener() {} };
  const session = {
    origin: 'https://example.test',
    target: { tabId: 42 },
    refs: new Map()
  };
  const context = {
    URL,
    session,
    chrome: {
      action: { onClicked: event },
      debugger: { onDetach: event, sendCommand: (...args) => calls.push(args) },
      tabs: { onUpdated: event, onRemoved: event }
    }
  };
  runInNewContext(outputText + '\nshared = session;', context);
  await assert.rejects(
    runInNewContext("execute(session, {action:'navigate',url:'https://other.test'})", context),
    { message: 'browser_site_approval_required' }
  );
  await assert.rejects(
    runInNewContext("execute(session, {action:'click',ref:'e1_0'})", context),
    { message: 'browser_snapshot_required' }
  );
  assert.deepEqual(calls, []);
});
