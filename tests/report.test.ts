import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { snapshotPackage } from '../src/snapshot.ts';
import { createScenarioSession } from '../src/scenario.ts';

test('saved HTML embeds only public complete baseline and computed scenarios, safely escapes hostile text', async () => {
  const api = await import('../src/report.ts').catch(() => null);
  assert.ok(api?.renderHtml, 'renderHtml must exist');
  const f = await fixture({'dist/style.css':'x','dist/.npmignore':'# </script><script>globalThis.injected=1</script>\n*.css\n'}, {files:['dist'],author:{email:'private@example.invalid'},description:'PRIVATE_MANIFEST'});
  try {
    const s=await createScenarioSession(await snapshotPackage(f.root),{schemaVersion:1,mustShip:['dist/style.css']});
    const base=s.report;
    const next=await s.apply({schemaVersion:1,operations:[{op:'removeIgnoreLine',path:'dist/.npmignore',line:2,expected:'*.css'}]});
    // A hostile filename in a DTO is portable even on Windows.
    next.entries.push({...next.entries[0],path:'evil</script><script>globalThis.injected=1</script>'});
    const html=api.renderHtml(base,{scenarios:[next]});
    assert.ok(!html.includes('PRIVATE_MANIFEST'));
    assert.ok(!html.includes('private@example.invalid'));
    assert.ok(!html.includes(f.root));
    assert.ok(!html.includes('evil</script>'));
    const data=JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
    assert.equal(data.reports.length,2);
    assert.equal(data.reports[0].scenario.assertions[0].status,'fail');
    assert.equal(data.reports[1].scenario.assertions[0].status,'pass');
    const omitted=api.renderHtml(base,{omitRuleText:true});
    const safe=JSON.parse(omitted.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
    assert.ok(safe.reports[0].ruleSources.every((x:any)=>!('text' in x)));
    assert.ok(safe.reports[0].evidence.every((x:any)=>!('pattern' in x)));
    const incomplete=structuredClone(next);incomplete.complete=false;
    assert.throws(()=>api.renderHtml(base,{scenarios:[incomplete]}),/INCOMPLETE_SAVED_SCENARIO/);
  } finally {await f.cleanup();}
});
