/* ═══════════════════════════════════════════════════════════════════════
   BlackSheep.gs — v1.4 (Session 2 — news demoted to informational context)
   Black Sheep detector for the Steam Gauge project.

   PURPOSE
   Catch "special situation" stocks (insolvency exits, relistings,
   suspensions, regulatory action) whose price/fundamental data LOOKS
   clean to the scoring engines but is economically discontinuous —
   the Gayatri Projects case.

   ── v1.4 (the decisive change) ──────────────────────────────────────
   Regulatory NEWS no longer drives the verdict at all. It is returned
   separately as `newsContext` for display, and the verdict comes from
   STRUCTURE only: Tier 1 (data integrity) + Tier 2 (fundamentals,
   frontend-side) + confirmed-subject CIRP-EXIT (BS_RESTRUCTURED).

   WHY: keyword matching on headlines is unwinnable (statutory auditor
   rotation reads as "auditor resigns"; GST input-tax-credit fraud reads
   as "ITC fraud"; banks appear in every insolvency story as creditors),
   AND — worse — bsNews_ degrades SILENTLY when Google News RSS throttles,
   so under a 799-name sweep many names got no news evaluated at all. That
   made the verdict depend on fetch luck: CLEAN could mean "sound data" or
   "news never ran", and the weekly drift diff churned on RSS availability
   instead of real deterioration. Structure is deterministic and is the
   only thing that actually corrupts an indicator, which is what the
   🐏/⚠/🟢 stamp exists to warn about. Headlines still surface in the UI.
   `newsOk` now reports whether the news fetch actually succeeded, so a
   silent degradation is visible instead of masquerading as clean.

   ── v1.3 (retained): a news hit no longer alone makes a stock
      BLACKSHEEP — EXCEPT a confirmed-subject CIRP/insolvency-EXIT hit
      (BS_RESTRUCTURED: "exits insolvency", "post-CIRP", "reconstitutes
      board", "insolvency withdrawal", "relisted after suspension"). That
      language marks a genuine fundamental discontinuity and is treated as
      structural-grade, so Gayatri reads BLACKSHEEP again even after its
      price gap ages out of the 2y window — while KOTAKBANK's "fraud case"
      (non-exit, → GREY) and ITC's unconfirmed fraud (→ GREY) do not.

   ── v1.2 CHANGES (why: a full-roster sweep flagged 219/799, incl. ITC,
      SBIN, KOTAKBANK, ASIANPAINT — the news tier was over-triggering) ──
   • VERDICT: a Tier-3 NEWS HIGH no longer alone makes a stock BLACKSHEEP.
     BLACKSHEEP now requires a STRUCTURAL Tier-1 HIGH (GAP / DISCONTINUITY /
     FRESH_RELIST / NO_DATA) — the only thing that actually corrupts the
     indicators. News HIGH (regulatory context, no data break) → GREY.
     Gayatri still reads BLACKSHEEP: it trips Tier-1 GAP, not news.
   • NEWS SUBJECT GUARD: bsScanTitle_ now judges whether the company is the
     SUBJECT of the regulatory action vs its INITIATOR/creditor. "SBI files
     insolvency plea against X" / "Kotak tags Y wilful defaulter" no longer
     flag the bank. Unconfirmed subject → capped at MED (caution), not HIGH.
   • TIGHTER KEYWORDS: bare 'fraud' and 'going concern' narrowed to genuine
     allegations / audit doubts (they were co-occurring in blue-chip news).
   • bsYahoo_ retries once on a non-200 → burst-load throttling no longer
     manufactures a false NO_DATA (which was a HIGH → false BLACKSHEEP).

   DESIGN — fully self-contained, additive (unchanged from v1.1)
   • Every symbol here is prefixed bs / BS_ — zero collisions.
   • The ONLY touch to existing code is ONE line at the top of doGet in
     Code.gs (see ROUTER INSERTION).

   ROUTER INSERTION — add as the FIRST line inside doGet(e) in Code.gs:
     if (e && e.parameter && e.parameter.action === 'blacksheep') return bsRoute_(e);

   API
     GET ?action=blacksheep&sym=GAYAPROJ[&name=Gayatri%20Projects][&yf=GAYAPROJ.NS][&nocache=1]
     → { ok:true, sym, verdict:'CLEAN'|'GREY'|'BLACKSHEEP',
         flags:[{tier,sev,code,text,date?,url?}],      // verdict-bearing ONLY
         newsContext:[{tier:3,sev,code:'NEWS',label,text,date,url}],  // display only
         newsOk:true|false,                            // false = RSS fetch failed/throttled
         bars, lastBar, checkedAt, cached }

   TIERS
     Tier 1 — data integrity from Yahoo daily bars (2y):
       NO_DATA / DISCONTINUITY / GAP / FRESH_RELIST  HIGH (structural)
       YOUNG_LISTING / THIN_VOLUME                    MED
     Tier 3 — government / regulatory news via Google News RSS:
       NEWS  HIGH/MED  keyword hits on headlines ≤ 24 months old
                       (HIGH now contributes GREY, not BLACKSHEEP)
   Tier 2 (PE / ROE / D/E / promoter) is computed FRONTEND-side in steam.html.

   VERDICT ROLLUP (v1.4):
     any STRUCTURAL HIGH (Tier-1, or confirmed CIRP-exit) → BLACKSHEEP
     else any MED (young listing / thin volume)           → GREY
     else CLEAN
     (informational news is ignored entirely by the rollup)
   CACHE: CacheService 6h per symbol (bust with &nocache=1).
   ═══════════════════════════════════════════════════════════════════════ */

var BS_GAP_DAYS   = 14;     // calendar days between consecutive bars ≈ 10 sessions
var BS_JUMP_PCT   = 0.25;   // discontinuity threshold across a gap
var BS_MIN_BARS   = 200;    // bars needed for a trustworthy 200 DMA
var BS_THIN_VOL   = 10000;  // median shares/day floor
var BS_NEWS_MONTHS= 24;     // news lookback
var BS_CACHE_SEC  = 21600;  // 6h

/* ── keyword directories (word-boundary regexes, case-insensitive) ── */
var BS_NEWS_HIGH = [
  ['insolvency',            'insolvency proceedings'],
  ['nclt',                  'NCLT action'],
  ['cirp',                  'CIRP (corporate insolvency resolution)'],
  ['resolution professional','resolution professional appointed'],
  ['liquidation',           'liquidation'],
  ['going.?concern[^.]{0,25}(doubt|uncertaint|qualif|material|risk|emphasis)', 'going-concern doubt'],
  ['(accounting|financial|corporate|securities|accounts?) fraud|fraud (case|charge|probe|scam|investigation|conviction|indictment)|(accused|charged|booked|indicted|convicted|guilty)[^.]{0,30}fraud', 'fraud allegation'],
  ['wilful default(er)?',   'wilful defaulter tag'],
  ['debt default',          'debt default'],
  ['defaults? on (loan|payment|interest|dues)', 'payment default'],
  ['suspend(ed|s)? (from )?trading', 'trading suspension'],
  ['trading suspension',    'trading suspension'],
  ['delist(ed|ing)?',       'delisting'],
  ['auditor(s)? resign',    'auditor resignation'],
  ['forensic audit',        'forensic audit ordered'],
  ['relist(ed|ing)',        'relisting after suspension']
];
var BS_NEWS_MED = [
  ['sebi (order|penalt\\w*|bars?|ban(s|ned)?|probe)', 'SEBI action'],
  ['\\bgsm\\b',             'GSM surveillance list'],
  ['\\basm\\b',             'ASM surveillance list'],
  ['surveillance measure',  'exchange surveillance'],
  ['promoter(s)? pledge',   'promoter share pledge'],
  ['\\bed\\b (raid|probe|attach)', 'ED action'],
  ['\\bcbi\\b (raid|probe|books?|case)', 'CBI action'],
  ['income tax raid',       'IT raid'],
  ['show.?cause notice',    'show-cause notice'],
  ['rating downgrade',      'credit rating downgrade'],
  ['one.?time settlement',  'one-time settlement with lenders']
];

/* RESTRUCTURING-EXIT vocabulary (v1.3) — a company that has just emerged from a
   CIRP / insolvency resolution is a genuine fundamental discontinuity even after
   its price gap ages out of Yahoo's 2y window (the present-day Gayatri case).
   These are deliberately narrow: only a firm that actually went through and
   exited resolution produces this language, so a confirmed-subject hit here is
   treated as STRUCTURAL-grade (→ BLACKSHEEP), unlike generic regulatory news.
   No healthy bank/blue-chip headline matches these. */
var BS_RESTRUCTURED = [
  ['exit(s|ed|ing)? insolvency|emerge[sd]? from insolvency|out of insolvency', 'exited insolvency resolution'],
  ['post.?cirp', 'post-CIRP — fresh out of resolution'],
  ['withdrawal of insolvency|insolvency withdrawal|withdraw\\w* .{0,15}insolvency', 'insolvency proceedings withdrawn'],
  ['reconstitut\\w+ board', 'board reconstituted post-insolvency'],
  ['relist(ed|ing)? after|resume[sd]? trading|revoke[sd]? .{0,12}suspension|trading resume', 'relisted / trading resumed after suspension']
];

/* verbs a company performs AS the creditor / initiator of an action — when the
   company name precedes one of these before the regulatory keyword, the story
   is about someone else (its borrower), so it is NOT a black-sheep signal. */
var BS_CREDITOR_CUE = /\b(files?|filed|filing|moves?|moved|drags?|dragged|approach\w+|seeks?|sought|initiat\w+|tags?|tagged|flags?|flagged|declares?|declared|names?|named|recovers?|recovered|invokes?|invoked|admits?|admitted|hauls?|hauled|summons?|summoned|lends?|lent)\b/;

/* ══════════════ PURE FUNCTIONS (Node-tested in test_blacksheep.js) ══════════════ */

/* Tier-1 flags from parallel arrays of unix-second timestamps, closes, volumes.
   Bars must be chronological. Returns array of flag objects. */
function bsTier1Flags_(ts, close, vol) {
  var flags = [], n = ts.length;
  if (n < 5) {
    flags.push({ tier:1, sev:'HIGH', code:'NO_DATA', text:'fewer than 5 daily bars returned — price history unusable' });
    return flags;
  }
  var DAY = 86400, lastGapIdx = -1, worstGap = 0, worstGapAt = -1;
  for (var i = 1; i < n; i++) {
    var dDays = (ts[i] - ts[i-1]) / DAY;
    if (dDays >= BS_GAP_DAYS) {
      if (dDays > worstGap) { worstGap = dDays; worstGapAt = i; }
      lastGapIdx = i;
      var jump = (close[i-1] > 0 && close[i] > 0) ? Math.abs(close[i] / close[i-1] - 1) : 0;
      if (dDays >= 7 && jump >= BS_JUMP_PCT) {
        flags.push({ tier:1, sev:'HIGH', code:'DISCONTINUITY',
          text:'price discontinuity: ' + Math.round(jump*100) + '% jump across a ' + Math.round(dDays) + '-day gap (' + bsDate_(ts[i-1]) + ' → ' + bsDate_(ts[i]) + ') — equity likely restructured' });
      }
    }
  }
  if (lastGapIdx >= 0) {
    flags.push({ tier:1, sev:'HIGH', code:'GAP',
      text:'trading gap of ' + Math.round(worstGap) + ' calendar days ending ' + bsDate_(ts[worstGapAt]) + ' — suspension fingerprint' });
    var barsSince = n - lastGapIdx;
    if (barsSince < BS_MIN_BARS) {
      flags.push({ tier:1, sev:'HIGH', code:'FRESH_RELIST',
        text:'only ' + barsSince + ' completed bars since the last gap — 200 DMA and long indicators blend pre/post-event prices until ~' + bsEtaDate_(ts[n-1], BS_MIN_BARS - barsSince) });
    }
  } else if (n < BS_MIN_BARS) {
    flags.push({ tier:1, sev:'MED', code:'YOUNG_LISTING',
      text:'only ' + n + ' bars of history (recent listing) — long-window indicators not yet meaningful' });
  }
  var v = [], from = Math.max(0, n - 60);
  for (var j = from; j < n; j++) if (vol[j] != null) v.push(vol[j]);
  if (v.length >= 20) {
    v.sort(function(a,b){ return a - b; });
    var med = v[Math.floor(v.length / 2)];
    if (med < BS_THIN_VOL) {
      flags.push({ tier:1, sev:'MED', code:'THIN_VOLUME',
        text:'median volume ~' + med.toLocaleString('en-IN') + ' shares/day (last 60 bars) — illiquid; prices and signals unreliable' });
    }
  }
  return flags;
}

/* most distinctive lowercased token of a company name (len≥4, not a stop-word),
   used to locate the company within a headline. '' if none found. */
function bsNameToken_(name) {
  var stop = { bank:1, india:1, indian:1, limited:1, ltd:1, corporation:1, corp:1, company:1,
    industries:1, enterprises:1, finance:1, financial:1, services:1, holdings:1, group:1,
    national:1, general:1, life:1, insurance:1, power:1, motors:1, steel:1, energy:1, cement:1 };
  var words = bsNorm_(name).split(' ');
  for (var i = 0; i < words.length; i++) if (words[i].length >= 4 && !stop[words[i]]) return words[i]; // first distinctive token = the brand
  return '';
}

/* Scan one headline for the strongest regulatory hit, judging whether the
   company is the SUBJECT of the action (a sheep signal) or its INITIATOR /
   creditor (a bank filing against a borrower — NOT a signal).
   Returns {sev,label} for the strongest qualifying hit, or null. */
function bsScanTitle_(title, name) {
  var t = ' ' + String(title || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  var tok = bsNameToken_(name);
  var nameIdx = tok ? t.indexOf(tok) : -1;
  var againstIdx = t.indexOf(' against ');

  function subjectOf(kwIdx) {
    if (againstIdx >= 0) {                                          // "…<action>… against <someone>"
      if (nameIdx >= 0 && nameIdx > againstIdx) return 'subject';   // company named after "against" = the target
      return 'creditor';                                           // company is the initiator, or target is a third party
    }
    var cm = BS_CREDITOR_CUE.exec(t);                              // company performs a creditor verb before the keyword
    if (cm && nameIdx >= 0 && nameIdx <= cm.index && cm.index < kwIdx) return 'creditor';
    if (nameIdx >= 0) return 'subject';
    return 'unknown';
  }

  for (var r = 0; r < BS_RESTRUCTURED.length; r++) {              // v1.3: CIRP-exit → structural-grade
    var mr = new RegExp(BS_RESTRUCTURED[r][0], 'i').exec(t);
    if (mr) {
      var sr = subjectOf(mr.index);
      if (sr === 'creditor') continue;
      if (sr === 'unknown') return { sev:'MED', label:BS_RESTRUCTURED[r][1] + ' — subject unconfirmed' };
      return { sev:'HIGH', struct:true, label:BS_RESTRUCTURED[r][1] };
    }
  }
  for (var i = 0; i < BS_NEWS_HIGH.length; i++) {
    var mh = new RegExp(BS_NEWS_HIGH[i][0], 'i').exec(t);
    if (mh) {
      var st = subjectOf(mh.index);
      if (st === 'creditor') continue;                             // lender/initiator → drop this hit
      if (st === 'unknown') return { sev:'MED', label:BS_NEWS_HIGH[i][1] + ' — subject unconfirmed' };
      return { sev:'HIGH', label:BS_NEWS_HIGH[i][1] };
    }
  }
  for (var k = 0; k < BS_NEWS_MED.length; k++)
    if (new RegExp(BS_NEWS_MED[k][0], 'i').test(t)) return { sev:'MED', label:BS_NEWS_MED[k][1] };
  return null;
}

/* Roll flags up to a verdict (v1.2 — only a STRUCTURAL Tier-1 HIGH is a sheep;
   news HIGH is regulatory context → caps at GREY). */
function bsVerdict_(flags) {
  var structuralHigh = false, med = false;
  for (var i = 0; i < flags.length; i++) {
    var f = flags[i];
    if (f.tier === 3 && !f.struct) continue;      // v1.4: informational news never drives the verdict
    if (f.sev === 'HIGH') structuralHigh = true;
    else if (f.sev === 'MED') med = true;
  }
  if (structuralHigh) return 'BLACKSHEEP';
  if (med) return 'GREY';
  return 'CLEAN';
}

function bsDate_(unixSec) {
  var d = new Date(unixSec * 1000);
  return d.getUTCDate() + '-' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()] + '-' + d.getUTCFullYear();
}
function bsEtaDate_(lastBarUnixSec, barsNeeded) {
  var d = new Date(lastBarUnixSec * 1000 + barsNeeded * 1.45 * 86400000); // ~1.45 cal days per trading day
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()] + '-' + d.getUTCFullYear();
}
function bsNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60); }

/* ══════════════ FETCHERS (GAS-only) ══════════════ */

function bsYahoo_(sym, yfHint) {
  var cands = [];
  if (yfHint) cands.push(yfHint);
  cands.push(sym + '.NS', sym + '.BO');
  var opts = { muteHttpExceptions:true, headers:{ 'User-Agent':'Mozilla/5.0' } };
  for (var i = 0; i < cands.length; i++) {
    try {
      var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(cands[i]) + '?range=2y&interval=1d&events=div%2Csplit';
      var res = UrlFetchApp.fetch(url, opts);
      if (res.getResponseCode() !== 200) { Utilities.sleep(700); res = UrlFetchApp.fetch(url, opts); }  // v1.2: retry once — burst-load throttling must not read as NO_DATA
      if (res.getResponseCode() !== 200) continue;
      var j = JSON.parse(res.getContentText());
      var r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp || !r.timestamp.length) continue;
      var q = r.indicators.quote[0];
      var adj = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || q.close;
      var ts = [], cl = [], vo = [];
      for (var k = 0; k < r.timestamp.length; k++) {
        if (adj[k] == null) continue;
        ts.push(r.timestamp[k]); cl.push(adj[k]); vo.push(q.volume ? q.volume[k] : null);
      }
      if (ts.length) return { ticker:cands[i], ts:ts, close:cl, vol:vo };
    } catch (err) { /* try next candidate */ }
  }
  return null;
}

function bsNews_(name, sym) {
  var q = '"' + (name || sym) + '"';
  var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-IN&gl=IN&ceid=IN:en';
  var flags = [], seen = {}, okFetch = false;
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions:true });
    if (res.getResponseCode() !== 200) return { ok:false, items:flags };   // v1.4: report the failure instead of hiding it
    okFetch = true;
    var doc = XmlService.parse(res.getContentText());
    var items = doc.getRootElement().getChild('channel').getChildren('item');
    var cutoff = Date.now() - BS_NEWS_MONTHS * 30.44 * 86400000;
    for (var i = 0; i < items.length && flags.length < 8; i++) {
      var title = items[i].getChildText('title') || '';
      var pub = new Date(items[i].getChildText('pubDate') || 0).getTime();
      if (pub && pub < cutoff) continue;
      var hit = bsScanTitle_(title, name || sym);          // v1.2: pass the name so the subject guard can run
      if (!hit) continue;
      var key = hit.label + '|' + bsNorm_(title).slice(0, 30);
      if (seen[key]) continue;
      seen[key] = 1;
      flags.push({ tier:3, sev:hit.sev, code:(hit.struct ? 'RESTRUCTURED' : 'NEWS'), struct:!!hit.struct, label:hit.label, text:title,
        date: pub ? new Date(pub).toISOString().slice(0,10) : null,
        url: items[i].getChildText('link') || null });
    }
  } catch (err) { return { ok:okFetch, items:flags }; }   // parse failure mid-stream: keep what we got, flag the degradation
  return { ok:true, items:flags };
}

/* ══════════════ ROUTE ══════════════ */

function bsRoute_(e) {
  var p = e.parameter || {};
  var sym = String(p.sym || p.symbol || '').toUpperCase().trim().replace(/\.(NS|BO)$/, '');
  var out;
  if (!sym) {
    out = { ok:false, error:'sym required' };
  } else {
    var cacheKey = 'bs_' + sym, cache = CacheService.getScriptCache();
    var hit = (p.nocache ? null : cache.get(cacheKey));
    if (hit) {
      out = JSON.parse(hit); out.cached = true;
    } else {
      var flags = [];
      var y = bsYahoo_(sym, p.yf ? String(p.yf) : null);
      if (!y) {
        flags.push({ tier:1, sev:'HIGH', code:'NO_DATA', text:'no price data from Yahoo for ' + sym + ' (.NS/.BO) — unlisted, suspended, or ticker changed' });
      } else {
        flags = flags.concat(bsTier1Flags_(y.ts, y.close, y.vol));
      }
      var news = bsNews_(p.name ? String(p.name) : null, sym);
      var newsCtx = [];
      news.items.forEach(function (f) {
        if (f.struct) flags.push(f);        // confirmed CIRP-exit = structural, verdict-bearing
        else newsCtx.push(f);               // everything else = display-only context
      });
      out = {
        ok:true, sym:sym, v:'bs1.4',
        verdict: bsVerdict_(flags),
        flags: flags,
        newsContext: newsCtx,
        newsOk: news.ok,
        bars: y ? y.ts.length : 0,
        ticker: y ? y.ticker : null,
        lastBar: y ? bsDate_(y.ts[y.ts.length-1]) : null,
        checkedAt: new Date().toISOString(),
        cached:false
      };
      try { cache.put(cacheKey, JSON.stringify(out), BS_CACHE_SEC); } catch (err) { /* >100KB payloads skip cache */ }
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* Manual smoke test — run from the GAS editor, check the log. */
function bsSmokeTest() {
  ['GAYAPROJ|Gayatri Projects', 'ITC|ITC', 'SBIN|State Bank of India', 'KOTAKBANK|Kotak Mahindra Bank'].forEach(function (pair) {
    var pr = pair.split('|');
    Logger.log(bsRoute_({ parameter: { action:'blacksheep', sym:pr[0], name:pr[1], nocache:'1' } }).getContent());
  });
}
