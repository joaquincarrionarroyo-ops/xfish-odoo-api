const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY } = process.env;

app.get('/api/productos', async (req, res) => {
  try {
    const authPayload = {
      jsonrpc: "2.0",
      method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
    };

    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    
    // 👇 ESTO ES LO NUEVO: CAPTURAR EL ERROR EXACTO DE ODOO 👇
    if (authRes.data.error) {
        console.error("⛔ ODOO RECHAZÓ EL ACCESO. Motivo:", JSON.stringify(authRes.data.error, null, 2));
        return res.status(401).json({ error: "Credenciales rechazadas por Odoo. Revisa Render." });
    }

    if (!authRes.data.result || !authRes.data.result.session_id) {
        console.error("⛔ RESPUESTA RARA DE ODOO:", JSON.stringify(authRes.data, null, 2));
        return res.status(401).json({ error: "Odoo no devolvió sesión." });
    }
    // 👆 HASTA ACÁ 👆

    const sessionId = authRes.data.result.session_id;

    const searchPayload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        model: "product.template",
        method: "search_read",
        args: [[["sale_ok", "=", true]]],
        kwargs: {
           fields: ["name", "default_code", "list_price", "qty_available"],
           limit: 50
        }
      }
    };

    const searchRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, searchPayload, {
        headers: { 'Cookie': `session_id=${sessionId}` }
    });

    res.json(searchRes.data.result);

  } catch (error) {
    console.error("Error conectando con Odoo:", error.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor puente corriendo en el puerto ${PORT}`);
});
