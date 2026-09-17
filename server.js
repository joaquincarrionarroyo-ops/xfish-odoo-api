const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// 🛡️ CORS Configurado: Permite recibir la contraseña desde tu web
app.use(cors({
    origin: '*', // Opcional: Aquí puedes poner ['https://tusitio.com'] para más seguridad
    allowedHeaders: ['Content-Type', 'x-odoo-password'] // Permitimos el header personalizado
}));

app.use(express.json());

const { ODOO_URL, ODOO_DB, ODOO_USER } = process.env; 
// NOTA: Ya no leemos ODOO_API_KEY desde process.env

app.get('/api/productos', async (req, res) => {
  try {
    // 🔐 Leer la contraseña que envía el Frontend
    const ODOO_API_KEY = req.headers['x-odoo-password'];

    if (!ODOO_API_KEY) {
        return res.status(401).json({ error: "Acceso denegado: Falta la contraseña." });
    }

    const authPayload = {
      jsonrpc: "2.0", method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY } // Usamos la contraseña inyectada
    };

    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    if (authRes.data.error) return res.status(401).json({ error: "Credenciales rechazadas" });

    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result && authRes.data.result.session_id) {
        sessionId = authRes.data.result.session_id;
    }
    if (!sessionId) return res.status(401).json({ error: "Odoo no devolvió cookie de sesión." });

    const productPayload = { jsonrpc: "2.0", method: "call", params: { model: "product.product", method: "search_read", args: [[["sale_ok", "=", true]]], kwargs: { fields: ["display_name", "default_code", "lst_price", "image_128", "uom_id"] } } };
    const quantPayload = { jsonrpc: "2.0", method: "call", params: { model: "stock.quant", method: "search_read", args: [[["location_id.usage", "=", "internal"]]], kwargs: { fields: ["product_id", "location_id", "lot_id", "quantity"] } } };
    const extIdPayload = { jsonrpc: "2.0", method: "call", params: { model: "ir.model.data", method: "search_read", args: [[["model", "=", "product.product"]]], kwargs: { fields: ["res_id", "module", "name"] } } };

    const [prodRes, quantRes, extIdRes] = await Promise.all([
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, productPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, quantPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, extIdPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const productos = prodRes.data.result || [];
    const quants = quantRes.data.result || [];
    const extIds = extIdRes.data.result || [];

    const extIdMap = {};
    extIds.forEach(ext => { extIdMap[ext.res_id] = `${ext.module}.${ext.name}`; });

    const catalogo = productos.map(p => {
        const stockProduct = quants.filter(q => q.product_id && q.product_id[0] === p.id);
        let ubicaciones = {};
        let lotes = new Set();
        let total = 0;

        stockProduct.forEach(q => {
            if (q.quantity > 0) {
                let locName = q.location_id[1].split('/').pop().toUpperCase();
                ubicaciones[locName] = (ubicaciones[locName] || 0) + q.quantity;
                total += q.quantity;
                if (q.lot_id) lotes.add(q.lot_id[1]);
            }
        });

        return {
            id: p.id,
            id_externo: extIdMap[p.id] || `__export__.product_product_${p.id}`,
            sku: p.default_code,
            nombre: p.display_name,
            precio: p.lst_price,
            foto: p.image_128,
            qxb: p.uom_id ? p.uom_id[1] : '1',
            lotes: Array.from(lotes).join(', '),
            ubicaciones: ubicaciones,
            total: total
        };
    });

    res.json(catalogo);
  } catch (error) {
    console.error("Error conectando con Odoo:", error.message);
    res.status(500).json({ error: "Error interno" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
