const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const output = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/gpu-process.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:output});
test('GPU user badges deduplicate users and put the owner of the largest PID in front', () => {
  const card = { processes:[{pid:10,username:'alice'},{pid:30,username:'bob'},{pid:50,username:'alice'},{pid:90},{pid:20,username:'charlie'}] };
  assert.deepEqual([...output.gpuUsers(card)],['alice','bob','charlie']);
  assert.equal(card.processes[0].pid,10);
  assert.deepEqual([...output.gpuUsers({})],[]);
});
test('process runtime formats missing values and multi-day jobs', () => {
  assert.equal(output.processElapsed(), '—');
  assert.equal(output.processElapsed(0), '00:00:00');
  assert.equal(output.processElapsed(90061), '1d 01:01:01');
});
