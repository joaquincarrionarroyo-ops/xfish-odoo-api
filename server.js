const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

const dominiosPermitidos = [
  'https://presuya.com.ar',
  'https://www.presuya.com.ar',
  'http://localhost',
  'http://127.0.0.1'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || dominiosPermitidos.some(domain => origin.startsWith(domain))) {
            callback(null, true);
        } else {
            callback(new Error('Bloqueado por política de seguridad CORS'));
        }
    },
    allowedHeaders: ['Content-Type', 'x-odoo-password']
}));

app.use(express.json());

const { ODOO_URL, ODOO_DB, ODOO_USER } = process.env; 

app.get('/api/productos', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];

    if (!ODOO_API_KEY) {
        return res.status(401).json({ error: "Acceso denegado: Falta la credencial de Odoo." });
    }

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

    const productPayload = { 
      jsonrpc: "2.0", method: "call", 
      params: { 
        model: "product.product", method: "search_read", 
        args: [[["sale_ok", "=", true]]], 
        kwargs: { 
          fields: [
            "display_name", "default_code", "lst_price", "image_256", 
            "uom_id", "categ_id", "product_tmpl_id", "product_template_variant_value_ids"
          ] 
        } 
      } 
    };

    const templatePayload = {
      jsonrpc: "2.0", method: "call", 
      params: { model: "product.template", method: "search_read", args: [[]], kwargs: { fields: ["id", "name", "product_tag_ids"] } }
    };

    const tagPayload = {
      jsonrpc: "2.0", method: "call", 
      params: { model: "product.tag", method: "search_read", args: [[]], kwargs: { fields: ["id", "name"] } }
    };

    const quantPayload = { 
      jsonrpc: "2.0", method: "call", 
      params: { model: "stock.quant", method: "search_read", args: [[["location_id.usage", "=", "internal"]]], kwargs: { fields: ["product_id", "location_id", "lot_id", "quantity"] } } 
    };

    const extIdPayload = { 
      jsonrpc: "2.0", method: "call", 
      params: { model: "ir.model.data", method: "search_read", args: [[["model", "=", "product.product"]]], kwargs: { fields: ["res_id", "module", "name", "complete_name"] } } 
    };

    const variantValuesPayload = {
      jsonrpc: "2.0", method: "call", 
      params: { model: "product.template.attribute.value", method: "search_read", args: [[]], kwargs: { fields: ["id", "display_name", "attribute_id", "name"] } }
    };

    const [prodRes, tempRes, tagRes, quantRes, extIdRes, varValRes] = await Promise.all([
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, productPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, templatePayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, tagPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, quantPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, extIdPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
        axios.post(`${ODOO_URL}/web/dataset/call_kw`, variantValuesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const productos = prodRes.data.result || [];
    const templates = tempRes.data.result || [];
    const tagsRaw = tagRes.data.result || [];
    const quants = quantRes.data.result || [];
    const extIds = extIdRes.data.result || [];
    const varValuesRaw = varValRes.data.result || [];

    const tagsMap = {};
    tagsRaw.forEach(t => { tagsMap[t.id] = t.name; });

    const templateTagsMap = {};
    const templateNamesMap = {};
    templates.forEach(t => {
        templateNamesMap[t.id] = t.name;
        if (t.product_tag_ids && Array.isArray(t.product_tag_ids)) {
            const nombres = t.product_tag_ids.map(id => tagsMap[id]).filter(Boolean);
            templateTagsMap[t.id] = nombres.join(', ');
        }
    });

    const attrValuesMap = {};
    varValuesRaw.forEach(v => {
        attrValuesMap[v.id] = {
            id: v.id, display_name: v.display_name, name: v.name, attribute_name: v.attribute_id ? v.attribute_id[1] : ""
        };
    });

    const extIdMap = {};
    extIds.forEach(ext => {
        const idCompleto = ext.complete_name || (ext.module && ext.name ? `${ext.module}.${ext.name}` : null);
        if (idCompleto) extIdMap[ext.res_id] = idCompleto;
    });

    const catalogo = productos.map(p => {
        const stockProduct = quants.filter(q => q.product_id && q.product_id[0] === p.id);
        let ubicaciones = {};
        let total = 0;

        stockProduct.forEach(q => {
            if (q.quantity > 0) {
                let locName = q.location_id[1].split('/').pop().toUpperCase();
                ubicaciones[locName] = (ubicaciones[locName] || 0) + q.quantity;
                total += q.quantity;
            }
        });

        let nombreCategoria = "General";
        if (p.categ_id && Array.isArray(p.categ_id)) nombreCategoria = p.categ_id[1];

        const tmplId = p.product_tmpl_id ? p.product_tmpl_id[0] : null;
        const nombreMatriz = tmplId && templateNamesMap[tmplId] ? templateNamesMap[tmplId] : p.display_name;
        const etiquetaComercial = tmplId ? (templateTagsMap[tmplId] || "Sin Etiqueta") : "Sin Etiqueta";

        const atributosVariante = {};
        if (p.product_template_variant_value_ids && Array.isArray(p.product_template_variant_value_ids)) {
            p.product_template_variant_value_ids.forEach(vId => {
                const infoVal = attrValuesMap[vId];
                if (infoVal && infoVal.attribute_name) {
                    atributosVariante[infoVal.attribute_name.trim()] = infoVal.name ? infoVal.name.trim() : "";
                }
            });
        }

        return {
            id: p.id,
            tmpl_id: tmplId,
            nombre_matriz: nombreMatriz,
            id_externo: extIdMap[p.id] || `__export__.product_product_${p.id}`,
            sku: p.default_code,
            nombre: p.display_name,
            precio: p.lst_price,
            foto: p.image_256,
            qxb: p.uom_id ? p.uom_id[1] : '1',
            categ_id: nombreCategoria,
            etiqueta: etiquetaComercial,
            atributos: atributosVariante,
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

app.get('/api/producto-foto-hd/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);
    if (!ODOO_API_KEY || isNaN(prodId)) return res.status(400).json({ error: "Parámetros inválidos" });

    const authPayload = { jsonrpc: "2.0", method: "call", params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY } };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result) sessionId = authRes.data.result.session_id;

    const hdPayload = { jsonrpc: "2.0", method: "call", params: { model: "product.product", method: "read", args: [[prodId], ["image_1920", "product_tmpl_id"]] } };
    const hdRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, hdPayload, { headers: { 'Cookie': `session_id=${sessionId}` } });

    const resProd = hdRes.data.result;
    if (resProd && resProd.length > 0) {
      if (resProd[0].image_1920) return res.json({ foto_hd: resProd[0].image_1920 });
      const tmplId = resProd[0].product_tmpl_id ? resProd[0].product_tmpl_id[0] : null;
      if (tmplId) {
        const tmplPayload = { jsonrpc: "2.0", method: "call", params: { model: "product.template", method: "read", args: [[tmplId], ["image_1920"]] } };
        const tmplRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, tmplPayload, { headers: { 'Cookie': `session_id=${sessionId}` } });
        if (tmplRes.data.result && tmplRes.data.result[0].image_1920) return res.json({ foto_hd: tmplRes.data.result[0].image_1920 });
      }
    }
    res.status(404).json({ error: "No se encontró imagen HD" });
  } catch (error) {
    res.status(500).json({ error: "Error interno obteniendo HD" });
  }
});

// HISTORIAL 360 DEL PRODUCTO - RESCATANDO EL CAMPO PERSONALIZADO ICO DESDE LA RECEPCIÓN
app.get('/api/producto-historial/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);

    if (!ODOO_API_KEY || isNaN(prodId)) return res.status(400).json({ error: "Parámetros inválidos" });

    const authPayload = { jsonrpc: "2.0", method: "call", params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY } };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result) sessionId = authRes.data.result.session_id;

    // 1. Datos básicos
    const infoPayload = {
      jsonrpc: "2.0", method: "call",
      params: { model: "product.product", method: "read", args: [[prodId], ["display_name", "default_code", "image_256", "lst_price"]] }
    };

    // 2. Ventas
    const salesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "sale.order.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "in", ["sale", "done"]]]],
        kwargs: { fields: ["order_id", "order_partner_id", "product_uom_qty", "price_unit", "create_date"], order: "create_date desc" }
      }
    };

    // 3. Compras
    const purchasesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "purchase.order.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "in", ["purchase", "done"]]]],
        kwargs: { fields: ["order_id", "partner_id", "product_qty", "price_unit", "create_date"], order: "create_date desc" }
      }
    };

    // 4. Movimientos (Traemos el 'picking_id' que es la recepción/remito original)
    const movesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "stock.move.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "=", "done"]]],
        kwargs: { 
            fields: ["reference", "location_id", "location_dest_id", "qty_done", "date", "picking_id"], 
            order: "date desc", 
            limit: 100 // Aumentado a 100 para un tablero más grande
        } 
      }
    };

    const [infoRes, salesRes, purchRes, movesRes] = await Promise.all([
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, infoPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, salesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, purchasesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, movesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const movs = movesRes.data.result || [];
    const info = infoRes.data.result && infoRes.data.result[0] ? infoRes.data.result[0] : {};

    // 5. BÚSQUEDA DEL CAMPO "ICO" EN LA RECEPCIÓN ORIGINAL
    const pickingIds = [...new Set(movs.filter(m => m.picking_id).map(m => m.picking_id[0]))];
    const pickingsMap = {};
    const uniqueIcos = new Set(); // Para mostrar en el encabezado

    if (pickingIds.length > 0) {
        const pickingsPayload = {
            jsonrpc: "2.0", method: "call",
            params: {
                model: "stock.picking", method: "search_read",
                args: [[["id", "in", pickingIds]]],
                kwargs: { fields: ["id", "ico", "x_ico", "x_studio_ico"] } // Atrapamos el campo sin importar su nombre interno
            }
        };
        try {
            const pickRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, pickingsPayload, { headers: { 'Cookie': `session_id=${sessionId}` } });
            const picks = pickRes.data.result || [];
            picks.forEach(p => {
                const icoValue = p.ico || p.x_ico || p.x_studio_ico;
                if (icoValue) {
                    pickingsMap[p.id] = icoValue;
                    uniqueIcos.add(icoValue);
                }
            });
        } catch (e) {
            console.log("Aviso: No se pudo leer la tabla stock.picking");
        }
    }

    // Le inyectamos a cada movimiento su ICO si proviene de una recepción registrada
    movs.forEach(m => {
        if (m.picking_id && pickingsMap[m.picking_id[0]]) {
            m.ico = pickingsMap[m.picking_id[0]];
        } else {
            m.ico = '-';
        }
    });

    res.json({
        producto: {
            id: info.id,
            nombre: info.display_name,
            sku: info.default_code,
            foto: info.image_256,
            precio_lista: info.lst_price
        },
        ventas: salesRes.data.result || [],
        compras: purchRes.data.result || [],
        movimientos: movs,
        icos_registrados: Array.from(uniqueIcos) // Los ICOs puros
    });

  } catch (error) {
    console.error("Error trayendo historial:", error.message);
    res.status(500).json({ error: "Error interno obteniendo historial" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
