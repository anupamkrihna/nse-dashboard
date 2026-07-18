/* Extract of the PURE reg* functions from MarketRegime.gs — proves the
   shipped math independently of GAS globals. */
function regClean_(arr){var o=[];for(var i=0;i<arr.length;i++){var v=arr[i];if(v!=null&&isFinite(v)&&v>0)o.push(v);}return o;}
function regEma_(vals,p){if(!vals||!vals.length)return[];var k=2/(p+1),o=[vals[0]];for(var i=1;i<vals.length;i++)o.push(vals[i]*k+o[i-1]*(1-k));return o;}
function regSmaLast_(vals,p){if(!vals||vals.length<p)return null;var s=0;for(var i=vals.length-p;i<vals.length;i++)s+=vals[i];return s/p;}
function regTrendState_(closes){
  if(!closes||closes.length<200)return{state:'unknown',score:0.5};
  var e20=regEma_(closes,20),e50=regEma_(closes,50),e200=regEma_(closes,200);
  var px=closes[closes.length-1],a=e20[e20.length-1],b=e50[e50.length-1],c=e200[e200.length-1];
  if(px>a&&a>b&&b>c)return{state:'bull_stack',score:1.00};
  if(px<a&&a<b&&b<c)return{state:'bear_stack',score:0.00};
  if(px>b&&b>c)return{state:'up',score:0.75};
  if(px>c)return{state:'above_200',score:0.55};
  if(b>c)return{state:'rolling',score:0.30};
  return{state:'down',score:0.15};
}
function regBreadth_(panel){var above=0,counted=0;for(var i=0;i<panel.length;i++){var s=panel[i],sma=regSmaLast_(s,200);if(sma==null)continue;counted++;if(s[s.length-1]>=sma)above++;}return{pct:counted?above/counted:null,counted:counted};}
function regPctileLast_(series,win){if(!series||series.length<20)return null;var w=Math.min(win||series.length,series.length),slice=series.slice(series.length-w),last=slice[slice.length-1],below=0;for(var i=0;i<slice.length;i++)if(slice[i]<last)below++;return below/slice.length;}
var REGIME_CFG={wTrend:0.40,wBreadth:0.35,wVol:0.25,onScore:0.70,onVixMax:0.75,offScore:0.35,stressVix:0.85,stressBreadth:0.35,riskOffBreadth:0.40};
function regRound_(n,dp){if(n==null||!isFinite(n))return null;var f=Math.pow(10,dp||3);return Math.round(n*f)/f;}
function regClassify_(trend,breadthPct,vixPctile,cfg){
  cfg=cfg||REGIME_CFG;
  var tScore=(trend&&typeof trend.score==='number')?trend.score:0.5;
  var bScore=(breadthPct==null)?0.5:breadthPct;
  var vScore=(vixPctile==null)?0.5:(1-vixPctile);
  var composite=cfg.wTrend*tScore+cfg.wBreadth*bScore+cfg.wVol*vScore;
  var tState=trend?trend.state:'unknown',regime,headline;
  if(vixPctile!=null&&breadthPct!=null&&vixPctile>=cfg.stressVix&&breadthPct<cfg.stressBreadth){
    regime='stress';headline='Fear spike with broad washout — capitulation zone; the state that precedes a sector-recovery leadership call.';
  }else if(composite<=cfg.offScore||(tState==='bear_stack'&&(breadthPct!=null&&breadthPct<cfg.riskOffBreadth))){
    regime='risk_off';headline='Deteriorating trend and participation — defense; expect SectorRotation to read "falling". Long setups are lower-odds.';
  }else if(composite>=cfg.onScore&&(vixPctile==null||vixPctile<cfg.onVixMax)){
    regime='risk_on';headline='Broad uptrend, healthy participation, calm vol — trend-following favored; A-grade Indicator longs are trustworthy.';
  }else{
    regime='neutral';headline='Mixed / rangebound — chop-prone. Hazard flags do the heavy lifting; expect fewer A-grade setups by design.';
  }
  return{regime:regime,score:regRound_(composite,3),headline:headline,components:{
    trend:{state:tState,score:regRound_(tScore,3)},
    breadth:{pctAbove200:(breadthPct==null?null:regRound_(breadthPct,3)),score:regRound_(bScore,3)},
    vol:{vixPctile:(vixPctile==null?null:regRound_(vixPctile,3)),score:regRound_(vScore,3)}
  }};
}

/* ---- assertions ---- */
var pass=0,fail=0;
function ok(n,c){if(c)pass++;else{fail++;console.log('  x '+n);}}
function approx(a,b,t){return Math.abs(a-b)<=(t||1e-9);}
function ramp(n,s,st){var a=[];for(var i=0;i<n;i++)a.push(s+i*st);return a;}
function drop(n,s,st){var a=[];for(var i=0;i<n;i++)a.push(s-i*st);return a;}
function flat(n,v){var a=[];for(var i=0;i<n;i++)a.push(v);return a;}
ok('clean drops nulls/neg',regClean_([1,null,-2,3,0,4]).length===3);
ok('rising=>bull',regTrendState_(ramp(300,100,1)).state==='bull_stack');
ok('falling=>bear',regTrendState_(drop(300,500,1)).state==='bear_stack');
ok('short=>unknown',regTrendState_(ramp(50,100,1)).state==='unknown');
var bp=regBreadth_([ramp(300,100,1),drop(300,500,1),ramp(300,50,2),flat(50,9)]);
ok('breadth skips short',bp.counted===3);
ok('breadth=2/3',approx(bp.pct,2/3));
ok('pctile max high',regPctileLast_(ramp(500,1,1),500)>0.99);
ok('vix spike high',regPctileLast_(flat(480,12).concat([40]),500)>0.99);
var bull={state:'bull_stack',score:1.0},bear={state:'bear_stack',score:0.0};
ok('risk_on',regClassify_(bull,0.80,0.20).regime==='risk_on');
ok('neutral',regClassify_({state:'above_200',score:0.55},0.55,0.50).regime==='neutral');
ok('risk_off',regClassify_(bear,0.30,0.55).regime==='risk_off');
ok('stress override',regClassify_(bear,0.20,0.92).regime==='stress');
ok('risk_on blocked hi vix',regClassify_(bull,0.80,0.80).regime!=='risk_on');
ok('composite max 1',approx(regClassify_(bull,1.0,0.0).score,1.0));
ok('composite min 0',approx(regClassify_(bear,0.0,1.0).score,0.0));
ok('null breadth ok',!!regClassify_(bull,null,0.2).regime);
ok('all null=>neutral',regClassify_({state:'unknown',score:0.5},null,null).regime==='neutral');
ok('echo breadth',approx(regClassify_(bull,0.8,0.2).components.breadth.pctAbove200,0.8));
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
