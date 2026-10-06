import test from 'node:test';
import assert from 'node:assert/strict';
import {permitContactsRequest} from '../core/live-runner.mjs';

const API='https://api.fiveriverz.com';
test('the approved list reads are allowed, and no other POST is',()=>{
 for(const path of ['/v2/contacts','/v2/matters','/releases/list'])
  assert.equal(permitContactsRequest(API+path,'POST','fetch'),true,path);
 assert.equal(permitContactsRequest(API+'/settings/user','PUT','fetch'),false);
 assert.equal(permitContactsRequest(API+'/v2/contacts/delete','POST','fetch'),false);
 assert.equal(permitContactsRequest(API+'/v2/contacts/'+'e2bf71a0-ae87-11f1-ab8e-f18331cbd381','POST','fetch'),false);
});
