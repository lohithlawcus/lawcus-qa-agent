import test from 'node:test';
import assert from 'node:assert/strict';
import {planImpactedTest} from '../core/impacted-testing.mjs';
import {NATIVE_SUITE_MEMBERS} from '../testbook/lawcus-native-cases.mjs';

// A TestBook where every Create Contact - Person case is approved and runnable.
const members=NATIVE_SUITE_MEMBERS['Create Contact - Person'];
const testbook={tree:()=>[{name:'Contacts',suites:[{name:'Create Contact - Person',cases:members.map((externalId,i)=>({id:`id-${i}`,externalId,status:'approved',runnable:true,currentVersion:1}))}]}]};
const knowledge={approvedGraph:()=>[],approvedByFeature:()=>[],openReviewFlags:()=>[]};

test('the Create Contact - Person suite is the five approved cases the planner knows about',()=>{
 assert.equal(members.length,5);
});

for(const intent of ['test the cases for creating person type contact','test creating a person contact','check the create person contact cases','Test adding a new person contact.']){
 test(`"${intent}" plans the Create Contact - Person cases`,()=>{
  const plan=planImpactedTest({intent,knowledge,testbook});
  assert.equal(plan.matched,true);
  assert.equal(plan.patternId,'contact_person_create');
  assert.deepEqual(plan.cells.map(c=>c.externalId).sort(),[...members].sort());
  assert.ok(plan.cells.every(c=>c.covered));
 });
}

test('a company request is not planned as a person contact run',()=>{
 const plan=planImpactedTest({intent:'test creating a company contact',knowledge,testbook});
 assert.equal(plan.matched,false);
});
