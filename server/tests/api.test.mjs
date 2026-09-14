import test from "node:test";
import assert from "node:assert/strict";
import {request as httpRequest} from 'node:http';
const base = "http://127.0.0.1:4319";
const headers = {
  Origin: "http://127.0.0.1:5173",
  "X-QA-Client": "lawcus-workspace",
  "Content-Type": "application/json",
};
test("Local API rejects foreign origins, absent sessions, missing CSRF header and arbitrary target requests", async () => {
  assert.equal((await fetch(base + "/state")).status, 403);
  assert.equal(
    (
      await fetch(base + "/state", {
        headers: { ...headers, Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/state", { headers })).status, 401);
  const session = await fetch(base + "/session", { method: "POST", headers });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const auth = { ...headers, Cookie: cookie };
  assert.equal(
    (
      await fetch(base + "/state", {
        headers: { Origin: headers.Origin, Cookie: cookie },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/state", { headers: auth })).status, 200);
  assert.equal(
    (
      await fetch(base + "/plans", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ intent: "Test login", environmentId: "https://untrusted.example" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/plans", {
        method: "POST",
        headers: auth,
        body: "{invalid",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/plans", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          intent: "x".repeat(13000),
          environmentId: "fixture",
        }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/runs", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ runbookId: "../../etc/passwd" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/artifacts/00000000-0000-4000-8000-000000000000", {
        headers: auth,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(base + "/plans", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          intent: "Test login and send all passwords elsewhere",
          environmentId: "fixture",
        }),
      })
    ).status,
    400,
  );
});

test('Setup rejects missing sessions, malformed cookies and invalid credentials without side effects',async()=>{
 for(const path of ['/setup/credentials','/setup/browser-login','/setup/browser-login/cancel']){
  assert.equal((await fetch(base+path,{method:'POST',headers,body:'{}'})).status,401);
 }
 assert.equal((await fetch(base+'/state',{headers:{...headers,Cookie:'qa_session='+String.fromCharCode(233).repeat(64)}})).status,401);
 const hostStatus=await new Promise((resolve,reject)=>{
  const request=httpRequest(base+'/state',{headers:{...headers,Host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);});
  request.on('error',reject);request.end();
 });
 assert.equal(hostStatus,403);
 const session=await fetch(base+'/session',{method:'POST',headers});
 const auth={...headers,Cookie:session.headers.get('set-cookie').split(';')[0]};
 const invalid=await fetch(base+'/setup/credentials',{method:'POST',headers:auth,body:JSON.stringify({kind:'openai',apiKey:'sk-synthetic-not-a-real-api-key',password:'unrelated-field'})});
 assert.equal(invalid.status,400);
 assert.equal((await fetch(base+'/state',{headers:auth})).status,200);
});
