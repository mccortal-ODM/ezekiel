export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accountId, dateFrom, dateTo } = req.body;
  if (!accountId || !dateFrom || !dateTo) return res.status(400).json({ error: 'Missing required params' });

  const token = process.env.META_ACCESS_TOKEN;
  const base = 'https://graph.facebook.com/v21.0';
  const timeRange = JSON.stringify({ since: dateFrom, until: dateTo });

  async function get(path, params) {
    const url = new URL(base + path);
    Object.entries({ ...params, access_token: token }).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const r = await fetch(url.toString());
    const d = await r.json();
    if (d.error) throw new Error('Meta API: ' + (d.error.message || JSON.stringify(d.error)));
    return d;
  }

  try {
    const [accountRes, campaignsRes, pixelsRes, adsRes] = await Promise.all([
      get('/' + accountId + '/insights', {
        fields: 'spend,impressions,reach,clicks,ctr,cpc,frequency,actions,action_values',
        time_range: timeRange,
        level: 'account'
      }),
      get('/' + accountId + '/insights', {
        fields: 'campaign_name,campaign_id,spend,impressions,reach,clicks,ctr,cpc,frequency,actions,action_values',
        time_range: timeRange,
        level: 'campaign',
        limit: '50'
      }),
      get('/' + accountId + '/adspixels', { fields: 'id,name,last_fired_time' }),
      get('/' + accountId + '/insights', {
        fields: 'ad_name,ad_id,spend,impressions,clicks,ctr,frequency,actions,action_values',
        time_range: timeRange,
        level: 'ad',
        limit: '50',
        sort: 'spend_descending'
      }).catch(() => ({ data: [] }))
    ]);

    res.json({
      account: accountRes.data?.[0] || {},
      campaigns: campaignsRes.data || [],
      pixels: pixelsRes.data || [],
      ads: adsRes.data || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
