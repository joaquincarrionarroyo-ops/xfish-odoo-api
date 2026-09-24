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

    // 1. Productos (Variantes) solicitando product_template_variant_value_ids
    const productPayload = { 
      jsonrpc: "2.0", 
      method: "call", 
      params: { 
        model: "product.product", 
        method: "search_read", 
        args: [[["sale_ok", "=", true]]], 
        kwargs: { 
          fields: [
            "display_name", 
            "default_code", 
            "lst_price", 
            "image_256", 
            "uom_id", 
            "categ_id", 
            "product_tmpl_id",
            "product_template_variant_value_ids"
          ] 
        } 
      } 
    };

    // 2. Plantillas para etiquetas comerciales
    const templatePayload = {
      jsonrpc: "2.0", 
      method: "call", 
      params: { 
        model: "product.template", 
        method: "search_read", 
        args: [[]], 
        kwargs: { fields: ["id", "name", "product_tag_ids"] } 
      }
    };

    // 3. Diccionario de etiquetas
    const tagPayload = {
      jsonrpc: "2.0", 
      method: "call", 
      params: { 
        model: "product.tag", 
        method: "search_read", 
        args: [[]], 
        kwargs: { fields: ["id", "name"] } 
      }
    };

    // 4. Stock físico
    const quantPayload = { 
      jsonrpc: "2.0", 
      method: "call", 
      params: { 
        model: "stock.quant", 
        method: "search_read", 
        args: [[["location_id.usage", "=", "internal"]]], 
        kwargs: { fields: ["product_id", "location_id", "lot_id", "quantity"] } 
      } 
    };

    // 5. External IDs de product.product
    const extIdPayload = { 
      jsonrpc: "2.0", 
      method: "call", 
      params: { 
        model: "ir.model.data", 
        method: "search_read", 
        args: [[["model", "=", "product.product"]]], 
        kwargs: { fields: ["res_id", "module", "name", "complete_name"] } 
      } 
    };

    // 6. Consultar valores de atributos (product.template.attribute.value)
    const variantValuesPayload = {
      jsonrpc: "2.0", 
      method: "call", 
      params: { 
        model: "product.template.attribute.value", 
        method: "search_read", 
        args: [[]], 
        kwargs: { fields: ["id", "display_name", "attribute_id", "name"] } 
      }
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

    // Mapear etiquetas
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

    // Mapear valores de atributos por su ID
    const attrValuesMap = {};
    varValuesRaw.forEach(v => {
        attrValuesMap[v.id] = {
            id: v.id,
            display_name: v.display_name, // Ej: "Tipo De Caña: Casting"
            name: v.name,                 // Ej: "Casting"
            attribute_name: v.attribute_id ? v.attribute_id[1] : "" // Ej: "Tipo De Caña"
        };
    });

    // Mapear External IDs exclusivos de product.product
    const extIdMap = {};
    extIds.forEach(ext => {
        const idCompleto = ext.complete_name || (ext.module && ext.name ? `${ext.module}.${ext.name}` : null);
        if (idCompleto) extIdMap[ext.res_id] = idCompleto;
    });

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

        let nombreCategoria = "General";
        if (p.categ_id && Array.isArray(p.categ_id)) {
            nombreCategoria = p.categ_id[1];
        }

        const tmplId = p.product_tmpl_id ? p.product_tmpl_id[0] : null;
        const nombreMatriz = tmplId && templateNamesMap[tmplId] ? templateNamesMap[tmplId] : p.display_name;
        const etiquetaComercial = tmplId ? (templateTagsMap[tmplId] || "Sin Etiqueta") : "Sin Etiqueta";

        // Estructurar atributos de la variante
        const atributosVariante = {};
        if (p.product_template_variant_value_ids && Array.isArray(p.product_template_variant_value_ids)) {
            p.product_template_variant_value_ids.forEach(vId => {
                const infoVal = attrValuesMap[vId];
                if (infoVal) {
                    const attrKey = infoVal.attribute_name ? infoVal.attribute_name.trim() : "";
                    if (attrKey) {
                        atributosVariante[attrKey] = infoVal.name ? infoVal.name.trim() : "";
                    }
                }
            });
        }

        const idExternoVariante = extIdMap[p.id] || `__export__.product_product_${p.id}`;

        return {
            id: p.id,
            tmpl_id: tmplId,
            nombre_matriz: nombreMatriz,
            id_externo: idExternoVariante,
            sku: p.default_code,
            nombre: p.display_name,
            precio: p.lst_price,
            foto: p.image_256,
            qxb: p.uom_id ? p.uom_id[1] : '1',
            categ_id: nombreCategoria,
            etiqueta: etiquetaComercial,
            atributos: atributosVariante,
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

// Endpoint exclusivo bajo demanda: busca image_1920 solo cuando vas a exportar la foto en alta calidad
app.get('/api/producto-foto-hd/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);
    if (!ODOO_API_KEY || isNaN(prodId)) {
        return res.status(400).json({ error: "Parámetros inválidos" });
    }

    const authPayload = {
      jsonrpc: "2.0", method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
    };

    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result && authRes.data.result.session_id) {
        sessionId = authRes.data.result.session_id;
    }

    const hdPayload = {
      jsonrpc: "2.0", method: "call",
      params: {
        model: "product.product",
        method: "read",
        args: [[prodId], ["image_1920"]]
      }
    };

    const hdRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, hdPayload, {
      headers: { 'Cookie': `session_id=${sessionId}` }
    });

    const result = hdRes.data.result;
    if (result && result.length > 0 && result[0].image_1920) {
      return res.json({ foto_hd: result[0].image_1920 });
    }

    res.status(404).json({ error: "No se encontró imagen HD" });
  } catch (error) {
    console.error("Error al traer imagen HD:", error.message);
    res.status(500).json({ error: "Error interno obteniendo HD" });
  }
});

// NUEVO ENDPOINT: HISTORIAL 360 DEL PRODUCTO
app.get('/api/producto-historial/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);

    if (!ODOO_API_KEY || isNaN(prodId)) {
        return res.status(400).json({ error: "Parámetros inválidos" });
    }

    // Autenticación
    const authPayload = {
      jsonrpc: "2.0", method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
    };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result && authRes.data.result.session_id) {
        sessionId = authRes.data.result.session_id;
    }

    // 1. Datos básicos e imagen
    const infoPayload = {
      jsonrpc: "2.0", method: "call",
      params: { model: "product.product", method: "read", args: [[prodId], ["display_name", "default_code", "image_256", "lst_price"]] }
    };

    // 2. Ventas (Confirmadas o Hechas)
    const salesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "sale.order.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "in", ["sale", "done"]]]],
        kwargs: { fields: ["order_id", "order_partner_id", "product_uom_qty", "price_unit", "create_date"], order: "create_date desc" }
      }
    };

    // 3. Compras (Confirmadas o Hechas) -> DE AQUÍ SACAMOS EL COSTO REAL
    const purchasesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "purchase.order.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "in", ["purchase", "done"]]]],
        kwargs: { fields: ["order_id", "partner_id", "product_qty", "price_unit", "create_date"], order: "create_date desc" }
      }
    };

    // 4. Movimientos de stock
    const movesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "stock.move.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "=", "done"]]],
        kwargs: { fields: ["reference", "location_id", "location_dest_id", "qty_done", "date"], order: "date desc", limit: 50 } // Limitamos a 50 movimientos para velocidad
      }
    };

    const [infoRes, salesRes, purchRes, movesRes] = await Promise.all([
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, infoPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, salesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, purchasesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, movesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const info = infoRes.data.result && infoRes.data.result[0] ? infoRes.data.result[0] : {};
    
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
        movimientos: movesRes.data.result || []
    });

  } catch (error) {
    console.error("Error trayendo historial:", error.message);
    res.status(500).json({ error: "Error interno obteniendo historial" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

// NUEVO ENDPOINT: HISTORIAL 360 DEL PRODUCTO
app.get('/api/producto-historial/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);

    if (!ODOO_API_KEY || isNaN(prodId)) {
        return res.status(400).json({ error: "Parámetros inválidos" });
    }

    // Autenticación
    const authPayload = {
      jsonrpc: "2.0", method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
    };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result && authRes.data.result.session_id) {
        sessionId = authRes.data.result.session_id;
    }

    // 1. Datos básicos e imagen
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

    // 3. Compras (Costo Real)
    const purchasesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "purchase.order.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "in", ["purchase", "done"]]]],
        kwargs: { fields: ["order_id", "partner_id", "product_qty", "price_unit", "create_date"], order: "create_date desc" }
      }
    };

    // 4. Movimientos de stock CON LOTE (ICO)
    const movesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "stock.move.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "=", "done"]]],
        kwargs: { 
            fields: ["reference", "location_id", "location_dest_id", "qty_done", "date", "lot_id"], 
            order: "date desc", 
            limit: 50 
        } 
      }
    };

    const [infoRes, salesRes, purchRes, movesRes] = await Promise.all([
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, infoPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, salesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, purchasesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, movesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const info = infoRes.data.result && infoRes.data.result[0] ? infoRes.data.result[0] : {};
    
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
        movimientos: movesRes.data.result || []
    });

  } catch (error) {
    console.error("Error trayendo historial:", error.message);
    res.status(500).json({ error: "Error interno obteniendo historial" });
  }
});

// NUEVO ENDPOINT: HISTORIAL 360 DEL PRODUCTO
app.get('/api/producto-historial/:id', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const prodId = parseInt(req.params.id);

    if (!ODOO_API_KEY || isNaN(prodId)) {
        return res.status(400).json({ error: "Parámetros inválidos" });
    }

    // Autenticación
    const authPayload = {
      jsonrpc: "2.0", method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
    };
    const authRes = await axios.post(`${ODOO_URL}/web/session/authenticate`, authPayload);
    let sessionId = null;
    const cookies = authRes.headers['set-cookie'];
    if (cookies) {
        const sessionCookie = cookies.find(c => c.startsWith('session_id='));
        if (sessionCookie) sessionId = sessionCookie.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result && authRes.data.result.session_id) {
        sessionId = authRes.data.result.session_id;
    }

    // 1. Datos básicos e imagen
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

    // 3. Compras (Costo Real)
    const purchasesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "purchase.order.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "in", ["purchase", "done"]]]],
        kwargs: { fields: ["order_id", "partner_id", "product_qty", "price_unit", "create_date"], order: "create_date desc" }
      }
    };

    // 4. Movimientos de stock (Traemos el picking_id para buscar el ICO después)
    const movesPayload = {
      jsonrpc: "2.0", method: "call",
      params: { 
        model: "stock.move.line", method: "search_read", 
        args: [[["product_id", "=", prodId], ["state", "=", "done"]]],
        kwargs: { 
            fields: ["reference", "location_id", "location_dest_id", "qty_done", "date", "picking_id"], 
            order: "date desc", 
            limit: 50 
        } 
      }
    };

    const [infoRes, salesRes, purchRes, movesRes] = await Promise.all([
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, infoPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, salesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, purchasesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } }),
      axios.post(`${ODOO_URL}/web/dataset/call_kw`, movesPayload, { headers: { 'Cookie': `session_id=${sessionId}` } })
    ]);

    const info = infoRes.data.result && infoRes.data.result[0] ? infoRes.data.result[0] : {};
    const movs = movesRes.data.result || [];

    // 5. BÚSQUEDA DEL CAMPO PERSONALIZADO "ICO" EN LA RECEPCIÓN (stock.picking)
    // Obtenemos los IDs únicos de las recepciones que afectaron a este producto
    const pickingIds = [...new Set(movs.filter(m => m.picking_id).map(m => m.picking_id[0]))];
    const pickingsMap = {};

    if (pickingIds.length > 0) {
        const pickingsPayload = {
            jsonrpc: "2.0", method: "call",
            params: {
                model: "stock.picking", method: "search_read",
                args: [[["id", "in", pickingIds]]],
                kwargs: { } // Leemos todos los campos para atrapar el custom 'ico' sin importar el nombre interno
            }
        };
        try {
            const pickRes = await axios.post(`${ODOO_URL}/web/dataset/call_kw`, pickingsPayload, { headers: { 'Cookie': `session_id=${sessionId}` } });
            const picks = pickRes.data.result || [];
            picks.forEach(p => {
                // Atrapamos el campo ico (puede ser ico, x_ico, x_studio_ico dependiendo de la DB)
                pickingsMap[p.id] = p.ico || p.x_ico || p.x_studio_ico || '-';
            });
        } catch (e) {
            console.log("Aviso: No se pudo leer la tabla stock.picking");
        }
    }

    // Le inyectamos a cada movimiento su ICO correspondiente
    movs.forEach(m => {
        if (m.picking_id && pickingsMap[m.picking_id[0]] && pickingsMap[m.picking_id[0]] !== false) {
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
        movimientos: movs
    });

  } catch (error) {
    console.error("Error trayendo historial:", error.message);
    res.status(500).json({ error: "Error interno obteniendo historial" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
