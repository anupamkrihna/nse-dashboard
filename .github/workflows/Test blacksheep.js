/* test_blacksheep.js — regression gate for BlackSheep.gs v1.0 (Session 1).
   Sources the PURE FUNCTIONS block verbatim from BlackSheep.gs so tests
   cannot drift from deployed code. Node-only — never deploy to GAS. */
var fs = require('fs');
var src = fs.readFileSync('BlackSheep.gs', 'utf8');
var m = src.match(/\/\* ══════════════ PURE FUNCTIONS[\s\S]*?(?=\/\* ══════════════ FETCHERS)/);
var cfg = src.match(/var BS_GAP_DAYS[\s\S]*?var BS_NEWS_MED[\s\S]*?\];/);
if (!m || !cfg) { console.error('✗ source blocks not found'); process.exit(1); }
eval(cfg[0]); eval(m[0]);

var n = 0, bad = 0;
function T(name, cond){ n++; if(!cond){ bad++; console.log('  ✗ ' + name); } }
var DAY = 86400, T0 = 1700000000; // arbitrary anchor

/* helper: build ts array with given calendar-day steps */
function series(steps){ var ts=[T0], i; for(i=0;i<steps.length;i++) ts.push(ts[ts.length-1]+steps[i]*DAY); return ts; }
function flat(len,v){ var a=[],i; for(i=0;i<len;i++) a.push(v); return a; }

/* ── Tier 1: clean stock ── */
(function(){
  var steps=[]; for(var i=0;i<249;i++) steps.push(i%5===4?3:1); // 250 bars, weekend-like gaps only
  var ts=series(steps), cl=flat(250,100), vo=flat(250,500000);
  var f=bsTier1Flags_(ts,cl,vo);
  T('clean 250-bar stock → zero flags', f.length===0);
  T('clean → CLEAN verdict', bsVerdict_(f)==='CLEAN');
})();

/* ── Tier 1: Gayatri pattern — long gap + 30% jump + few bars since ── */
(function(){
  var steps=[]; for(var i=0;i<199;i++) steps.push(1);  // 200 bars pre-gap
  steps.push(115);                                     // ~4-month suspension
  for(var k=0;k<69;k++) steps.push(1);                 // 70 bars post-relist
  var ts=series(steps);
  var cl=flat(201,100).concat(flat(69,100));
  cl[200]=65; for(var j=201;j<270;j++) cl[j]=65;       // −35% across the gap
  var vo=flat(270,500000);
  var f=bsTier1Flags_(ts,cl,vo);
  var codes=f.map(function(x){return x.code;});
  T('gayatri: GAP flagged',            codes.indexOf('GAP')>=0);
  T('gayatri: DISCONTINUITY flagged',  codes.indexOf('DISCONTINUITY')>=0);
  T('gayatri: FRESH_RELIST flagged',   codes.indexOf('FRESH_RELIST')>=0);
  T('gayatri: all three are HIGH',     f.filter(function(x){return x.sev==='HIGH';}).length>=3);
  T('gayatri: verdict BLACKSHEEP',     bsVerdict_(f)==='BLACKSHEEP');
})();

/* ── Tier 1: gap but small jump → GAP yes, DISCONTINUITY no ── */
(function(){
  var steps=[]; for(var i=0;i<299;i++) steps.push(1); steps.push(20);
  for(var k=0;k<219;k++) steps.push(1);                // 220 bars since gap ≥ 200
  var ts=series(steps), cl=flat(520,100), vo=flat(520,500000);
  cl[300]=110;                                          // +10% only
  var f=bsTier1Flags_(ts,cl,vo), codes=f.map(function(x){return x.code;});
  T('gap w/o jump: GAP only',           codes.indexOf('GAP')>=0 && codes.indexOf('DISCONTINUITY')<0);
  T('≥200 bars since gap: no FRESH_RELIST', codes.indexOf('FRESH_RELIST')<0);
})();

/* ── Tier 1: recent IPO — short history, no gap → MED only ── */
(function(){
  var steps=[]; for(var i=0;i<89;i++) steps.push(i%5===4?3:1);
  var ts=series(steps), f=bsTier1Flags_(ts,flat(90,100),flat(90,300000));
  T('young listing → YOUNG_LISTING MED', f.length===1 && f[0].code==='YOUNG_LISTING' && f[0].sev==='MED');
  T('young listing → GREY not BLACKSHEEP', bsVerdict_(f)==='GREY');
})();

/* ── Tier 1: thin volume ── */
(function(){
  var steps=[]; for(var i=0;i<249;i++) steps.push(i%5===4?3:1);
  var ts=series(steps), f=bsTier1Flags_(ts,flat(250,100),flat(250,4000));
  T('thin volume → THIN_VOLUME MED', f.some(function(x){return x.code==='THIN_VOLUME'&&x.sev==='MED';}));
})();

/* ── Tier 1: near-empty data ── */
T('3 bars → NO_DATA HIGH', bsTier1Flags_([T0,T0+DAY,T0+2*DAY],[1,1,1],[1,1,1])[0].code==='NO_DATA');

/* ── Tier 1: results-day ±20% move with NO gap must NOT flag ── */
(function(){
  var steps=[]; for(var i=0;i<249;i++) steps.push(i%5===4?3:1);
  var ts=series(steps), cl=flat(250,100); cl[120]=122; // +22% single day, no gap
  var f=bsTier1Flags_(ts,cl,flat(250,500000));
  T('big move without gap → no DISCONTINUITY', !f.some(function(x){return x.code==='DISCONTINUITY';}));
})();

/* ── Tier 3: headline scanner ── */
T('NCLT headline → HIGH',           (bsScanTitle_('NCLT approves withdrawal of insolvency against Gayatri Projects')||{}).sev==='HIGH');
T('going concern → HIGH',           (bsScanTitle_('Auditors flag going concern doubt at XYZ Ltd')||{}).sev==='HIGH');
T('trading suspension → HIGH',      (bsScanTitle_('Shares suspended from trading effective Dec 15')||{}).sev==='HIGH');
T('relisting → HIGH',               (bsScanTitle_('Gayatri Projects relisted; trading resumes April 9')||{}).sev==='HIGH');
T('SEBI penalty → MED',             (bsScanTitle_('SEBI penalty of Rs 25 lakh imposed on ABC promoters')||{}).sev==='MED');
T('ASM word-boundary → MED',        (bsScanTitle_('Stock moved to ASM stage II')||{}).sev==='MED');
T('"plasma" does not trip ASM',     bsScanTitle_('Company launches plasma therapy unit')===null);
T('"credited" does not trip ED',    bsScanTitle_('Dividend credited to shareholders')===null);
T('routine headline → null',        bsScanTitle_('XYZ Ltd reports 12% rise in Q1 net profit')===null);
T('rating downgrade → MED',         (bsScanTitle_('Crisil announces rating downgrade for DEF bonds')||{}).sev==='MED');
T('one-time settlement → MED',      (bsScanTitle_('Board approves one-time settlement with lenders')||{}).sev==='MED');

/* ── verdict rollup ── */
T('HIGH+MED → BLACKSHEEP', bsVerdict_([{sev:'MED'},{sev:'HIGH'}])==='BLACKSHEEP');
T('MED only → GREY',       bsVerdict_([{sev:'MED'}])==='GREY');
T('empty → CLEAN',         bsVerdict_([])==='CLEAN');

/* ── date helpers ── */
T('bsDate_ formats',  /^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/.test(bsDate_(T0)));
T('bsEtaDate_ formats', /^[A-Z][a-z]{2}-\d{4}$/.test(bsEtaDate_(T0, 130)));

/* ── Tier 2 (frontend, sourced from steam.html) ── */
(function(){
  var sh = fs.readFileSync('steam.html', 'utf8');
  var fm = sh.match(/function bsTier2_[\s\S]*?\n}/);
  if (!fm) { console.log('  ✗ bsTier2_ not found in steam.html'); bad++; n++; return; }
  var bsTier2_ = eval('(' + fm[0].replace('function bsTier2_', 'function ') + ')');
  var clean = { PE:22, SectorPE:25, ROE:16, DE_Ratio:0.6, PromoterQoQ:0.2 };
  T('tier2: healthy row → zero flags', bsTier2_(clean).length===0);
  T('tier2: negative PE → NO_EARNINGS MED', bsTier2_({PE:-4, SectorPE:20, ROE:5, DE_Ratio:1}).some(function(f){return f.code==='NO_EARNINGS'&&f.sev==='MED';}));
  T('tier2: blank PE → NO_EARNINGS', bsTier2_({PE:'', SectorPE:20, ROE:5, DE_Ratio:1}).some(function(f){return f.code==='NO_EARNINGS';}));
  T('tier2: PE 4x sector → PE_STRETCH', bsTier2_({PE:100, SectorPE:20, ROE:15, DE_Ratio:1}).some(function(f){return f.code==='PE_STRETCH';}));
  T('tier2: ROE −8 → NEG_ROE', bsTier2_({PE:15, SectorPE:20, ROE:-8, DE_Ratio:1}).some(function(f){return f.code==='NEG_ROE';}));
  T('tier2: D/E 5 → LEVERAGE HIGH', bsTier2_({PE:15, SectorPE:20, ROE:10, DE_Ratio:5}).some(function(f){return f.code==='LEVERAGE'&&f.sev==='HIGH';}));
  T('tier2: D/E 2.5 → LEVERAGE MED', bsTier2_({PE:15, SectorPE:20, ROE:10, DE_Ratio:2.5}).some(function(f){return f.code==='LEVERAGE'&&f.sev==='MED';}));
  T('tier2: promoter −4pp QoQ → PROMOTER_EXIT', bsTier2_({PE:15, SectorPE:20, ROE:10, DE_Ratio:1, PromoterQoQ:-4}).some(function(f){return f.code==='PROMOTER_EXIT';}));
  T('tier2: promoter −1pp is tolerated', !bsTier2_({PE:15, SectorPE:20, ROE:10, DE_Ratio:1, PromoterQoQ:-1}).length);
  T('tier2: null D/E does not flag (missing ≠ bad)', !bsTier2_({PE:15, SectorPE:20, ROE:10, DE_Ratio:null}).some(function(f){return f.code==='LEVERAGE';}));
  T('tier2: HDFC-Bank-style zero-promoter row not flagged', bsTier2_({PE:19, SectorPE:18, ROE:16, DE_Ratio:null, Promoter:0, PromoterQoQ:0}).length===0);
})();

console.log((bad ? '✗ ' + bad + ' of ' : '✓ all ') + n + ' assertions ' + (bad ? 'FAILED' : 'passed'));
process.exit(bad ? 1 : 0);
