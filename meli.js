export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { q = "iphone", limit = 20 } = req.query;

  try {
    const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&condition=used&sort=date_desc&limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("ML error " + response.status);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
