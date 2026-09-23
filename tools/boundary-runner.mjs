import { writeFileSync } from 'node:fs';
import { Effect } from 'effect';
const root = '../overlay/test/integration/fixtures/';
const browser = '../overlay/packages/browser/test/fixtures/';
const browserbase = '../overlay/packages/browserbase/test/fixtures/';
const selection = process.argv[2] ?? 'all';
// Each recovery regression lives in the package whose code it tests.
const regressions = [`${browser}RecoveryCases`, `${browserbase}RecoveryCases`];
const suites = selection === 'regressions' ? regressions : [`${root}OwnershipCases`, `${browserbase}ArtifactCases`, `${browser}CaptureCases`, ...regressions];
const rows = [];
for (const suite of suites) {
  const mod = await import(new URL(`${suite}.ts`, import.meta.url));
  const tests = Object.values(mod).find(Array.isArray);
  for (const test of tests) {
    const before = performance.now();
    try { await Effect.runPromise(test.run.pipe(Effect.timeout(15000))); rows.push({name:test.name,status:'passed',millis:performance.now()-before}); }
    catch (error) { rows.push({name:test.name,status:'failed',error:String(error),millis:performance.now()-before}); }
    console.log(`${rows.at(-1).status.toUpperCase()} ${test.name}`);
  }
}
const output={runtime:process.version,bun:process.versions.bun ?? null,kind:'independent genuine Effect boundary harness, not repository/framework/native-browser acceptance',rows};
if (!process.argv[3]) throw new Error('Supply a distinct output filename');
writeFileSync(process.argv[3],JSON.stringify(output,null,2)+'\n');
console.log(`${rows.filter(x=>x.status==='passed').length}/${rows.length}`);
process.exitCode=rows.some(x=>x.status==='failed')?1:0;
