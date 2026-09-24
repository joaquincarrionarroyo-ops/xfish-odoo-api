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
            display_name: v.display_name,
            name: v.name,
            attribute_name: v.attribute_id ? v.attribute_id[1] : ""
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

// Endpoint directo al binario original de Odoo vía HTTP /web/image (resolución nativa image_1920)
app.get('/api/foto-directa-hd/:tmplId', async (req, res) => {
  try {
    const ODOO_API_KEY = req.headers['x-odoo-password'];
    const tmplId = parseInt(req.params.tmplId);

    if (!ODOO_API_KEY || isNaN(tmplId)) {
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
      const c = cookies.find(x => x.startsWith('session_id='));
      if (c) sessionId = c.split(';')[0].split('=')[1];
    }
    if (!sessionId && authRes.data.result) sessionId = authRes.data.result.session_id;

    const urlFoto = `${ODOO_URL}/web/image?model=product.template&id=${tmplId}&field=image_1920`;

    const imagenRes = await axios.get(urlFoto, {
      headers: { 'Cookie': `session_id=${sessionId}` },
      responseType: 'arraybuffer'
    });

    const base64Data = Buffer.from(imagenRes.data, 'binary').toString('base64');
    const contentType = imagenRes.headers['content-type'] || 'image/png';

    res.json({ foto_hd: `data:${contentType};base64,${base64Data}` });

  } catch (error) {
    console.error("Error trayendo binario HD de Odoo:", error.message);
    res.status(500).json({ error: "Error obteniendo imagen HD binaria" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
