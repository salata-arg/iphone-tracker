module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = req.query.q || "iphone usado";
  const limit = req.query.limit || 20;
  try {
    const r = await fetch("https://api.mercadolibre.com/sites/MLA/search?q=" + encodeURIComponent(q) + "&condition=used&sort=date_desc&limit=" + limit);
    const data = await r.json();
    res.status(200).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}