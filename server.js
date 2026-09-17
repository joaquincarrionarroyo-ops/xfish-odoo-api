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
      jsonrpc: "2.0", method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
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

    // 1. Pedir los datos base del producto
    const productPayload = {
      jsonrpc: "2.0", method: "call",
      params: {
        model: "product.product",
        method: "search_read",
        args: [[["sale_ok", "=", true]]],
        kwargs: {
           // NOTA: Usa 'uom_id' provisoriamente para Uxb. Si tienes un campo personalizado, cámbialo aquí.
           fields: ["display_name", "default_code", "lst_price", "image_128", "uom_id"]
        }
      }
    };

    // 2. Pedir las cantidades exactas por Ubicación y Lote (stock.quant)
    const quantPayload = {
      jsonrpc: "2.0", method: "call",
      params: {
        model: "stock.quant",
        method: "search_read",
        args: [[["location_id.usage", "=", "internal"]]], // Solo stock interno
        kwargs: { fields: ["product_id", "location_id", "lot_id", "quantity"] }
      }
    };

    // Ejecutar ambas consultas a la vez para que sea ultra rápido
    const [prodRes, quantRes] = await Promise.all([
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, productPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, quantPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const productos = prodRes.data.result || [];
    const quants = quantRes.data.result || [];

    // 3. Fusionar Inventario con Productos
    const catalogo = productos.map(p => {
        // Buscar dónde está guardado este producto
        const stockProduct = quants.filter(q => q.product_id && q.product_id[0] === p.id);
        
        let ubicaciones = {};
        let lotes = new Set();
        let total = 0;

        stockProduct.forEach(q => {
            if (q.quantity > 0) {
                // Odoo devuelve "WH/Stock/Barracas". Extraemos solo la última palabra y la pasamos a mayúsculas.
                let locName = q.location_id[1].split('/').pop().toUpperCase();
                ubicaciones[locName] = (ubicaciones[locName] || 0) + q.quantity;
                total += q.quantity;
                
                // Si tiene número de lote, lo guardamos
                if (q.lot_id) lotes.add(q.lot_id[1]);
            }
        });

        return {
            id: p.id,
            sku: p.default_code,
            nombre: p.display_name,
            precio: p.lst_price,
            foto: p.image_128,
            qxb: p.uom_id ? p.uom_id[1] : '1', // Unidades por bulto
            lotes: Array.from(lotes).join(', '), // Lotes combinados
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
