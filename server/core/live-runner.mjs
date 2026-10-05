import {chromium} from 'playwright';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readSecret} from './secrets.mjs';
import {savePersonaState,loadPersonaState} from './persona-session.mjs';
import {sealEvidence,saveCredentials,CredentialSetup,ENVIRONMENT_ACCOUNTS} from './setup.mjs';
import {startEgress} from './egress.mjs';
import {Plan} from './contracts.mjs';
import {now} from './store.mjs';
// V5 Step 10 / section 20 — these origins now live in one place
// (environment-adapter.mjs); re-exported here unchanged so nothing else
// that already imports them from live-runner.mjs has to change.
import {STAGING,API_ORIGIN,ASSETS,ENVIRONMENT_ORIGINS,resolveEnvironmentOrigins} from './environment-adapter.mjs';
export {STAGING,API_ORIGIN,ASSETS};
import {attachNetworkObserver,correlateObservation} from './network-observer.mjs';
import {attachRecorder} from './recorder.mjs';
import {updateAndRestoreContactCustomFieldViaBrowser,createContactViaBrowser,createCompanyContactViaBrowser,createContactAllFieldsViaBrowser,verifyPhoneNumberValidationViaBrowser,verifyBillingRateRequiredValidationViaBrowser,verifyMandatoryFieldValidationViaBrowser,verifyMandatoryFieldValidationCompanyViaBrowser,deleteContactViaBrowser,VIEWPORT as CONTACTS_VIEWPORT} from './contacts-browser.mjs';
import {updateAndRestoreLeadCustomFieldViaBrowser,createLeadViaBrowser,verifyLeadMandatoryFieldValidationViaBrowser,VIEWPORT as LEADS_VIEWPORT} from './leads-browser.mjs';
import {ApiContractError} from './api-contracts.mjs';
import {CheckAssertionError,classifyLoginFailure,classifyReportedFailure,classifyThrown,EVIDENCE_SAVE_FAILED} from './failure-class.mjs';
import {finalizeRun,finalizeFromSavedResults} from './run-outcome.mjs';
import {createMatterForContactViaBrowser,verifyMatterMandatoryFieldValidationViaBrowser} from './matters-browser.mjs';
import {readTenantLists} from './sweep-browser.mjs';
// V5 Step 11 / section 23 — which real API request each login scenario is
// expected to trigger. 'logout' is intentionally absent: no logout API
// contract exists yet (the response was never actually inspected anywhere
// in this codebase, so declaring one here would be inventing an
// expectation this project hasn't earned — see server/api-contracts/lawcus-seed.mjs).
const NETWORK_EXPECTATIONS={
 valid_login:{semanticId:'lawcus.auth.login',cardinality:'exactly_one'},
 invalid_password:{semanticId:'lawcus.auth.login',cardinality:'exactly_one'},
 password_masked:{semanticId:'lawcus.auth.login',cardinality:'zero'},
 empty_fields:{semanticId:'lawcus.auth.login',cardinality:'zero'},
};
export const liveDescriptions={
 valid_login:{title:'Sign in to the authorized staging workspace',expected:'The staging workspace opens and its profile menu identifies the dedicated QA account.'},
 password_masked:{title:'Keep the password concealed',expected:'The staging login password input masks typed characters.'},
 empty_fields:{title:'Validate empty login fields',expected:'An empty form shows validation, submits no login request, and remains unauthenticated.'},
 invalid_password:{title:'Reject one incorrect password attempt',expected:'The login API denies the credentials, an error is shown, and the workspace remains unavailable.'},
 logout:{title:'Sign out of the test browser',expected:'After logout, this browser returns to login and cannot reopen the protected workspace. Server-wide token revocation is outside this check.'}
};
export function permitLiveRequest(url,method,resourceType,origins=ENVIRONMENT_ORIGINS.lawcus){
 let u;try{u=new URL(url);}catch{return false;}
 if(u.protocol!=='https:'||u.username||u.password||u.port)return false;
 if(origins.assets.includes(u.origin))return ['GET','HEAD'].includes(method)&&['script','stylesheet','image','font','other'].includes(resourceType);
 if(![origins.app,origins.api].includes(u.origin))return false;
 if(['GET','HEAD','OPTIONS'].includes(method))return true;
 return u.origin===origins.api&&method==='POST'&&['/login','/logout','/forcelogout'].includes(u.pathname);
}
// V5 Step 15 — a separate, narrower-than-you'd-think policy for Contacts
// browser tests: everything permitLiveRequest already allows (GET reads
// are already unrestricted to STAGING/API_ORIGIN), PLUS exactly one write
// shape — PUT to /contacts/:uuid — matching the real lawcus.contacts.update
// contract's path template. Kept separate from permitLiveRequest so the
// login test suite's own policy is never silently widened by this.
export function permitContactsRequest(url,method,resourceType,postData){
 if(permitLiveRequest(url,method,resourceType))return true;
 let u;try{u=new URL(url);}catch{return false;}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.origin!==API_ORIGIN)return false;
 if(method==='PUT')return /^\/contacts\/[a-f0-9-]{36}$/.test(u.pathname);
 // lawcus.contacts.create — POST /contacts (no :uuid; the resource doesn't exist yet).
 if(method==='POST'&&u.pathname==='/contacts')return true;
 // The New Contact dialog's "Type to search..." fields (Company, Referred
 // By, Custom Contacts) resolve real existing records through a real
 // search endpoint, not the create endpoint above — POST /search/contacts
 // with a {params:{terms,type},pagination} body (params.type varies per
 // field: "Company" for the Company field, etc). Confirmed live
 // 2026-09-18 by directly capturing the exact request fired while typing
 // into the Company field with no route filtering at all — an earlier fix
 // attempt guessed POST /v2/contacts instead (a red herring: that request
 // turns out to be the Contacts LIST page's own background load, fired
 // before the New Contact dialog is even opened, not this search) and a
 // live re-run afterward showed identical failures, disproving it.
 // Restricted to that exact body shape (a "pagination" key, no
 // create/update-looking payload) so this stays a read, never a write
 // bypass on the same path.
 if(method==='POST'&&u.pathname==='/search/contacts'){
  try{const body=JSON.parse(postData||'');return body&&typeof body==='object'&&'pagination'in body;}catch{return false;}
 }
 // The Custom Matter field's own "Type to search..." box is the same
 // pattern one level over — POST /search/matters with a
 // {params:{status,terms},logicOperator,pagination} body, confirmed live
 // 2026-09-18 the same way as /search/contacts above (direct capture,
 // zero route filtering, typing "a" into the field).
 if(method==='POST'&&u.pathname==='/search/matters'){
  try{const body=JSON.parse(postData||'');return body&&typeof body==='object'&&'pagination'in body;}catch{return false;}
 }
 return false;
}
// Deleting a contact the tool created and a person approved (see
// resource-ownership.mjs's approveDeletion). Adds exactly one request shape
// to the contacts policy: DELETE /contacts/{uuid}, captured live 2026-10-05
// from the Lawcus UI's own Delete action. Nothing else is widened. Which
// uuid may actually be deleted is decided by the handler (deleteContactViaBrowser),
// not here: it refuses protected fixtures and any uuid whose page does not
// show the approved record's name.
export function permitContactsDeleteRequest(url,method,resourceType,postData){
 if(permitContactsRequest(url,method,resourceType,postData))return true;
 let u;try{u=new URL(url);}catch{return false;}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.origin!==API_ORIGIN)return false;
 return method==='DELETE'&&/^\/contacts\/[a-f0-9-]{36}$/.test(u.pathname);
}
// One signed-in session under the contacts policy (used by the supervised
// end-to-end test to create a record through the tool's own create code).
export function withLoggedInCreateContext(work){return withLoggedInContext(permitContactsRequest,work);}
// V5 Step 15 — same shape as permitContactsRequest, but for Leads: the
// real lawcus.leads.update call is PUT /leads with no :uuid in the path
// (the target lead is identified by matter_uuid in the body instead), so
// the exact-path check here is narrower than a regex with a UUID segment.
export function permitLeadsRequest(url,method,resourceType){
 if(permitLiveRequest(url,method,resourceType))return true;
 let u;try{u=new URL(url);}catch{return false;}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.origin!==API_ORIGIN)return false;
 // lawcus.leads.update (PUT) and lawcus.leads.create (POST) share the
 // exact same path — the real API distinguishes them only by method.
 return (method==='PUT'||method==='POST')&&u.pathname==='/leads';
}
async function launch(proxy,headless=true){if(process.env.QA_FORBID_LIVE)throw new Error('Live access (browser launch) is forbidden in this process.');return chromium.launch({headless,chromiumSandbox:true,...(proxy?{proxy:{server:proxy.server,bypass:'<-loopback>'}}:{}),args:['--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-quic']});}
export async function checkBrowser(){let browser;try{browser=await launch();const p=await browser.newPage();await p.goto('about:blank');return {ready:true,message:'Chromium can launch in the local runner.'};}catch{return {ready:false,message:'Chromium could not launch. Open the app using its launcher and keep that window open.'};}finally{await browser?.close().catch(()=>{});}}
function locator(page,kind,value){if(kind==='label')return page.getByLabel(value,{exact:true});if(kind==='placeholder')return page.getByPlaceholder(value,{exact:true});if(kind==='button')return page.getByRole('button',{name:value,exact:true});if(kind==='email-type')return page.locator('input[type="email"]');if(kind==='password-type')return page.locator('input[type="password"]');throw new Error('Unknown semantic locator.');}
async function field(page,type,saved){
 if(saved){const loc=locator(page,saved.kind,saved.value);if(await loc.count()===1&&await loc.isVisible())return {loc,fingerprint:saved};}
 const labels=type==='email'?['Email','Email address','Email Address']:['Password'];
 for(const kind of ['label','placeholder'])for(const name of labels){const loc=locator(page,kind,name);if(await loc.count()===1&&await loc.isVisible())return {loc,fingerprint:{kind,value:name}};}
 const kind=type==='email'?'email-type':'password-type';const loc=locator(page,kind,'');await loc.waitFor({state:'visible'});if(await loc.count()!==1)throw new Error('The login field is ambiguous.');return {loc,fingerprint:{kind,value:''}};
}
async function submitButton(page,saved){
 const names=[...new Set([saved?.value,'Login','Log in','Log In','Sign in','Sign In'].filter(Boolean))];const matches=[];
 for(const value of names){const loc=locator(page,'button',value);const count=await loc.count();if(count>1)throw new Error('Ambiguous login action.');if(count===1&&await loc.isVisible()&&await loc.isEnabled())matches.push({loc,fingerprint:{kind:'button',value}});}
 if(matches.length!==1)throw new Error('The login action could not be resolved uniquely.');return matches[0];
}
/** Says where a sign-in stalled: how long the wait ran and which page the browser was on (path only, never the query). Appended to the original error so its classification does not change. */
export function describeLoginStall(page,elapsedMs){
 let where='unknown page';
 try{const u=new URL(page.url());where=/\/login\/?$/.test(u.pathname)?'still on the login page (the sign-in did not complete)':`on ${u.pathname} (left the login page but the workspace did not load)`;}catch{}
 return ` [sign-in wait: ${Math.round(elapsedMs/1000)}s, ${where}]`;
}
export async function assertIdentity(page,username,appOrigin=STAGING){
 const waitStarted=Date.now();
 try{await page.getByPlaceholder('Search your practice',{exact:true}).waitFor({state:'visible'});}
 catch(error){error.message+=describeLoginStall(page,Date.now()-waitStarted);throw error;}
 if(new URL(page.url()).origin!==appOrigin)throw new Error('The login left the authorized tenant.');
 let profile=page.getByRole('button').filter({has:page.locator('.MuiAvatar-root')});
 if(await profile.count()===0)profile=page.getByRole('button').filter({has:page.locator('img')});
 if(await profile.count()===0)profile=page.getByRole('button',{name:/^(open )?(profile|account|user) menu$/i});
 if(await profile.count()!==1)throw new Error(`The account menu could not be resolved uniquely (${await profile.count()} matching controls).`);
 await profile.click();
 await page.getByRole('menuitem',{name:'Logout',exact:true}).waitFor({state:'visible'});
 await page.getByRole('menuitem').filter({hasText:username}).waitFor({state:'visible'});
 return profile;
}
export async function runLive({db,audit,runId,artifactDirectory,apiContracts,networkObservations,negativeAllowed=false}){
 const run=db.prepare('SELECT * FROM runs WHERE id=?').get(runId);const book=db.prepare('SELECT * FROM runbooks WHERE id=?').get(run.runbook_id);const plan=Plan.parse(JSON.parse(book.definition));
 const origins=resolveEnvironmentOrigins(book.environment_id);
 const credentialAccount=ENVIRONMENT_ACCOUNTS[book.environment_id];
 if(!credentialAccount)throw new Error('Incorrect environment for the staging runner.');
 if(plan.scenarios.includes('invalid_password')&&!negativeAllowed)throw new Error('Incorrect-password testing is not enabled.');
 let browser;let proxy;let failed=0;let authenticationBlocked=false;let path;const previous=run.path_id?db.prepare('SELECT * FROM execution_paths WHERE id=?').get(run.path_id):null;const old=previous?JSON.parse(previous.fingerprint):null;
 try{
  const creds=JSON.parse(await readSecret(credentialAccount));if(typeof creds.username!=='string'||typeof creds.password!=='string')throw new Error('Invalid staging credentials.');
  proxy=await startEgress(origins.egressHosts);
  mkdirSync(artifactDirectory,{recursive:true,mode:0o700});
  // Headed, not headless — the user asked to watch this specific flow
  // run (2026-09-16): "the browser should open the url and test the
  // feature." Same pattern already used for connectInBrowser,
  // verifyPersonaInBrowser and startAuthoringSession below — this app is
  // local, single-operator tooling ("Local development" in its own UI),
  // never CI (CI's test:browser only exercises runner.mjs's fixture
  // path, never this function — confirmed, not assumed).
  // One browser process for the whole run (2026-09-23): each scenario
  // below still gets its own fresh Playwright *context* — separate
  // cookies, storage and service workers, the same isolation a whole new
  // browser process gave, so an earlier scenario's login state can never
  // leak into the next one. Only the process-launch overhead is now
  // shared across scenarios; login frequency against real staging is
  // unchanged. That frequency, not process count, is the documented real
  // constraint here — see executeImpactedTest's delayBetweenRunsMs
  // comment in impacted-testing.mjs: repeated real logins in quick
  // succession are what caused staging-side flakiness before, and this
  // change doesn't touch that spacing.
  browser=await launch(proxy,false);
  for(const scenario of plan.scenarios){
   const id=randomUUID();const started=Date.now();const events=[];const blocked=new Set();let context;let page;let observer;let actual=liveDescriptions[scenario].expected;let status='passed';let healed=false;let candidate;let loginRequests=0;let loginStatus;let logoutRequested=false;let logoutRequests=0;let failureCategory='behavior-or-automation';let classification=null;let evidenceProblem=false;
   const event=(action,result)=>events.push({at:now(),action,result});
   try{
    // Bumped from 12000 -> 35000 (2026-09-17): a real Co Server run's
    // valid_login scenario failed to resolve the post-login identity within
    // 12s, then a live diagnostic (same login, same account) confirmed the
    // real Co Server dashboard reliably finishes loading well within 35s —
    // the same cold-start lesson already applied to Contacts/Leads below
    // ("Bumped from 20000 -> 35000"), just never carried over to this,
    // the original login suite. Applies to every environment, not only the
    // newer ones — Fiveriverz can hit the same cold-start delay.
    context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,viewport:{width:1280,height:900}});context.setDefaultTimeout(35000);context.setDefaultNavigationTimeout(25000);
    observer=attachNetworkObserver(context);
    await context.routeWebSocket(/.*/,socket=>socket.close());
    await context.route('**/*',async route=>{const request=route.request();const url=new URL(request.url());
     if(!permitLiveRequest(request.url(),request.method(),request.resourceType(),origins)){blocked.add([origins.app,origins.api,...origins.assets].includes(url.origin)?'disallowed-method-or-resource':'unapproved-destination');await route.abort('blockedbyclient');return;}
     if(request.method()==='POST'&&url.origin===origins.api&&['/logout','/forcelogout'].includes(url.pathname)){
      if(!logoutRequested||scenario!=='logout'||++logoutRequests>1){event('Unexpected logout submission','blocked');await route.abort('blockedbyclient');return;}
      event('Submit staging logout','one request');
     }
     if(request.method()==='POST'&&url.origin===origins.api&&url.pathname==='/login'){
      loginRequests++;if(loginRequests>1||['empty_fields','password_masked'].includes(scenario)){event('Unexpected login submission','blocked');await route.abort('blockedbyclient');return;}
      if(scenario!=='invalid_password'){
       let payload;try{payload=request.postDataJSON();}catch{}
       const matches=payload&&payload.email===creds.username&&payload.password===creds.password;
       event('Verify outgoing credentials',matches?'match saved account exactly':'mismatch; submission blocked');
       if(!matches){await route.abort('blockedbyclient');return;}
      }
     }
     await route.continue();
    });
    page=await context.newPage();page.on('dialog',d=>void d.dismiss());page.on('response',async r=>{const u=new URL(r.url());if(u.origin===origins.api&&u.pathname==='/login'&&r.request().method()==='POST'){loginStatus=r.status();if(r.status()>=400&&scenario!=='invalid_password'){
      authenticationBlocked=true;
      try{const response=await r.json();const value=typeof response.error==='string'?response.error:'';event('Authentication rejection category',/credentials.*incorrect|incorrect.*credentials|invalid.*password|password.*incorrect/i.test(value)?'invalid-credentials':/captcha|bot|challenge/i.test(value)?'automation-challenge':/denied|forbidden/i.test(value)?'access-denied':'unclassified');}catch{event('Authentication rejection category','non-JSON response');}
     }}});
    event('Open staging login','requested');
    await page.goto(origins.app+'/login',{waitUntil:'domcontentloaded'});event('Open staging login','loaded');
    const email=await field(page,'email',old?.email);const password=await field(page,'password',old?.password);const submit=await submitButton(page,old?.submit);
    candidate={email:email.fingerprint,password:password.fingerprint,submit:submit.fingerprint,assertionContract:'staging-login-v1',origin:origins.app};
    if(scenario==='password_masked'){
     if(await password.loc.getAttribute('type')!=='password')throw new CheckAssertionError('The password is not masked.');event('Check password masking','passed');
    }else if(scenario==='empty_fields'){
     await submit.loc.click();
     await page.getByText('Email is required',{exact:true}).waitFor({state:'visible'});
     await page.getByText('Password is required',{exact:true}).waitFor({state:'visible'});
     if(loginRequests!==0||await password.loc.count()!==1||new URL(page.url()).pathname!=='/login')throw new CheckAssertionError('Empty credentials were submitted or no validation was observed.');event('Submit empty fields','validation shown without a network submission');
    }else{
     if(authenticationBlocked)throw new Error('An earlier authentication attempt failed; additional attempts are stopped.');
     audit('login.attempt',runId,{scenario,environment:book.environment_id});
     await email.loc.fill(creds.username);await password.loc.fill(scenario==='invalid_password'?randomBytes(24).toString('hex'):creds.password);event('Fill dedicated account credentials','values withheld');
     await submit.loc.click();event('Submit login','one attempt');
     if(scenario==='invalid_password'){
      await page.getByRole('alert').filter({hasText:/credentials|password|access|incorrect/i}).waitFor();
      if(![400,401,403].includes(loginStatus))throw new CheckAssertionError('The API did not explicitly reject the credentials.');
      await page.goto(origins.app+'/dashboard');await field(page,'password',candidate.password);
      if(new URL(page.url()).pathname!=='/login')throw new CheckAssertionError('Protected content remained accessible.');event('Check denial','API denial and login page verified');
     }else{
      await assertIdentity(page,creds.username,origins.app);event('Verify authenticated account','dedicated QA identity matched');
      if(scenario==='logout'){
       const out=page.getByRole('menuitem',{name:'Logout',exact:true});logoutRequested=true;event('Choose logout','requested');await out.click();await field(page,'password',candidate.password);await page.goto(origins.app+'/dashboard');await field(page,'password',candidate.password);
       if(new URL(page.url()).pathname!=='/login')throw new CheckAssertionError('The test browser remained authenticated after logout.');event('Sign out and revisit protected route','login required');
      }else{await page.keyboard.press('Escape');}
     }
    }
    if(old&&JSON.stringify(candidate)!==JSON.stringify(old)&&['valid_login','logout'].includes(scenario)){healed=true;audit('path.technical-repair',runId,{scenario,reason:'Changed semantic fields passed the unchanged authenticated-account contract.'});}
    if(['valid_login','logout'].includes(scenario))path=candidate;
   }catch(error){
    const networkCode=String(error?.message||'').match(/net::ERR_[A-Z_]+/)?.[0];
    if(networkCode)failureCategory=networkCode;
    else if(error?.name==='TimeoutError')failureCategory=events.some(e=>e.action==='Open staging login'&&e.result==='loaded')?'assertion-timeout':'page-load-timeout';
    if(['valid_login','logout'].includes(scenario))authenticationBlocked=true;
    failed++;status='failed';actual='The expected result was not confirmed. Expectations have not been changed.';
    if(!page){failureCategory='runner';actual='The browser could not create an isolated session.';}
    else if((loginStatus===401||loginStatus===403)&&scenario!=='invalid_password'){failureCategory='authentication-rejected';actual='Staging rejected the dedicated account credentials. Update the saved account before trying again; further login attempts were stopped.';}
    else if(authenticationBlocked&&loginRequests===0&&['valid_login','logout'].includes(scenario)){failureCategory='earlier-authentication-failure';actual='This check did not attempt another login because an earlier authentication check failed.';}
    classification=classifyLoginFailure({error,page,loginStatus,scenario,authenticationBlocked,loginRequests});
    event('Check stopped',failureCategory);
    const questionId=randomUUID();db.prepare('INSERT INTO clarifications(id,run_id,question,created_at) VALUES(?,?,?,?)').run(questionId,runId,`${classification.explanation} [${classification.failureClass}: ${classification.reasonCode}] `+(failureCategory==='authentication-rejected'?'Staging rejected the saved dedicated account. Please verify and update it in Environment; do not enter passwords here.':failureCategory==='earlier-authentication-failure'?'An earlier authentication failure prevented this check. Resolve that failure before another run.':failureCategory==='page-load-timeout'?'The staging page did not load in time. Check availability before another run.':`During “${liveDescriptions[scenario].title}”, I could not confirm the expected behavior. ${liveDescriptions[scenario].expected} Review the evidence before deciding whether application behavior or automation needs correction.`),now());
    audit('clarification.opened',questionId,{runId,scenario});
   }
   observer?.dispose();
   // Real response-body race, same root cause as contacts-browser.mjs's
   // (see network-observer.mjs's settle() comment) — dispose() above only
   // stops listening for new responses, it doesn't wait for in-flight
   // body reads, so this must still happen before correlating below.
   await observer?.settle();
   // Correlation is computed here (it can still affect status/actual before
   // scenario_results is written), but network_observations itself is only
   // written further below, AFTER that row exists — it carries a foreign
   // key to scenario_results(id), which this scenario's row doesn't have
   // until the INSERT a few lines down.
   const expectation=NETWORK_EXPECTATIONS[scenario];
   let pendingObservation=null;
   if(expectation&&observer){
    try{
     const contract=apiContracts.resolveApprovedContract(expectation.semanticId);
     const result=correlateObservation({contract,events:observer.events,host:new URL(origins.api).hostname,cardinality:expectation.cardinality});
     pendingObservation={contractId:contract.id,semanticId:expectation.semanticId,expectedCardinality:expectation.cardinality,result};
     if(status==='passed'&&!result.contractMatch){failed++;status='failed';actual=`The UI behaved as expected, but the network check failed: ${result.mismatchReason}`;classification=classifyReportedFailure(result.mismatchReason);event('Network contract check',result.mismatchReason);}
     else event('Network contract check',result.contractMatch?'matched':'not verified (UI already failed)');
    }catch(error){
     // No approved contract yet for this semantic id — section 23's
     // "blocked_unverified": network verification is unavailable, not a
     // reason to fail a scenario whose UI behavior already passed.
     if(!(error instanceof ApiContractError))throw error;
    }
   }
   const artifacts=[];
   try{
    if(page){const image=await page.screenshot({mask:[page.locator('input'),page.locator('textarea')],fullPage:false});const name=`${randomUUID()}.png.enc`;writeFileSync(join(artifactDirectory,name),await sealEvidence(image),{mode:0o600});artifacts.push(['screenshot',name]);image.fill(0);}
    const trace=Buffer.from(JSON.stringify({format:'lawcus-redacted-execution-trace-v1',scenario,expected:liveDescriptions[scenario].expected,status,events,loginRequests,loginStatus,blockedCategories:[...blocked],networkPolicy:'HTTPS pinned public IPs; staging/API/read-only CDN only',limitations:'No raw DOM, cookie, credential, response body or native Playwright trace is included.'},null,2));
    const name=`${randomUUID()}.json.enc`;writeFileSync(join(artifactDirectory,name),await sealEvidence(trace),{mode:0o600});artifacts.push(['trace',name]);trace.fill(0);
    if(!page)throw new Error('No screenshot captured.');
   }catch{evidenceProblem=true;if(status==='passed'){failed++;status='failed';actual='The check could not save its required encrypted evidence. It is not counted as passed.';classification=EVIDENCE_SAVE_FAILED;}}
   // Only the per-scenario context closes here now — the browser process
   // is shared across the whole run (see the launch() call before this
   // loop) and closes once, in this function's own outer finally below.
   finally{await context?.close().catch(()=>{});}
   // Pre-existing bug fixed here (V5 Step 11): migration 005 added
   // test_case_id/test_definition_version_id to scenario_results, but this
   // legacy live-staging path (predates the DSL/TestBook system) was never
   // updated — its 9-value positional INSERT against an 11-column table
   // has thrown on every real 'lawcus' run since. Named columns, leaving
   // the two TestBook-linkage columns NULL (nullable by design — this path
   // doesn't run DSL-defined cases the way runner.mjs's executeRun() does).
   db.prepare('INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,healed,failure_class,reason_code,evidence_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,runId,scenario,liveDescriptions[scenario].title,status,liveDescriptions[scenario].expected,actual,Date.now()-started,healed?1:0,classification?.failureClass??null,classification?.reasonCode??null,evidenceProblem?'save_failed':(artifacts.some(a=>a[0]==='screenshot')?'saved':'none_captured'));
   for(const [kind,name] of artifacts)db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)').run(randomUUID(),runId,id,kind,name,now());
   if(pendingObservation)networkObservations.record({runId,scenarioResultId:id,stepLabel:scenario,...pendingObservation});
   if(observer?.consoleEntries.length)networkObservations.recordConsoleEntries({runId,scenarioResultId:id,entries:observer.consoleEntries});
  }
  if(!failed&&path&&(!old||JSON.stringify(path)!==JSON.stringify(old))){const id=randomUUID();const version=(db.prepare('SELECT MAX(version) v FROM execution_paths WHERE runbook_id=?').get(book.id).v||0)+1;db.prepare('INSERT INTO execution_paths VALUES(?,?,?,?,?)').run(id,book.id,version,JSON.stringify(path),now());audit('path.saved',id,{version,environment:book.environment_id});}
  const evidenceLost=db.prepare("SELECT COUNT(*) n FROM scenario_results WHERE run_id=? AND evidence_status='save_failed'").get(runId).n;
  finalizeFromSavedResults(db,runId,{planned:plan.scenarios.length,extraSummary:`${run.replay?'Saved semantic path replayed.':'First staging execution.'} Zero model calls during browser execution.${evidenceLost?` Evidence for ${evidenceLost} check(s) could not be saved.`:' Evidence is encrypted locally.'}`});
  audit('run.completed',runId,{environment:book.environment_id,failed,checks:plan.scenarios.length});
 }catch(error){
  finalizeRun(db,runId,{planned:plan.scenarios.length,error});audit('run.interrupted',runId,{environment:book.environment_id,reasonCode:classifyThrown(error).reasonCode});
 }finally{await browser?.close().catch(()=>{});await proxy?.close().catch(()=>{});}
}

// Explicit operator-driven connection: no keystrokes, password filling or retries.
export async function connectInBrowser({audit,onState,signal}){
 let browser,proxy,context,candidate,timer;
 let settle;
 const authenticated=new Promise((resolve,reject)=>{settle={resolve,reject};});
 // Attach a handler immediately; a browser-close event can occur during navigation.
 authenticated.catch(()=>{});
 const cancel=()=>{settle.reject(new Error('Visible sign-in was cancelled.'));void browser?.close().catch(()=>{});};
 signal.addEventListener('abort',cancel,{once:true});
 try{
  proxy=await startEgress(['lohith.fiveriverz.com','api.fiveriverz.com','daewtpgqtk7am.cloudfront.net']);
  browser=await launch(proxy,false);
  context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
  context.setDefaultTimeout(20000);context.setDefaultNavigationTimeout(25000);
  await context.routeWebSocket(/.*/,socket=>socket.close());
  let attempts=0;
  await context.route('**/*',async route=>{
   const request=route.request();const url=new URL(request.url());
   if(!permitLiveRequest(request.url(),request.method(),request.resourceType())||(request.method()==='POST'&&url.pathname!=='/login')){await route.abort('blockedbyclient');return;}
   if(request.method()==='POST'&&url.origin===API_ORIGIN&&url.pathname==='/login'){
    if(++attempts>1){await route.abort('blockedbyclient');return;}
    try{const value=request.postDataJSON();candidate=CredentialSetup.parse({kind:'lawcus',username:value.email,password:value.password});}
    catch{await route.abort('blockedbyclient');settle.reject(new Error('The sign-in form did not submit the expected credential fields.'));return;}
    audit('setup.visible-login-attempt','lawcus');
   }
   await route.continue();
  });
  const page=await context.newPage();
  page.on('close',cancel);browser.on('disconnected',cancel);
  page.on('response',response=>{
   const u=new URL(response.url());
   if(u.origin===API_ORIGIN&&u.pathname==='/login'&&response.request().method()==='POST'){
    if(response.status()===200)settle.resolve();
    else settle.reject(new Error('Staging rejected this visible sign-in. No credentials were updated.'));
   }
  });
  timer=setTimeout(()=>settle.reject(new Error('Visible sign-in timed out. No credentials were updated.')),180000);
  await page.goto(STAGING+'/login',{waitUntil:'commit',timeout:45000});
  await page.locator('input[type="password"]').waitFor({state:'visible',timeout:30000});
  onState({status:'waiting',message:'Sign in to staging in the separate Chromium window. The working account will be saved only after authentication is verified.'});
  await authenticated;
  if(!candidate)throw new Error('No account was submitted.');
  let sameSavedAccount=null;
  try{const old=JSON.parse(await readSecret('lawcus-login'));sameSavedAccount=old.username===candidate.username&&old.password===candidate.password;}catch{}
  audit('setup.visible-authentication-accepted','lawcus',{sameSavedAccount});
  await page.getByPlaceholder('Search your practice',{exact:true}).waitFor({state:'visible'});
  if(new URL(page.url()).origin!==STAGING)throw new Error('Sign-in left the authorized staging tenant.');
  onState({status:'waiting',message:'Sign-in accepted. Open your profile menu in the top-right corner of the Chromium window so the account email can be verified.'});
  await page.getByRole('menuitem',{name:'Logout',exact:true}).waitFor({state:'visible',timeout:90000});
  await page.getByRole('menuitem').filter({hasText:candidate.username}).waitFor({state:'visible'});
  if(signal.aborted)throw new Error('Visible sign-in was cancelled.');
  await saveCredentials(candidate);
  audit('setup.credential-saved','lawcus',{storage:'macOS Keychain',verifiedBy:'operator-visible-login',sameSavedAccount});
  return {status:'passed',message:'Staging login and account identity verified. The working account is saved securely.',sameSavedAccount};
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',cancel);candidate=null;
  await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await proxy?.close().catch(()=>{});
 }
}

// V5 Step 12 / section 18 — the only way a persona ever becomes 'verified'.
// A close relative of connectInBrowser() above, generalized to a named
// persona/Keychain account instead of the one primary 'lawcus-login'
// account, and extended to capture the resulting authenticated session
// (encrypted via persona-session.mjs) so later runs can restore it instead
// of signing in again every time. Same security shape as connectInBrowser:
// no keystrokes, password filling or retries — the operator types their
// own credentials into a real, visible Chromium window this code never
// reads from except to confirm identity afterward.
export async function verifyPersonaInBrowser({personas,personaId,artifactDirectory,verifiedBy,audit,onState,signal}){
 const persona=personas.get(personaId);
 if(!persona)throw new Error('Unknown persona.');
 if(persona.status==='verified')throw new Error('This persona is already verified. Revoke it first to re-verify.');
 let browser,proxy,context,candidate,timer;
 let settle;
 const authenticated=new Promise((resolve,reject)=>{settle={resolve,reject};});
 authenticated.catch(()=>{});
 const cancel=()=>{settle.reject(new Error('Visible sign-in was cancelled.'));void browser?.close().catch(()=>{});};
 signal.addEventListener('abort',cancel,{once:true});
 try{
  proxy=await startEgress(['lohith.fiveriverz.com','api.fiveriverz.com','daewtpgqtk7am.cloudfront.net']);
  browser=await launch(proxy,false);
  context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
  context.setDefaultTimeout(20000);context.setDefaultNavigationTimeout(25000);
  await context.routeWebSocket(/.*/,socket=>socket.close());
  let attempts=0;
  await context.route('**/*',async route=>{
   const request=route.request();const url=new URL(request.url());
   if(!permitLiveRequest(request.url(),request.method(),request.resourceType())||(request.method()==='POST'&&url.pathname!=='/login')){await route.abort('blockedbyclient');return;}
   if(request.method()==='POST'&&url.origin===API_ORIGIN&&url.pathname==='/login'){
    if(++attempts>1){await route.abort('blockedbyclient');return;}
    try{const value=request.postDataJSON();candidate=CredentialSetup.parse({kind:'lawcus-persona',account:persona.credential_account,username:value.email,password:value.password});}
    catch{await route.abort('blockedbyclient');settle.reject(new Error('The sign-in form did not submit the expected credential fields.'));return;}
    audit('persona.visible-login-attempt',personaId,{role:persona.role});
   }
   await route.continue();
  });
  const page=await context.newPage();
  page.on('close',cancel);browser.on('disconnected',cancel);
  page.on('response',response=>{
   const u=new URL(response.url());
   if(u.origin===API_ORIGIN&&u.pathname==='/login'&&response.request().method()==='POST'){
    if(response.status()===200)settle.resolve();
    else settle.reject(new Error('Staging rejected this visible sign-in. No credentials were updated.'));
   }
  });
  timer=setTimeout(()=>settle.reject(new Error('Visible sign-in timed out. No credentials were updated.')),180000);
  await page.goto(STAGING+'/login',{waitUntil:'commit',timeout:45000});
  await page.locator('input[type="password"]').waitFor({state:'visible',timeout:30000});
  onState({status:'waiting',message:`Sign in as the ${persona.label} persona in the separate Chromium window. Nothing is saved until identity is verified.`});
  await authenticated;
  if(!candidate)throw new Error('No account was submitted.');
  audit('persona.visible-authentication-accepted',personaId,{role:persona.role});
  await page.getByPlaceholder('Search your practice',{exact:true}).waitFor({state:'visible'});
  if(new URL(page.url()).origin!==STAGING)throw new Error('Sign-in left the authorized staging tenant.');
  onState({status:'waiting',message:'Sign-in accepted. Open your profile menu in the top-right corner of the Chromium window so the account email can be verified.'});
  await page.getByRole('menuitem',{name:'Logout',exact:true}).waitFor({state:'visible',timeout:90000});
  await page.getByRole('menuitem').filter({hasText:candidate.username}).waitFor({state:'visible'});
  if(signal.aborted)throw new Error('Visible sign-in was cancelled.');
  // Capture the authenticated session before anything closes the context —
  // this is what lets a later run restore state instead of signing in again.
  const storageState=await context.storageState();
  await savePersonaState(artifactDirectory,personaId,storageState);
  await saveCredentials(candidate);
  personas.markVerified(personaId,{username:candidate.username,verifiedBy});
  personas.recordSessionCaptured(personaId);
  audit('persona.verified',personaId,{role:persona.role,storage:'macOS Keychain + encrypted session state'});
  return {status:'passed',message:`${persona.label} signed in, identity verified, and session saved securely.`};
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',cancel);candidate=null;
  await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await proxy?.close().catch(()=>{});
 }
}

// V5 Step 14 / section 29.1 — Controlled Codegen context. Opens a real,
// visible Chromium window the operator manually performs a workflow in.
//
// 2026-10-05: previously restricted to permitLiveRequest (the LOGIN
// suite's policy — login/logout only), inherited by accident rather than
// chosen for this use. The first real recording attempt against staging
// hit it immediately: creating a Contact failed with "Network error
// detected" because POST /contacts, the Maps script and static icons
// were all blocked client-side, Lawcus's own UI unable to tell it wasn't
// a real network problem. Every other function in this file restricts an
// AUTOMATED script's writes — that model doesn't apply here, where a
// person is physically watching and performing every single action
// themselves, exactly as free to do so in an ordinary browser outside
// this tool entirely. By the operator's explicit decision: no network
// restriction and no pinned-egress proxy for a recording session against
// real staging — same as the fixture branch always had. What a session
// produces is still never trusted or executed automatically — review in
// Proposals is still required for every captured action before anything
// becomes a test. (Filtering captured actions down to only the ones that
// match the operator's stated workflow, so an aside doesn't also become a
// proposal, is a separate, not-yet-built piece — see buildProposalSpecs
// in recorder.mjs, which currently proposes from every captured action.)
//
// Stays open (unlike every other function in this file) until the caller
// explicitly calls finish() or abort(), because recording is an
// open-ended human activity, not a bounded scripted scenario.
export async function startAuthoringSession({environmentId,origin,personaId=null,personas=null,personaDirectory}){
 let browser,proxy,context;
 try{
  if(environmentId!=='lawcus'&&environmentId!=='fixture')
   throw new Error('Unknown environment for an authoring session.');
  browser=await launch(proxy,false);
  let storageState;
  if(personaId){
   const persona=personas.resolveVerifiedPersona(personaId);
   storageState=(await loadPersonaState(personaDirectory,personaId))||undefined;
   if(!storageState)throw new Error(`Persona "${persona.label}" has no saved session yet — sign in as this persona in Personas first.`);
  }
  context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,...(storageState?{storageState}:{})});
  context.setDefaultTimeout(20000);context.setDefaultNavigationTimeout(25000);
  await context.routeWebSocket(/.*/,socket=>socket.close());
  // Deliberately no permit*/route() gate and no startEgress proxy here — see
  // this function's own comment above for why a recording session is not
  // restricted the way every automated check in this file is.
  const recorder=await attachRecorder(context,{personaLabel:personaId?'persona':null});
  const observer=attachNetworkObserver(context);
  const page=await context.newPage();
  page.on('dialog',d=>void d.dismiss());
  await page.goto((environmentId==='lawcus'?STAGING:origin)+(storageState?'':'/login'),{waitUntil:'domcontentloaded'});
  return {
   status(){return {actionCount:recorder.actions.length,networkCount:observer.events.length,teaching:recorder.isTeaching()};},
   async finish(){
    const actions=[...recorder.actions];
    const networkEvents=[...observer.events];
    const consoleEntries=[...observer.consoleEntries];
    observer.dispose();
    await context.close().catch(()=>{});await browser.close().catch(()=>{});await proxy?.close().catch(()=>{});
    return {actions,networkEvents,consoleEntries};
   },
   async abort(){
    await context.close().catch(()=>{});await browser.close().catch(()=>{});await proxy?.close().catch(()=>{});
   },
  };
 }catch(error){
  await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await proxy?.close().catch(()=>{});
  throw error;
 }
}

// V5 Step 15 — Contacts + Custom Fields, browser-driven per the user's
// explicit direction. Logs in exactly the way runLive()'s valid_login
// scenario already does (same field()/submitButton()/assertIdentity()
// helpers), then hands off to contacts-browser.mjs for the actual
// update/verify/restore cycle. Uses permitContactsRequest — NOT
// permitLiveRequest — so the login suite's own policy is untouched.
// Headed, not headless (2026-09-17) — every function below this point was
// still launching invisibly; the user asked to watch these run too, same
// as runLive()'s own headed launch above.
export async function runContactCustomFieldCheck({apiContracts,mutationJournal,runId,uuid,fieldName,newValue,primitiveId='contacts.update_custom_field_via_browser'}){
 return withLoggedInContext(permitContactsRequest,(context)=>updateAndRestoreContactCustomFieldViaBrowser({context,apiContracts,mutationJournal,environmentId:'lawcus',runId,uuid,fieldName,newValue,primitiveId}));
}

// V5 Step 15 — Leads, browser-driven, mirroring runContactCustomFieldCheck
// exactly (same login helpers, same permit*/close discipline), aimed at
// leads-browser.mjs's Step 2 (matter-level) custom field cycle instead.
// Uses permitLeadsRequest — NOT permitLiveRequest or permitContactsRequest
// — so neither existing policy is silently widened by this.
export async function runLeadCustomFieldCheck({apiContracts,mutationJournal,runId,uuid,fieldName,newValue,primitiveId='leads.update_custom_field_via_browser'}){
 return withLoggedInContext(permitLeadsRequest,(context)=>updateAndRestoreLeadCustomFieldViaBrowser({context,apiContracts,mutationJournal,environmentId:'lawcus',runId,uuid,fieldName,newValue,primitiveId}),{viewport:LEADS_VIEWPORT});
}

// V5 Step 15 — new-Contact creation, browser-driven, completing the
// "existing/new x Contact/Lead x UI/API" verification matrix's UI/new
// cell for Contacts (section 50). Same login/permit/close discipline as
// runContactCustomFieldCheck; hands off to contacts-browser.mjs's
// createContactViaBrowser for the actual creation + correlation.
export async function runContactCreationCheck({apiContracts,firstName,lastName}){
 return withLoggedInContext(permitContactsRequest,(context)=>createContactViaBrowser({context,apiContracts,firstName,lastName}));
}

// V5 "Start with Contacts" (2026-09-16) — Create Contact suite, first
// granular case beyond the single bundled creation check above: the New
// Contact form's own required-field validation (First Name/Last Name),
// observed directly in staging before this was written (see
// verifyMandatoryFieldValidationViaBrowser's comment). Same
// login/permit/close discipline as runContactCreationCheck.
export async function runContactMandatoryFieldValidationCheck(){
 return withLoggedInContext(permitContactsRequest,(context)=>verifyMandatoryFieldValidationViaBrowser({context}));
}

// V5 "explore Contacts in more detail" (2026-09-18) — the comprehensive
// counterpart to runContactCreationCheck: fills every field across all
// four New Contact sections (not just First/Last) and independently
// re-reads the real detail page to confirm each one actually saved. Same
// login/permit/close discipline as every other Contacts check above.
export async function runContactAllFieldsCreationCheck({apiContracts,marker}){
 return withLoggedInContext(permitContactsRequest,(context)=>createContactAllFieldsViaBrowser({context,apiContracts,marker}));
}

// V5 "explore Contacts in more detail" (2026-09-18) — a real validation
// constraint found live: a "555" area code phone number is rejected by
// Lawcus's own phone validation. Same login/permit/close discipline as
// runContactMandatoryFieldValidationCheck.
export async function runContactPhoneValidationCheck(){
 return withLoggedInContext(permitContactsRequest,(context)=>verifyPhoneNumberValidationViaBrowser({context}));
}

// V5 "explore Contacts in more detail" (2026-09-18) — a real cascading
// required field found live: enabling "Enable client rates" reveals a
// required "Fixed rate" field with no prior indication it exists. Same
// login/permit/close discipline as every other Contacts check above.
export async function runContactBillingRateValidationCheck(){
 return withLoggedInContext(permitContactsRequest,(context)=>verifyBillingRateRequiredValidationViaBrowser({context}));
}

// V5 "Start with Contacts" (2026-09-16) — Create Contact - Company suite,
// the Company-type counterpart to runContactCreationCheck. Same
// login/permit/close discipline; hands off to contacts-browser.mjs's
// createCompanyContactViaBrowser.
export async function runContactCompanyCreationCheck({apiContracts,name}){
 return withLoggedInContext(permitContactsRequest,(context)=>createCompanyContactViaBrowser({context,apiContracts,name}));
}

// V5 "Start with Contacts" (2026-09-16) — Create Contact - Company suite,
// the Company-type counterpart to runContactMandatoryFieldValidationCheck.
export async function runContactCompanyMandatoryFieldValidationCheck(){
 return withLoggedInContext(permitContactsRequest,(context)=>verifyMandatoryFieldValidationCompanyViaBrowser({context}));
}

// V5 Step 15 — new-Lead creation, browser-driven, the UI/new cell for
// Leads in section 50's matrix. Mirrors runContactCreationCheck.
export async function runLeadCreationCheck({apiContracts,firstName,lastName,matterName}){
 return withLoggedInContext(permitLeadsRequest,(context)=>createLeadViaBrowser({context,apiContracts,firstName,lastName,matterName}),{viewport:LEADS_VIEWPORT});
}

// V5 "Keep going with Leads" (2026-09-16) — Create Lead - Person suite,
// the New Lead wizard's own required-field validation (First Name/Last
// Name on Step 1), observed directly in staging before this was written
// (see verifyLeadMandatoryFieldValidationViaBrowser's comment). Same
// login/permit/close discipline as runLeadCreationCheck.
export async function runLeadMandatoryFieldValidationCheck(){
 return withLoggedInContext(permitLeadsRequest,(context)=>verifyLeadMandatoryFieldValidationViaBrowser({context}),{viewport:LEADS_VIEWPORT});
}

// Contact -> Matter slice (2026-09-26). The write policy is the Contacts one
// plus exactly one more write: POST /matters (lawcus.matters.create). The New
// Matter dialog also makes a PUT /settings/user of its own when it opens; that
// is deliberately NOT allowed — a check must not change the account's settings.
export function permitMattersRequest(url,method,resourceType,postData){
 if(permitContactsRequest(url,method,resourceType,postData))return true;
 let u;try{u=new URL(url);}catch{return false;}
 return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.origin===API_ORIGIN&&method==='POST'&&u.pathname==='/matters';
}
// One login, then hand the signed-in context to `work`. Every Contacts, Leads
// and Matters check above shared this exact sequence as copied inline code
// (2026-09-16 through 2026-09-26); consolidated here 2026-09-28 so a change
// to the login step — like the 20000->35000 timeout bump, made piecemeal
// across several of those copies — only needs to happen once. Behavior is
// unchanged: same egress hosts, same timeouts, same close order. `viewport`
// defaults to CONTACTS_VIEWPORT, the default every caller but Leads used.
async function withLoggedInContext(permit,work,{viewport=CONTACTS_VIEWPORT}={}){
 let browser,proxy,context;
 try{
  const creds=JSON.parse(await readSecret('lawcus-login'));if(typeof creds.username!=='string'||typeof creds.password!=='string')throw new Error('Invalid staging credentials.');
  proxy=await startEgress(['lohith.fiveriverz.com','api.fiveriverz.com','daewtpgqtk7am.cloudfront.net']);
  browser=await launch(proxy,false);
  context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,viewport});
  // Bumped from 20000 -> 35000 (2026-09-16): two real staging runs each showed
  // the FIRST real login of a rapid back-to-back batch timing out waiting for
  // the post-login identity check, while every login right after it (same
  // code) succeeded normally — real staging-side slowness on a cold first
  // login, not a bug in this flow.
  context.setDefaultTimeout(35000);context.setDefaultNavigationTimeout(25000);
  await context.routeWebSocket(/.*/,socket=>socket.close());
  await context.route('**/*',async route=>{
   if(!permit(route.request().url(),route.request().method(),route.request().resourceType(),route.request().postData())){await route.abort('blockedbyclient');return;}
   await route.continue();
  });
  const page=await context.newPage();page.on('dialog',d=>void d.dismiss());
  await page.goto(STAGING+'/login',{waitUntil:'domcontentloaded'});
  const email=await field(page,'email');const password=await field(page,'password');const submit=await submitButton(page);
  await email.loc.fill(creds.username);await password.loc.fill(creds.password);await submit.loc.click();
  await assertIdentity(page,creds.username);
  await page.close();
  return await work(context);
 }finally{
  await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await proxy?.close().catch(()=>{});
 }
}
const withLoggedInMatterContext=work=>withLoggedInContext(permitMattersRequest,work);
// Delete handlers for resource-ownership's approved deletions (cleanup.mjs's
// runApprovedDeletions). Each runs one signed-in session per approved record,
// using the contacts policy plus the single DELETE shape above. A record whose
// type has no handler here is left approved and pending, never deleted.
export function lawcusDeleteHandlers(){
 return {
  contact:resource=>withLoggedInContext(permitContactsDeleteRequest,context=>deleteContactViaBrowser({context,uuid:resource.resource_id,expectedName:resource.display_name})),
 };
}
/** Creates a QA Person contact, then a Matter for it, in ONE signed-in session.
 * `onCreated(kind, uuid)` fires as soon as each record exists so a caller can
 * record ownership even if a later step throws. */
export async function runMatterCreationForNewContactCheck({apiContracts,firstName,lastName,matterName,onCreated=null}){
 return withLoggedInMatterContext(async context=>{
  const contact=await createContactViaBrowser({context,apiContracts,firstName,lastName});
  onCreated?.('contact',contact.uuid);
  const matter=await createMatterForContactViaBrowser({context,apiContracts,contact:{uuid:contact.uuid,searchText:lastName,displayName:`${firstName} ${lastName}`},matterName,onCreated:uuid=>onCreated?.('matter',uuid)});
  return {contact,matter};
 });
}
export async function runMatterMandatoryFieldValidationCheck(){
 return withLoggedInMatterContext(context=>verifyMatterMandatoryFieldValidationViaBrowser({context}));
}

// A sweep may only READ. Everything the Contacts/Matters policies allow beyond a
// plain read (creates, edits, the search boxes) is deliberately absent: the only
// non-GET requests are the tenant's own list endpoints with a paging body. The
// app's own PUT /settings/user is refused too, so a sweep leaves no trace on the
// account beyond signing in.
const SWEEP_LIST_PATHS=new Set(['/v2/contacts','/v2/matters','/v2/leads']);
const SWEEP_LIST_BODY_KEYS=new Set(['filters','pagination','multi_sorting','sort']);
export function permitSweepRequest(url,method,resourceType,postData){
 if(permitLiveRequest(url,method,resourceType))return true;
 let u;try{u=new URL(url);}catch{return false;}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.origin!==API_ORIGIN)return false;
 if(method!=='POST'||!SWEEP_LIST_PATHS.has(u.pathname))return false;
 try{const body=JSON.parse(postData||'');return Boolean(body)&&typeof body==='object'&&!Array.isArray(body)&&'pagination'in body&&Object.keys(body).every(k=>SWEEP_LIST_BODY_KEYS.has(k));}catch{return false;}
}
/** Signs in once and reads the tenant's list pages back to `cutoff`. Read-only. */
export async function runStagingSweepRead({cutoff}){
 return withLoggedInContext(permitSweepRequest,context=>readTenantLists({context,cutoff}));
}
