export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { platform, dateFrom, dateTo, credentials } = req.body;
  if (!platform || !dateFrom || !dateTo)
    return res.status(400).json({ error: 'Missing required params' });

  try {
    if (platform === 'woocommerce') {
      return res.json(await fetchWooCommerce(dateFrom, dateTo, credentials));
    } else if (platform === 'shopify') {
      return res.json(await fetchShopify(dateFrom, dateTo, credentials));
    } else {
      return res.status(400).json({ error: 'Unknown platform: ' + platform });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─── Shared analytics helpers ─────────────────────────────────────────────────

function calcOrderDistribution(orders, getTotal) {
  const buckets = { lt100: 0, b100_300: 0, b300_500: 0, gt500: 0 };
  orders.forEach(o => {
    const v = getTotal(o);
    if (v < 100) buckets.lt100++;
    else if (v < 300) buckets.b100_300++;
    else if (v < 500) buckets.b300_500++;
    else buckets.gt500++;
  });
  return buckets;
}

function calcWeekdayPattern(orders, getDate) {
  const days = [0, 0, 0, 0, 0, 0, 0]; // Sun=0 … Sat=6
  const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  orders.forEach(o => {
    const d = new Date(getDate(o));
    if (!isNaN(d)) days[d.getDay()]++;
  });
  return names.map((name, i) => ({ name, orders: days[i] }));
}

function calcAvgItems(orders, getItems) {
  if (!orders.length) return 0;
  const total = orders.reduce((s, o) => s + (getItems(o) || 0), 0);
  return total / orders.length;
}

// ─── WooCommerce ─────────────────────────────────────────────────────────────

async function fetchWooCommerce(dateFrom, dateTo, creds) {
  const baseUrl = (creds?.storeUrl || process.env.WC_STORE_URL || '').replace(/\/$/, '');
  const key = creds?.consumerKey || process.env.WC_CONSUMER_KEY || '';
  const secret = creds?.consumerSecret || process.env.WC_CONSUMER_SECRET || '';
  if (!baseUrl || !key || !secret) throw new Error('חסרים פרטי גישה ל-WooCommerce (Store URL, Consumer Key, Consumer Secret)');
  const auth = 'Basic ' + Buffer.from(key + ':' + secret).toString('base64');

  const wcGet = async (path, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    const url = `${baseUrl}/wp-json/wc/v3/${path}?${qs}`;
    const r = await fetch(url, { headers: { Authorization: auth } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || JSON.stringify(d));
    return d;
  };

  // ── Fetch ALL orders (paginate until empty, max 2000) ──────────────────────
  const allOrders = [];
  const PER_PAGE = 100;
  for (let page = 1; page <= 20; page++) {
    // Page 1: let errors throw (credentials/URL wrong → visible error)
    // Page 2+: silently stop (WooCommerce returns [] for pages beyond last)
    const batch = await wcGet('orders', {
      after: dateFrom + 'T00:00:00',
      before: dateTo + 'T23:59:59',
      per_page: PER_PAGE,
      page,
      status: 'any',
      _fields: 'id,date_created,total,line_items,status,customer_id,discount_total'
    }).catch(e => { if (page === 1) throw e; return []; });
    const rows = Array.isArray(batch) ? batch : [];
    allOrders.push(...rows);
    if (rows.length < PER_PAGE) break;
  }

  const validStatuses = new Set(['completed', 'processing']);
  const orders = allOrders.filter(o => validStatuses.has(o.status));

  // ── Core aggregation ───────────────────────────────────────────────────────
  const byMonth = {};
  const byProduct = {};
  let totalRevenue = 0;
  let totalDiscounts = 0;
  const customerFreq = {};

  orders.forEach(o => {
    const month = (o.date_created || '').slice(0, 7);
    const total = parseFloat(o.total || 0);
    totalRevenue += total;
    totalDiscounts += parseFloat(o.discount_total || 0);

    if (month) {
      if (!byMonth[month]) byMonth[month] = { revenue: 0, orders: 0 };
      byMonth[month].revenue += total;
      byMonth[month].orders += 1;
    }

    const cid = o.customer_id || 0;
    customerFreq[cid] = (customerFreq[cid] || 0) + 1;

    (o.line_items || []).forEach(item => {
      const pid = String(item.product_id || item.name);
      if (!byProduct[pid]) byProduct[pid] = { name: item.name, quantity: 0, revenue: 0 };
      byProduct[pid].quantity += parseInt(item.quantity || 0);
      byProduct[pid].revenue += parseFloat(item.total || 0);
    });
  });

  const orderCount = orders.length;
  const totals = {
    revenue: totalRevenue,
    netRevenue: totalRevenue,
    orders: orderCount,
    refunds: 0,
    aov: orderCount > 0 ? totalRevenue / orderCount : 0,
    avgItems: calcAvgItems(orders, o => (o.line_items || []).length),
    totalDiscounts
  };

  // Optional enrichment from reports/sales
  const salesReport = await wcGet('reports/sales', { date_min: dateFrom, date_max: dateTo }).catch(() => null);
  if (salesReport) {
    totals.netRevenue = parseFloat(salesReport.net_sales || totalRevenue);
    totals.refunds = parseFloat(salesReport.total_refunds || 0);
    if (orderCount >= 2000 && salesReport.total_orders) totals.orders = parseInt(salesReport.total_orders);
  }

  // ── Advanced enrichment (parallel, all optional) ──────────────────────────
  const [categoriesRaw, couponsRaw, topCustomersRaw] = await Promise.all([
    wcGet('reports/categories', { date_min: dateFrom, date_max: dateTo, per_page: 15 }).catch(() => null),
    wcGet('coupons', { per_page: 20, orderby: 'usage_count', order: 'desc' }).catch(() => null),
    wcGet('customers', { per_page: 10, orderby: 'total_spent', order: 'desc' }).catch(() => null)
  ]);

  // Categories — fallback: compute from line_items categories if API fails
  let categories = null;
  if (Array.isArray(categoriesRaw) && categoriesRaw.length) {
    categories = categoriesRaw.map(c => ({
      name: c.category,
      orders: c.orders_count || 0,
      items: c.items_sold || 0,
      revenue: parseFloat(c.net_revenue || 0)
    })).sort((a, b) => b.revenue - a.revenue);
  }

  // Coupons
  const coupons = Array.isArray(couponsRaw)
    ? couponsRaw.filter(c => c.usage_count > 0).slice(0, 10).map(c => ({
        code: c.code,
        type: c.discount_type,
        amount: parseFloat(c.amount || 0),
        usageCount: c.usage_count || 0,
        avgDiscount: c.usage_count > 0 ? totalDiscounts / orderCount : 0
      }))
    : null;

  // Top customers
  const topCustomers = Array.isArray(topCustomersRaw)
    ? topCustomersRaw.map(c => ({
        name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'אורח',
        email: c.email || '',
        orders: c.orders_count || 0,
        totalSpent: parseFloat(c.total_spent || 0),
        aov: c.orders_count > 0 ? parseFloat(c.total_spent || 0) / c.orders_count : 0
      }))
    : null;

  // Customer segments (from fetched orders)
  const guestOrders = customerFreq[0] || 0;
  const registeredIds = Object.keys(customerFreq).filter(k => k !== '0');
  const newCustomers = registeredIds.filter(k => customerFreq[k] === 1).length;
  const returningCustomers = registeredIds.filter(k => customerFreq[k] > 1).length;
  const customerSegments = { guests: guestOrders, newCustomers, returningCustomers };

  const monthly = Object.entries(byMonth)
    .map(([month, d]) => ({ month, revenue: d.revenue, orders: d.orders, aov: d.orders > 0 ? d.revenue / d.orders : 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const topProducts = Object.values(byProduct)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15)
    .map(p => ({ ...p, revenuePerUnit: p.quantity > 0 ? p.revenue / p.quantity : 0 }));

  const orderDistribution = calcOrderDistribution(orders, o => parseFloat(o.total || 0));
  const weekdayPattern = calcWeekdayPattern(orders, o => o.date_created);

  return {
    platform: 'woocommerce',
    summary: totals,
    monthly,
    topProducts,
    categories,
    coupons,
    topCustomers,
    customerSegments,
    orderDistribution,
    weekdayPattern
  };
}

// ─── Shopify ──────────────────────────────────────────────────────────────────

async function fetchShopify(dateFrom, dateTo, creds) {
  const domain = (creds?.storeDomain || process.env.SHOPIFY_STORE_DOMAIN || '').replace(/\/$/, '').replace(/^https?:\/\//, '');
  const token = creds?.accessToken || process.env.SHOPIFY_ACCESS_TOKEN || '';
  if (!domain || !token) throw new Error('חסרים פרטי גישה ל-Shopify (Store Domain, Access Token)');

  const shopifyGet = async (path, params = {}) => {
    const url = `https://${domain}/admin/api/2024-01/${path}.json?` + new URLSearchParams(params);
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.errors || JSON.stringify(d));
    return d;
  };

  // Paginate Shopify orders (limit 250 per call, use since_id cursor)
  const allOrders = [];
  let sinceId = null;
  for (let i = 0; i < 20; i++) {
    const params = {
      created_at_min: dateFrom + 'T00:00:00+00:00',
      created_at_max: dateTo + 'T23:59:59+00:00',
      status: 'any',
      limit: '250',
      fields: 'id,total_price,created_at,financial_status,line_items,customer,discount_codes'
    };
    if (sinceId) params.since_id = sinceId;
    const d = await shopifyGet('orders', params).catch(() => ({ orders: [] }));
    const batch = d.orders || [];
    allOrders.push(...batch);
    if (batch.length < 250) break;
    sinceId = batch[batch.length - 1].id;
  }

  const orders = allOrders.filter(o => o.financial_status === 'paid');

  const byMonth = {};
  const byProduct = {};
  const byCategory = {};
  let revenue = 0;
  let totalDiscounts = 0;
  const customerFreq = {};

  orders.forEach(o => {
    const total = parseFloat(o.total_price || 0);
    revenue += total;

    // discount codes total (approximate per order)
    if (o.discount_codes?.length) totalDiscounts += o.discount_codes.reduce((s, d) => s + parseFloat(d.amount || 0), 0);

    const month = (o.created_at || '').slice(0, 7);
    if (month) {
      if (!byMonth[month]) byMonth[month] = { revenue: 0, orders: 0 };
      byMonth[month].revenue += total;
      byMonth[month].orders += 1;
    }

    const cid = o.customer?.id || 0;
    customerFreq[cid] = (customerFreq[cid] || 0) + 1;

    (o.line_items || []).forEach(item => {
      const key = item.product_id || item.title;
      if (!byProduct[key]) byProduct[key] = { name: item.title, quantity: 0, revenue: 0 };
      byProduct[key].quantity += parseInt(item.quantity || 0);
      byProduct[key].revenue += parseFloat(item.price || 0) * parseInt(item.quantity || 0);

      // Category from product_type
      const cat = item.product_type || 'ללא קטגוריה';
      if (!byCategory[cat]) byCategory[cat] = { name: cat, orders: 0, items: 0, revenue: 0 };
      byCategory[cat].orders += 1;
      byCategory[cat].items += parseInt(item.quantity || 0);
      byCategory[cat].revenue += parseFloat(item.price || 0) * parseInt(item.quantity || 0);
    });
  });

  const orderCount = orders.length;
  const summary = {
    revenue,
    netRevenue: revenue,
    orders: orderCount,
    refunds: 0,
    aov: orderCount > 0 ? revenue / orderCount : 0,
    avgItems: calcAvgItems(orders, o => (o.line_items || []).length),
    totalDiscounts
  };

  const guestOrders = customerFreq[0] || 0;
  const registeredIds = Object.keys(customerFreq).filter(k => k !== '0');
  const customerSegments = {
    guests: guestOrders,
    newCustomers: registeredIds.filter(k => customerFreq[k] === 1).length,
    returningCustomers: registeredIds.filter(k => customerFreq[k] > 1).length
  };

  const categories = Object.values(byCategory)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const monthly = Object.entries(byMonth)
    .map(([month, d]) => ({ month, revenue: d.revenue, orders: d.orders, aov: d.orders > 0 ? d.revenue / d.orders : 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const topProducts = Object.values(byProduct)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15)
    .map(p => ({ ...p, revenuePerUnit: p.quantity > 0 ? p.revenue / p.quantity : 0 }));

  const orderDistribution = calcOrderDistribution(orders, o => parseFloat(o.total_price || 0));
  const weekdayPattern = calcWeekdayPattern(orders, o => o.created_at);

  return {
    platform: 'shopify',
    summary,
    monthly,
    topProducts,
    categories: categories.length ? categories : null,
    coupons: null,
    topCustomers: null,
    customerSegments,
    orderDistribution,
    weekdayPattern
  };
}
