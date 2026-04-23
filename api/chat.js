export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, context, clientName } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  const apiKey = process.env.ANTHROPIC_API_KEY;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: `אתה יחזקאל הנביא — מנתח פרסום ממומן של Ortal Digital. ענה בעברית בצורה תמציתית ומקצועית.\n\nנתוני הדוח:\n${context || 'אין נתוני דוח.'}`,
        messages: [{ role: 'user', content: message }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    res.json({ reply: d.content?.[0]?.text || 'שגיאה בתשובה' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
