const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Permite que tu frontend consulte esta API sin errores de CORS
app.use(cors());
app.use(express.json());

// Variables ocultas que vas a configurar en el panel de Render
const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY } = process.env;

app.get('/api/productos', async (req, res) => {
  try {
    // 1. Iniciar sesión en Odoo
    const authPayload = {
      jsonrpc: "2.0",
      method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
    };

    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    const sessionId = authRes.data.result.session_id;

    if (!sessionId) {
      return res.status(401).json({ error: "No se pudo iniciar sesión en Odoo" });
    }

    // 2. Extraer los productos del catálogo
    const searchPayload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        model: "product.template",
        method: "search_read",
        args: [
          [["sale_ok", "=", true]] // Trae solo lo que se puede vender
        ],
        kwargs: {
           // Columnas: Nombre, SKU, Precio, Stock a mano
           fields: ["name", "default_code", "list_price", "qty_available"],
           limit: 50 // Trae los primeros 50
        }
      }
    };

    const searchRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, searchPayload, {
        headers: { 'Cookie': `session_id=${sessionId}` }
    });

    // 3. Enviar los datos al frontend
    res.json(searchRes.data.result);

  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor puente corriendo en el puerto ${PORT}`);
});
