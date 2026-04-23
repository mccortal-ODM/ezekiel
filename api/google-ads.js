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

  const { customerId, dateFrom, dateTo } = req.body;
  if (!customerId || !dateFrom || !dateTo) return res.status(400).json({ error: 'Missing required params' });

  const mcc = (process.env.GOOGLE_MCC_ID || '').replace(/-/g, '');
  const devToken = process.env.GOOGLE_DEVELOPER_TOKEN;
  const cid = customerId.replace(/-/g, '');

  try {
    const token = await refreshToken();
    const url = `https://googleads.googleapis.com/v20/customers/${cid}/googleAds:search`;

    async function q(gaql) {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'developer-token': devToken,
          'login-customer-id': mcc,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: gaql })
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error?.message || JSON.stringify(d.error));
      return d.results || [];
    }

    const [campaigns, convActions, keywords] = await Promise.all([
      q(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
              metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions,
              metrics.conversions_value, metrics.ctr
         FROM campaign
         WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
           AND campaign.status IN (ENABLED, PAUSED)`),
      q(`SELECT conversion_action.id, conversion_action.name,
              conversion_action.counting_type, conversion_action.category
         FROM conversion_action
         WHERE conversion_action.status = ENABLED`),
      q(`SELECT keyword_view.resource_name,
              ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
              campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions
         FROM keyword_view
         WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
           AND ad_group_criterion.status = ENABLED
         ORDER BY metrics.cost_micros DESC LIMIT 20`).catch(() => [])
    ]);

    res.json({ campaigns, convActions, keywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
