async function refreshToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }).toString()
  });
  const d = await r.json();
  if (d.error) throw new Error('Google OAuth: ' + (d.error_description || d.error));
  return d.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { metaId, googleId, ga4Id, dateFrom, dateTo } = req.body;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Missing dateFrom/dateTo' });

  const results = { meta: null, google: null, ga4: null };

  // Refresh Google token once if needed
  let googleToken = null;
  if (googleId || ga4Id) {
    try { googleToken = await refreshToken(); } catch (e) { /* skip google/ga4 monthly */ }
  }

  await Promise.all([
    // META monthly
    metaId ? (async () => {
      try {
        const token = process.env.META_ACCESS_TOKEN;
        const base = 'https://graph.facebook.com/v21.0';
        const timeRange = JSON.stringify({ since: dateFrom, until: dateTo });
        const url = new URL(base + '/' + metaId + '/insights');
        Object.entries({
          fields: 'spend,impressions,clicks,actions',
          time_range: timeRange,
          time_increment: 'monthly',
          level: 'account',
          access_token: token
        }).forEach(([k, v]) => url.searchParams.set(k, v));
        const r = await (await fetch(url.toString())).json();
        results.meta = r.data || [];
      } catch (e) { /* skip */ }
    })() : Promise.resolve(),

    // GOOGLE ADS monthly
    (googleId && googleToken) ? (async () => {
      try {
        const devToken = process.env.GOOGLE_DEVELOPER_TOKEN;
        const mcc = (process.env.GOOGLE_MCC_ID || '').replace(/-/g, '');
        const cid = googleId.replace(/-/g, '');
        const url = `https://googleads.googleapis.com/v20/customers/${cid}/googleAds:search`;
        const gaql = `SELECT segments.month, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.impressions
                      FROM campaign
                      WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
                      ORDER BY segments.month`;
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + googleToken,
            'developer-token': devToken,
            'login-customer-id': mcc,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query: gaql })
        });
        const data = await r.json();
        const byMonth = {};
        (data.results || []).forEach(row => {
          const m = row.segments?.month?.split('T')[0]?.slice(0, 7) || 'unknown';
          if (!byMonth[m]) byMonth[m] = { spend: 0, clicks: 0, conversions: 0, impressions: 0 };
          byMonth[m].spend += (row.metrics?.costMicros || 0) / 1e6;
          byMonth[m].clicks += row.metrics?.clicks || 0;
          byMonth[m].conversions += row.metrics?.conversions || 0;
          byMonth[m].impressions += row.metrics?.impressions || 0;
        });
        results.google = byMonth;
      } catch (e) { /* skip */ }
    })() : Promise.resolve(),

    // GA4 monthly
    (ga4Id && googleToken) ? (async () => {
      try {
        const propId = ga4Id.replace('properties/', '');
        const ga4Url = `https://analyticsdata.googleapis.com/v1beta/properties/${propId}:runReport`;
        const r = await fetch(ga4Url, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + googleToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
            dimensions: [{ name: 'yearMonth' }],
            metrics: [{ name: 'sessions' }, { name: 'conversions' }, { name: 'activeUsers' }]
          })
        });
        const data = await r.json();
        results.ga4 = (data.rows || []).map(row => ({
          month: row.dimensionValues?.[0]?.value || '',
          sessions: parseInt(row.metricValues?.[0]?.value || 0),
          conversions: parseInt(row.metricValues?.[1]?.value || 0),
          users: parseInt(row.metricValues?.[2]?.value || 0)
        }));
      } catch (e) { /* skip */ }
    })() : Promise.resolve()
  ]);

  if (!results.meta && !results.google && !results.ga4) {
    return res.json(null);
  }
  res.json(results);
}
