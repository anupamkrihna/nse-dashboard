#!/usr/bin/env python3
"""
collect_sector_pe.py — maintain sector_pe.csv from niftyindices' P/E endpoint.

Runs on GitHub Actions (an unblocked IP — NSE/niftyindices refuse Google-cloud
and time out corporate VPNs, but GitHub's runners get through).

  Daily mode (default):  refetch the last few days, merge, dedup.
      python collect_sector_pe.py
  Backfill mode:         attempt a multi-year range in ONE shot. The download
      page caps at 1y, but the API endpoint takes an arbitrary range — this
      tests whether it honours it. Reports the verdict at the end.
      python collect_sector_pe.py --backfill --years 6

Output: sector_pe.csv  (Date + one P/E column per sector ticker), which the GAS
engine reads directly from raw.githubusercontent.com.
"""
import argparse, json, os, sys, time
from datetime import datetime, timedelta
import requests, pandas as pd

ENDPOINT = 'https://niftyindices.com/Backpage.aspx/getpepbHistoricaldataDBtoString'
HEADERS = {
    'Connection': 'keep-alive',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Content-Type': 'application/json; charset=UTF-8',
    'Origin': 'https://niftyindices.com',
    'Referer': 'https://niftyindices.com/reports/historical-data',
    'Accept-Language': 'en-US,en;q=0.9',
}

# ticker header the engine reads  ->  candidate niftyindices names (handles renames:
# Energy became "Oil & Gas"; Realty may appear as "REITs & Realty")
SECTORS = {
    '^CNXIT':      ['NIFTY IT'],
    '^CNXAUTO':    ['NIFTY AUTO'],
    '^CNXPHARMA':  ['NIFTY PHARMA'],
    '^CNXFMCG':    ['NIFTY FMCG'],
    '^CNXMETAL':   ['NIFTY METAL'],
    '^CNXENERGY':  ['NIFTY OIL & GAS', 'NIFTY ENERGY'],
    '^NSEBANK':    ['NIFTY BANK'],
    '^CNXREALTY':  ['NIFTY REALTY', 'NIFTY REITS & REALTY'],
    '^CNXPSUBANK': ['NIFTY PSU BANK'],
}
ORDER = ['^CNXIT','^CNXAUTO','^CNXPHARMA','^CNXFMCG','^CNXMETAL',
         '^CNXENERGY','^NSEBANK','^CNXREALTY','^CNXPSUBANK']


def make_session():
    s = requests.Session()
    s.headers.update(HEADERS)
    # Warm up so niftyindices sets its session cookies; without them the API POST
    # gets bounced to the 89 KB HTML page. Hit home, then the referer report page,
    # carrying cookies forward.
    for url in ('https://niftyindices.com/',
                'https://niftyindices.com/reports/historical-data'):
        try:
            s.get(url, timeout=30)
            time.sleep(1)
        except Exception as e:
            print(f'   warmup {url} -> {str(e)[:60]}')
    print(f'   session cookies: {list(s.cookies.keys()) or "NONE"}')
    return s


def _norm(c):
    return str(c).lower().replace(' ', '').replace('/', '').replace('_', '')


def pick_col(cols, *needles):
    for c in cols:
        if _norm(c) in needles:
            return c
    for c in cols:
        n = _norm(c)
        if all(x in n for x in needles):
            return c
    return None


def fetch_name(sess, name, start, end):
    body = {'cinfo': "{'name':'" + name + "','startDate':'" + start +
            "','endDate':'" + end + "','indexName':'" + name + "'}"}
    r = sess.post(ENDPOINT, json=body, timeout=45)
    r.raise_for_status()
    try:
        d = r.json().get('d')
    except Exception:
        # not JSON — niftyindices returned an HTML challenge/cookie page. Show what it was.
        snippet = (r.text or '')[:220].replace('\n', ' ').replace('\r', ' ')
        print(f'    HTTP {r.status_code}, {len(r.text or "")} bytes, non-JSON body: [{snippet}]')
        raise
    if not d:
        return None
    recs = json.loads(d)
    if not recs:
        return None
    df = pd.DataFrame.from_records(recs)
    dc, pc = pick_col(df.columns, 'date'), pick_col(df.columns, 'pe')
    if dc is None or pc is None:
        print('    columns were:', list(df.columns))
        return None
    out = df[[dc, pc]].copy()
    out.columns = ['Date', 'pe']
    out['Date'] = pd.to_datetime(out['Date'], dayfirst=True, errors='coerce')
    out['pe'] = pd.to_numeric(out['pe'], errors='coerce')
    return out.dropna(subset=['Date']).drop_duplicates('Date').set_index('Date')['pe']


def fetch_sector(sess, ticker, start, end):
    for name in SECTORS[ticker]:
        try:
            sr = fetch_name(sess, name, start, end)
            if sr is not None and len(sr):
                print(f'  ok   {ticker:12s} via "{name}"  {len(sr):5d} rows '
                      f'({sr.index.min().date()} .. {sr.index.max().date()})')
                return sr
        except Exception as e:
            print(f'  ..   {ticker:12s} "{name}" {str(e)[:60]}')
        time.sleep(1)
    print(f'  --   {ticker:12s} no data from {SECTORS[ticker]}')
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', default='sector_pe.csv')
    ap.add_argument('--backfill', action='store_true')
    ap.add_argument('--years', type=int, default=6)
    ap.add_argument('--days', type=int, default=10)
    a = ap.parse_args()

    end = datetime.today()
    start = end - (timedelta(days=365 * a.years + 2) if a.backfill else timedelta(days=a.days))
    s0, e0 = start.strftime('%d-%b-%Y'), end.strftime('%d-%b-%Y')
    print(('BACKFILL' if a.backfill else 'DAILY') + f'  pull {s0} -> {e0}\n')

    sess = make_session()
    fetched = {}
    for t in ORDER:
        sr = fetch_sector(sess, t, s0, e0)
        if sr is not None:
            fetched[t] = sr

    if not fetched:
        sys.exit('\nNothing fetched — endpoint unreachable/blocked from this runner, '
                 'or the response shape changed (see column dumps above).')

    fresh = pd.DataFrame(fetched)
    if os.path.exists(a.csv):
        old = pd.read_csv(a.csv, parse_dates=['Date']).set_index('Date')
        merged = fresh.combine_first(old)        # per-cell: prefer fresh, keep old where fresh missing
    else:
        merged = fresh
    merged = merged.sort_index()
    for t in ORDER:
        if t not in merged.columns:
            merged[t] = pd.NA
    merged = merged[ORDER].round(2)
    merged.index.name = 'Date'
    merged.to_csv(a.csv, date_format='%Y-%m-%d')

    span = (merged.index.max() - merged.index.min()).days
    print(f'\nWrote {a.csv}: {len(merged)} rows  '
          f'({merged.index.min().date()} .. {merged.index.max().date()})  '
          f'~{span // 365}y {span % 365}d span')
    if a.backfill:
        print('BACKFILL VERDICT: ' + ('multi-year history obtained — the API honoured the range ✓'
                                      if span > 400 else
                                      'endpoint returned only ~1y — deep history not available; '
                                      'forward daily accumulation will build it over time'))


if __name__ == '__main__':
    main()
