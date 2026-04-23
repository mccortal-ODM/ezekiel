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
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('Google OAuth: תשובה לא תקינה מהשרת (' + r.status + ')'); }
  if (d.error) throw new Error('Google OAuth: ' + (d.error_description || d.error));
  return d.access_token;
}

function parseGA4(report) {
  if (!report.rows) return [];
  const dh = (report.dimensionHeaders || []).map(h => h.name);
  const mh = (report.metricHeaders || []).map(h => h.name);
  return report.rows.map(row => {
    const rec = {};
    (row.dimensionValues || []).forEach((d, i) => rec[dh[i]] = d.value);
    (row.metricValues || []).forEach((m, i) => rec[mh[i]] = parseFloat(m.value) || 0);
    return rec;
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { propertyId, dateFrom, dateTo } = req.body;
  if (!propertyId || !dateFrom || !dateTo) return res.status(400).json({ error: 'Missing required params' });

  try {
    const token = await refreshToken();
    const normalizedId = propertyId.replace(/^properties\//, '');
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${normalizedId}:runReport`;

    async function report(dims, mets) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
          dimensions: dims.map(d => ({ name: d })),
          metrics: mets.map(m => ({ name: m })),
          limit: 100
        })
      });
      const d = await r.json();
      if (d.error) throw new Error('GA4: ' + (d.error.message || JSON.stringify(d.error)));
      return parseGA4(d);
    }

    // Ecommerce funnel: event counts for key purchase-funnel events
    async function funnelReport() {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'] }
            }
          },
          limit: 10
        })
      });
      const d = await r.json();
      if (d.error) return null;
      const rows = parseGA4(d);
      const funnel = {};
      rows.forEach(row => { funnel[row.eventName] = row.eventCount || 0; });
      return funnel;
    }

    const [overview, devices, channels, sources, campaigns, funnel] = await Promise.all([
      report([], ['sessions', 'activeUsers', 'newUsers', 'conversions', 'totalRevenue', 'engagementRate', 'bounceRate']),
      report(['deviceCategory'], ['sessions', 'activeUsers', 'conversions', 'totalRevenue', 'sessionConversionRate', 'bounceRate']),
      report(['sessionDefaultChannelGroup'], ['sessions', 'conversions', 'totalRevenue', 'sessionConversionRate']),
      report(['sessionSourceMedium'], ['sessions', 'conversions', 'totalRevenue', 'sessionConversionRate']),
      report(['sessionCampaignName'], ['sessions', 'conversions', 'totalRevenue', 'sessionConversionRate']),
      funnelReport()
    ]);

    res.json({ overview: overview[0] || {}, devices, channels, sources, campaigns, funnel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
